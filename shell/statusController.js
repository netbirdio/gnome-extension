// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {NetBirdClient} from '../netbird/client.js';

const RECONNECT_DELAYS_SECONDS = [1, 2, 5, 10, 30];
// How long before an SSO session expires to warn about it.
export const SESSION_WARNING_LEAD_SECONDS = 5 * 60;

export class StatusController {
    constructor({
        beforeConnect = async () => {},
        client = new NetBirdClient(),
        launchUri = uri => Gio.AppInfo.launch_default_for_uri(uri, null),
        onActionError,
        onSessionExpired = () => {},
        onSessionWarning = () => {},
        onStateChanged,
    }) {
        this._beforeConnect = beforeConnect;
        this._client = client;
        this._extending = false;
        this._launchUri = launchUri;
        this._onActionError = onActionError;
        this._onSessionExpired = onSessionExpired;
        this._onSessionWarning = onSessionWarning;
        this._onStateChanged = onStateChanged;
        this._sessionWarningDeadline = 0;
        this._sessionWarningSourceId = 0;
        this._sessionWasRunning = false;
        this._profiles = [];
        this._profileName = '';
        this._reconnectAttempt = 0;
        this._reconnectSourceId = 0;
        this._refreshPromise = null;
        this._snapshot = {
            connected: false,
            daemonVersion: '',
            localPeer: {fqdn: '', ipv4: '', ipv6: ''},
            networksRevision: 0,
            peers: [],
            sessionExpiresAt: 0,
            state: 'Unavailable',
        };
        this._busy = false;

        this._emitChanged();
        this._subscribe();
        void this.refreshLists();
    }

    get state() {
        return {
            busy: this._busy,
            profileName: this._profileName,
            profiles: this._profiles,
            snapshot: this._snapshot,
        };
    }

    destroy() {
        if (this._reconnectSourceId) {
            GLib.Source.remove(this._reconnectSourceId);
            this._reconnectSourceId = 0;
        }
        this._clearSessionWarning();
        this._client.destroy();
    }

    // Renews the SSO session in the browser; the tunnel stays up meanwhile.
    async extendSession() {
        if (this._client.cancelled || this._extending)
            return 0;

        this._extending = true;
        try {
            const flow = await this._client.requestExtendSession();
            const uri = flow.verificationUriComplete || flow.verificationUri;
            if (!/^https:\/\//.test(uri))
                throw new Error('NetBird returned an invalid sign-in address');
            this._launchUri(uri);
            return await this._client.waitExtendSession(flow.deviceCode, flow.userCode);
        } finally {
            this._extending = false;
        }
    }

    refreshLists() {
        if (this._client.cancelled)
            return Promise.resolve();

        // Callers that need fresh data (such as connect) share one request.
        this._refreshPromise ??= this._refreshLists().finally(() => {
            this._refreshPromise = null;
        });
        return this._refreshPromise;
    }

    async _refreshLists() {
        try {
            const [profiles, features] = await Promise.all([
                this._client.profiles(),
                this._client.features(),
            ]);
            if (this._client.cancelled)
                return;

            this._profiles = features.disableProfiles ? [] : profiles.profiles;
            this._profileName = features.disableProfiles
                ? ''
                : profiles.activeProfile;
            this._emitChanged();
        } catch {
            // List requests do not determine the connection state; the status stream does.
        }
    }

    async toggleConnection() {
        if (this._client.cancelled || this._busy)
            return true;

        this._setBusy(true);
        try {
            if (this._snapshot.connected || this._snapshot.state === 'Connecting') {
                this._sessionWasRunning = false;
                await this._client.disconnect();
            } else if (this._snapshot.state === 'Unavailable' || this._needsLogin()) {
                return false;
            } else {
                await this._beforeConnect();
                if (!this._client.cancelled)
                    await this._client.connect(await this._currentProfileId());
            }
            return true;
        } catch (error) {
            if (!this._client.cancelled)
                this._onActionError('Connection Could Not Be Changed', error);
            return true;
        } finally {
            this._setBusy(false);
        }
    }

    async selectProfile(profileId) {
        const profile = this._profiles.find(item => item.id === profileId);
        if (!profile || profile.isActive || this._busy ||
            this._client.cancelled || this._snapshot.state === 'Unavailable')
            return;

        this._setBusy(true);
        const reconnect = this._snapshot.connected || this._snapshot.state === 'Connecting';
        const previousProfileId = this._activeProfileId();
        let switched = false;
        this._sessionWasRunning = false;
        try {
            if (reconnect)
                await this._client.disconnect();
            await this._client.switchProfile(profileId);
            switched = true;
            if (reconnect) {
                await this._beforeConnect();
                if (!this._client.cancelled)
                    await this._client.connect(profileId);
            }
            await this.refreshLists();
        } catch (error) {
            if (this._client.cancelled)
                return;
            this._onActionError('Profile Could Not Be Switched',
                profileError(error, profile));
            // A failed switch must not leave the previous profile disconnected.
            if (reconnect && !switched)
                await this._client.connect(previousProfileId).catch(() => {});
            await this.refreshLists();
        } finally {
            this._setBusy(false);
        }
    }

    _subscribe() {
        if (this._client.cancelled)
            return;

        this._client.subscribeStatus(
            snapshot => {
                if (this._client.cancelled)
                    return;

                // Profile switches from the window or the CLI pass through a
                // state change; refresh so the menu follows them.
                const stateChanged = snapshot.state !== this._snapshot.state;
                this._snapshot = snapshot;
                this._reconnectAttempt = 0;
                this._emitChanged();
                this._syncSessionWarning();
                this._trackSessionExpiry(snapshot.state);
                if (stateChanged)
                    void this.refreshLists();
            },
            () => {
                if (this._client.cancelled)
                    return;

                this._setUnavailable();
                this._scheduleReconnect();
            });
    }

    // Only a session that ends while NetBird runs is news. The daemon passes
    // through Idle on the way, so remember that it ran instead of comparing
    // with the previous state. One already expired at login stays in the menu.
    _trackSessionExpiry(state) {
        if (state === 'Connected') {
            this._sessionWasRunning = true;
        } else if (state === 'SessionExpired' && this._sessionWasRunning) {
            this._sessionWasRunning = false;
            this._onSessionExpired();
        } else if (state === 'Unavailable') {
            this._sessionWasRunning = false;
        }
    }

    _syncSessionWarning() {
        const {connected, sessionExpiresAt} = this._snapshot;
        const deadline = connected ? sessionExpiresAt : 0;
        if (deadline === this._sessionWarningDeadline)
            return;

        this._clearSessionWarning();
        this._sessionWarningDeadline = deadline;
        const secondsLeft = deadline - Math.floor(Date.now() / 1000);
        if (!deadline || secondsLeft <= 0)
            return;

        const delay = secondsLeft - SESSION_WARNING_LEAD_SECONDS;
        if (delay <= 0) {
            this._onSessionWarning(deadline);
            return;
        }
        this._sessionWarningSourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, delay, () => {
                this._sessionWarningSourceId = 0;
                this._onSessionWarning(deadline);
                return GLib.SOURCE_REMOVE;
            });
    }

    _clearSessionWarning() {
        if (this._sessionWarningSourceId)
            GLib.Source.remove(this._sessionWarningSourceId);
        this._sessionWarningSourceId = 0;
    }

    _scheduleReconnect() {
        if (this._reconnectSourceId || this._client.cancelled)
            return;

        const delay = RECONNECT_DELAYS_SECONDS[
            Math.min(this._reconnectAttempt, RECONNECT_DELAYS_SECONDS.length - 1)];
        this._reconnectAttempt++;
        this._reconnectSourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            delay,
            () => {
                this._reconnectSourceId = 0;
                this._subscribe();
                return GLib.SOURCE_REMOVE;
            });
    }

    _setUnavailable() {
        if (this._snapshot.state === 'Unavailable')
            return;

        this._snapshot = {
            ...this._snapshot,
            connected: false,
            state: 'Unavailable',
        };
        this._emitChanged();
    }

    _setBusy(busy) {
        this._busy = busy;
        this._emitChanged();
    }

    _emitChanged() {
        if (!this._client.cancelled)
            this._onStateChanged(this.state);
    }

    _activeProfileId() {
        return this._profiles.find(profile => profile.isActive)?.id ?? '';
    }

    async _currentProfileId() {
        // Another window or the CLI may have switched profiles since the last refresh.
        await this.refreshLists();
        return this._activeProfileId();
    }

    _needsLogin() {
        return ['NeedsLogin', 'LoginFailed', 'SessionExpired']
            .includes(this._snapshot.state);
    }
}

function profileError(error, profile) {
    // The daemon reports profiles by internal ID; show the name people chose.
    const message = String(error?.message ?? error).replaceAll(profile.id, profile.name);
    return new Error(message, {cause: error});
}
