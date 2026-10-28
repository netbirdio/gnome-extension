// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';

import {NetBirdClient} from '../netbird/client.js';
import {DaemonController} from '../netbird/controller.js';

export class MainController extends DaemonController {
    constructor({
        client = new NetBirdClient(),
        launchUri = uri => Gio.AppInfo.launch_default_for_uri(uri, null),
        onError,
        onStateChanged,
    }) {
        super({client, onActionError: onError, onStateChanged});
        this._launchUri = launchUri;
        this._features = {};
        this._networks = [];

        this._subscribe();
        void this.refresh();
    }

    get state() {
        return {
            ...super.state,
            features: this._features,
            networks: this._networks,
        };
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
        } catch (error) {
            if (!this._client.cancelled)
                this._setOffline(error);
        }
    }

    async toggleConnection() {
        if (this._client.cancelled || this._busy)
            return;

        this._setBusy(true);
        try {
            if (this._snapshot.connected || this._snapshot.state === 'Connecting')
                await this._client.disconnect();
            else if (this._needsLogin())
                await this._login();
            else
                await this._client.connect(await this._currentProfileId());
        } catch (error) {
            if (!this._client.cancelled)
                this._onActionError('Connection Could Not Be Changed', error);
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
                this._onActionError('Exit Node Could Not Be Changed', error);
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
                this._onActionError('Network Could Not Be Changed', error);
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

    _statusChanged(snapshot, previous) {
        if (snapshot.networksRevision !== previous.networksRevision ||
            snapshot.state !== previous.state)
            void this.refresh();
    }
}
