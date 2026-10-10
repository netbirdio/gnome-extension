// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {NetBirdClient} from '../netbird/client.js';

const RECONNECT_DELAYS_SECONDS = [1, 2, 5, 10, 30];
const LOGIN_STATES = ['NeedsLogin', 'LoginFailed', 'SessionExpired'];

export class MainController {
    constructor({
        client = new NetBirdClient(),
        launchUri = uri => Gio.AppInfo.launch_default_for_uri(uri, null),
        onError,
        onStateChanged,
    }) {
        this._busy = false;
        this._client = client;
        this._launchUri = launchUri;
        this._features = {};
        this._networks = [];
        this._onError = onError;
        this._onStateChanged = onStateChanged;
        this._profileName = '';
        this._profiles = [];
        this._reconnectAttempt = 0;
        this._reconnectSourceId = 0;
        this._refreshPromise = null;
        this._snapshot = unavailableSnapshot();

        this._subscribe();
        void this.refresh();
    }

    get state() {
        return {
            busy: this._busy,
            features: this._features,
            networks: this._networks,
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

    async _refresh() {
        try {
            const [status, profiles, networks, features] = await Promise.all([
                this._client.status(),
                this._client.profiles(),
                // The daemon only lists networks while connected ("not connected"
                // otherwise); that must not mark the whole daemon unavailable.
                this._client.networks().catch(() => ({networks: []})),
                this._client.features(),
            ]);
            if (this._client.cancelled)
                return;

            this._snapshot = status.snapshot;
            this._profileName = profiles.activeProfile;
            this._profiles = profiles.profiles;
            this._networks = networks.networks;
            this._features = features;
            this._emitChanged();
        } catch {
            if (!this._client.cancelled)
                this._setUnavailable();
        }
    }

    async toggleConnection() {
        if (this._client.cancelled || this._busy)
            return;

        this._setBusy(true);
        try {
            if (this._snapshot.connected || this._snapshot.state === 'Connecting')
                await this._client.disconnect();
            else if (LOGIN_STATES.includes(this._snapshot.state))
                await this._login();
            else
                await this._client.connect(await this._currentProfileId());
        } catch (error) {
            if (!this._client.cancelled)
                this._onError('Connection Could Not Be Changed', error);
        } finally {
            this._setBusy(false);
        }
    }

    async selectProfile(profileId) {
        const profile = this._profiles.find(item => item.id === profileId);
        if (!profile || profile.isActive || this._client.cancelled || this._busy)
            return;

        this._setBusy(true);
        const reconnect = this._snapshot.connected || this._snapshot.state === 'Connecting';
        const previousProfileId = this._activeProfileId();
        let switched = false;
        try {
            if (reconnect)
                await this._client.disconnect();
            await this._client.switchProfile(profileId);
            switched = true;
            if (reconnect)
                await this._client.connect(profileId);
            await this.refresh();
        } catch (error) {
            if (this._client.cancelled)
                return;
            this._onError('Profile Could Not Be Switched', profileError(error, profile));
            // A failed switch must not leave the previous profile disconnected.
            if (reconnect && !switched)
                await this._client.connect(previousProfileId).catch(() => {});
            await this.refresh();
        } finally {
            this._setBusy(false);
        }
    }

    async selectExitNode(networkId) {
        if (this._client.cancelled || this._busy)
            return;

        const selected = this._networks.find(network =>
            network.isExitNode && network.selected);
        if ((selected?.id ?? '') === networkId)
            return;

        this._setBusy(true);
        try {
            if (selected)
                await this._client.deselectNetworks([selected.id]);
            if (networkId)
                await this._client.selectNetworks([networkId], {append: true});
            await this.refresh();
        } catch (error) {
            if (!this._client.cancelled)
                this._onError('Exit Node Could Not Be Changed', error);
        } finally {
            this._setBusy(false);
        }
    }

    async setNetworkSelected(networkId, selected) {
        if (this._client.cancelled || this._busy)
            return;

        this._setBusy(true);
        try {
            if (selected)
                await this._client.selectNetworks([networkId], {append: true});
            else
                await this._client.deselectNetworks([networkId]);
            await this.refresh();
        } catch (error) {
            if (!this._client.cancelled)
                this._onError('Network Could Not Be Changed', error);
        } finally {
            this._setBusy(false);
        }
    }

    async _login() {
        const login = await this._client.login();
        if (this._client.cancelled)
            return;
        if (login.needsSsoLogin) {
            const uri = login.verificationUriComplete || login.verificationUri;
            if (!/^https:\/\//.test(uri))
                throw new Error('NetBird returned an invalid sign-in address');
            this._launchUri(uri);
            await this._client.waitForSso(login.userCode);
        }
        if (!this._client.cancelled)
            await this._client.connect(await this._currentProfileId());
    }

    _subscribe() {
        if (this._client.cancelled)
            return;

        this._client.subscribeStatus(
            snapshot => {
                if (this._client.cancelled)
                    return;

                const networksChanged = snapshot.networksRevision !==
                    this._snapshot.networksRevision;
                // Profile switches from Quick Settings or the CLI pass through
                // a state change, so follow them here.
                const stateChanged = snapshot.state !== this._snapshot.state;
                this._snapshot = snapshot;
                this._reconnectAttempt = 0;
                this._emitChanged();
                if (networksChanged || stateChanged)
                    void this.refresh();
            },
            () => {
                if (this._client.cancelled)
                    return;

                this._setUnavailable();
                this._scheduleReconnect();
            });
    }

    _scheduleReconnect() {
        if (this._client.cancelled || this._reconnectSourceId)
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
        this._snapshot = unavailableSnapshot(this._snapshot);
        this._emitChanged();
    }

    _setBusy(busy) {
        this._busy = busy;
        this._emitChanged();
    }

    _activeProfileId() {
        return this._profiles.find(profile => profile.isActive)?.id ?? '';
    }

    async _currentProfileId() {
        // Another window or the CLI may have switched profiles since the last refresh.
        await this.refresh();
        return this._activeProfileId();
    }

    _emitChanged() {
        if (!this._client.cancelled)
            this._onStateChanged(this.state);
    }
}

function unavailableSnapshot(previous = null) {
    return {
        connected: false,
        daemonVersion: previous?.daemonVersion ?? '',
        localPeer: previous?.localPeer ?? {fqdn: '', ipv4: '', ipv6: ''},
        networksRevision: previous?.networksRevision ?? 0,
        peers: previous?.peers ?? [],
        sessionExpiresAt: previous?.sessionExpiresAt ?? 0,
        state: 'Unavailable',
    };
}

function profileError(error, profile) {
    // The daemon reports profiles by internal ID; show the name people chose.
    const message = String(error?.message ?? error).replaceAll(profile.id, profile.name);
    return new Error(message, {cause: error});
}
