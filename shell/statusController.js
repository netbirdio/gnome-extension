// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {NetBirdClient} from '../netbird/client.js';
import {DaemonController} from '../netbird/controller.js';

// How long before an SSO session expires to warn about it.
export const SESSION_WARNING_LEAD_SECONDS = 5 * 60;

export class StatusController extends DaemonController {
    constructor({
        beforeConnect,
        client = new NetBirdClient(),
        launchUri = uri => Gio.AppInfo.launch_default_for_uri(uri, null),
        onActionError,
        onSessionExpired = () => {},
        onSessionWarning = () => {},
        onStateChanged,
    }) {
        super({beforeConnect, client, onActionError, onStateChanged});
        this._extending = false;
        this._launchUri = launchUri;
        this._onSessionExpired = onSessionExpired;
        this._onSessionWarning = onSessionWarning;
        this._sessionWarningDeadline = 0;
        this._sessionWarningSourceId = 0;
        this._sessionWasRunning = false;

        this._emitChanged();
        this._subscribe();
        void this.refresh();
    }

    destroy() {
        this._clearSessionWarning();
        super.destroy();
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

    // Quick Settings only shows profiles; the status stream sets the state.
    async _refresh() {
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

    // Returns false when the action belongs in the NetBird window instead
    // (setup, an update, or signing in).
    async toggleConnection() {
        if (this._client.cancelled || this._busy)
            return true;

        this._setBusy(true);
        try {
            if (this._snapshot.connected || this._snapshot.state === 'Connecting') {
                this._sessionWasRunning = false;
                await this._client.disconnect();
            } else if (this._isOffline() || this._needsLogin()) {
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

    _profileSwitchStarted() {
        this._sessionWasRunning = false;
    }

    _statusChanged(snapshot, previous) {
        this._syncSessionWarning();
        this._trackSessionExpiry(snapshot.state);
        super._statusChanged(snapshot, previous);
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
}
