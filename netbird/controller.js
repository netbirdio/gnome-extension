// SPDX-License-Identifier: GPL-3.0-or-later

// State shared by the Quick Settings and preferences controllers. Both run the
// same status stream, reconnect policy, and profile switching against their own
// NetBirdClient; only what they refresh and how they sign in differs.

import GLib from 'gi://GLib';

import {NetBirdVersionError} from './client.js';

const RECONNECT_DELAYS_SECONDS = [1, 2, 5, 10, 30];
export const LOGIN_STATES = ['NeedsLogin', 'LoginFailed', 'SessionExpired'];
// States in which the daemon cannot take commands.
export const OFFLINE_STATES = ['Unavailable', 'UpdateRequired'];

const STATUS_LABELS = {
    Connected: 'Connected',
    Connecting: 'Connecting…',
    Idle: 'Disconnected',
    LoginFailed: 'Sign-in failed',
    NeedsLogin: 'Sign in required',
    SessionExpired: 'Session expired',
    Unavailable: 'Finish setup',
    UpdateRequired: 'Update NetBird',
};

export function statusLabel(state) {
    return STATUS_LABELS[state] ?? state;
}

export function offlineSnapshot(state = 'Unavailable', previous = null, daemonVersion) {
    return {
        connected: false,
        daemonVersion: daemonVersion ?? previous?.daemonVersion ?? '',
        localPeer: previous?.localPeer ?? {fqdn: '', ipv4: '', ipv6: ''},
        networksRevision: previous?.networksRevision ?? 0,
        peers: previous?.peers ?? [],
        sessionExpiresAt: previous?.sessionExpiresAt ?? 0,
        state,
    };
}

export class DaemonController {
    constructor({
        beforeConnect = async () => {},
        client,
        onActionError = () => {},
        onStateChanged,
    }) {
        this._beforeConnect = beforeConnect;
        this._busy = false;
        this._client = client;
        this._onActionError = onActionError;
        this._onStateChanged = onStateChanged;
        this._profileName = '';
        this._profiles = [];
        this._reconnectAttempt = 0;
        this._reconnectSourceId = 0;
        this._refreshPromise = null;
        this._snapshot = offlineSnapshot();
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
        this._client.destroy();
    }

    refresh() {
        if (this._client.cancelled)
            return Promise.resolve();

        // Callers that need fresh data (such as connect) share one request.
        this._refreshPromise ??= this._refresh().finally(() => {
            this._refreshPromise = null;
        });
        return this._refreshPromise;
    }

    async selectProfile(profileId) {
        const profile = this._profiles.find(item => item.id === profileId);
        if (!profile || profile.isActive || this._busy ||
            this._client.cancelled || this._isOffline())
            return;

        this._setBusy(true);
        const reconnect = this._snapshot.connected || this._snapshot.state === 'Connecting';
        const previousProfileId = this._activeProfileId();
        let switched = false;
        this._profileSwitchStarted();
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
            await this.refresh();
        } catch (error) {
            if (this._client.cancelled)
                return;
            this._onActionError('Profile Could Not Be Switched', profileError(error, profile));
            // A failed switch must not leave the previous profile disconnected.
            if (reconnect && !switched)
                await this._client.connect(previousProfileId).catch(() => {});
            await this.refresh();
        } finally {
            this._setBusy(false);
        }
    }

    // Subclasses fetch what they show and publish it with _emitChanged().
    _refresh() {
        return Promise.resolve();
    }

    _profileSwitchStarted() {}

    // Profile switches from another window or the CLI pass through a state
    // change; refresh so the lists follow them.
    _statusChanged(snapshot, previous) {
        if (snapshot.state !== previous.state)
            void this.refresh();
    }

    _subscribe() {
        if (this._client.cancelled)
            return;

        this._client.subscribeStatus(
            snapshot => {
                if (this._client.cancelled)
                    return;

                const previous = this._snapshot;
                this._snapshot = snapshot;
                this._reconnectAttempt = 0;
                this._emitChanged();
                this._statusChanged(snapshot, previous);
            },
            error => {
                if (this._client.cancelled)
                    return;

                this._setOffline(error);
                this._scheduleReconnect();
            });
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

    // A daemon that is too old answers, so it must not be mistaken for a
    // missing socket: the fix is an update, not enabling the socket.
    _setOffline(error) {
        const outdated = error instanceof NetBirdVersionError;
        const state = outdated ? 'UpdateRequired' : 'Unavailable';
        const daemonVersion = outdated ? error.version : undefined;
        if (this._snapshot.state === state &&
            (!outdated || this._snapshot.daemonVersion === daemonVersion))
            return;

        this._snapshot = offlineSnapshot(state, this._snapshot, daemonVersion);
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

    _isOffline() {
        return OFFLINE_STATES.includes(this._snapshot.state);
    }

    _needsLogin() {
        return LOGIN_STATES.includes(this._snapshot.state);
    }

    _activeProfileId() {
        return this._profiles.find(profile => profile.isActive)?.id ?? '';
    }

    async _currentProfileId() {
        // Another window or the CLI may have switched profiles since the last refresh.
        await this.refresh();
        return this._activeProfileId();
    }
}

function profileError(error, profile) {
    // The daemon reports profiles by internal ID; show the name people chose.
    const message = String(error?.message ?? error).replaceAll(profile.id, profile.name);
    return new Error(message, {cause: error});
}
