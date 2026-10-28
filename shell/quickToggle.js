// SPDX-License-Identifier: GPL-3.0-or-later

import GObject from 'gi://GObject';
import St from 'gi://St';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {OFFLINE_STATES, statusLabel} from '../netbird/controller.js';
import {hostAddress} from '../netbird/normalize.js';
import {NetBirdNotifier} from './notifications.js';
import {StatusController} from './statusController.js';
import {VpnButtonGuard} from './vpnButtonGuard.js';

export const NetBirdToggle = GObject.registerClass({
    GTypeName: 'NetBirdExtensionToggle',
}, class NetBirdToggleImpl extends QuickMenuToggle {
    constructor(extension, statusIcons, panelIcon) {
        super({
            gicon: statusIcons.forState('Unavailable'),
            subtitle: 'Loading…',
            title: 'NetBird',
            toggleMode: false,
        });

        this._extension = extension;
        this._panelIcon = panelIcon;
        this._statusIcons = statusIcons;
        this._notifier = new NetBirdNotifier(statusIcons.appIcon);
        this._profileSection = new PopupMenu.PopupMenuSection();
        this._profileItems = [];
        this._profileSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this._signalIds = [];
        this._profileKey = null;
        this._vpnGuard = new VpnButtonGuard(
            Main.panel.statusArea.quickSettings, new InjectionManager(),
            error => this._notifyError('VPN Could Not Be Disabled', error));

        this.menu.addMenuItem(this._profileSection);
        this.menu.addMenuItem(this._profileSeparator);

        this._ipAddress = '';
        this._copyIpItem = this.menu.addAction('Copy IP Address', () => {
            // Only writes, and only when the person picks this item; declared
            // in the metadata description as EGO's review guidelines require.
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD, this._ipAddress);
            this.menu.close();
        }, 'edit-copy-symbolic');
        this._copyIpItem.visible = false;
        this._refreshItem = this.menu.addAction('Refresh', () => {
            void this._controller.refresh();
        }, 'view-refresh-symbolic');
        this._openItem = this.menu.addAction('Open NetBird', () => {
            // Like GNOME's own settings items, get Quick Settings out of the way.
            Main.panel.closeQuickSettings();
            this._extension.openPreferences();
        }, 'network-vpn-symbolic');
        this._openItem.visible = Main.sessionMode.allowSettings;
        this.menu._settingsActions[extension.uuid] = this._openItem;
        this.menu.setHeader(statusIcons.forState('Unavailable'), 'NetBird');

        this._controller = new StatusController({
            beforeConnect: () => this._vpnGuard.disconnectActiveVpns(),
            onActionError: (title, error) => this._notifyError(title, error),
            onSessionExpired: () => this._notifySessionExpired(),
            onSessionWarning: deadline => this._notifySessionWarning(deadline),
            onStateChanged: state => this._sync(state),
        });

        this._signalIds.push([
            this,
            this.connect('clicked', () => void this._toggleConnection()),
        ]);
        this._signalIds.push([
            this.menu,
            this.menu.connect('open-state-changed', (_menu, open) => {
                if (!open)
                    return;
                // Shell re-shows separators on open (this runs after its handler);
                // with no profiles there is nothing to separate.
                this._profileSeparator.visible = !this._profileSection.isEmpty();
                void this._controller.refresh();
            }),
        ]);
    }

    destroy() {
        this._controller.destroy();
        this._controller = null;
        this._notifier.destroy();
        this._notifier = null;
        this._statusIcons = null;
        this._vpnGuard.destroy();
        this._vpnGuard = null;
        for (const [object, id] of this._signalIds)
            object.disconnect(id);
        this._signalIds = [];
        super.destroy();
    }

    async _toggleConnection() {
        const controller = this._controller;
        const handledInShell = await controller.toggleConnection();
        if (this._controller !== controller)
            return;

        if (!handledInShell) {
            // Close all of Quick Settings, like GNOME's own tiles that open a window.
            Main.panel.closeQuickSettings();
            this._extension.openPreferences();
        }
    }

    _sync({busy = false, profiles, snapshot}) {
        this.reactive = !busy;
        this._vpnGuard.setBlocked(snapshot.connected);
        const gicon = this._statusIcons.forState(snapshot.state);
        this.gicon = gicon;
        this._panelIcon.gicon = gicon;
        this._ipAddress = snapshot.connected ? hostAddress(snapshot.localPeer.ipv4) : '';
        const subtitle = this._ipAddress || statusLabel(snapshot.state);
        this.menu.setHeader(gicon, 'NetBird', subtitle);
        this.checked = snapshot.connected || snapshot.state === 'Connecting';
        this.subtitle = subtitle;
        this._panelIcon.visible = true;
        this._copyIpItem.visible = Boolean(this._ipAddress);
        this._rebuildProfiles(profiles);
        // Shell stops resyncing a section's items after the first one becomes
        // sensitive, so later profiles would stay grayed out.
        const offline = OFFLINE_STATES.includes(snapshot.state);
        for (const item of this._profileItems)
            item.setSensitive(!busy && !offline);
        this._refreshItem.setSensitive(!busy);
    }

    _rebuildProfiles(profiles) {
        const key = JSON.stringify(profiles.map(profile =>
            [profile.id, profile.name, profile.isActive]));
        if (key === this._profileKey)
            return;
        this._profileKey = key;
        this._profileSection.removeAll();
        this._profileItems = [];
        this._profileSection.actor.visible = profiles.length > 0;
        this._profileSeparator.visible = profiles.length > 0;
        if (profiles.length === 0)
            return;

        for (const profile of profiles) {
            const item = this._profileSection.addAction(profile.name, () => {
                void this._controller.selectProfile(profile.id);
            });
            if (profile.isActive)
                item.setOrnament(PopupMenu.Ornament.CHECK);
            this._profileItems.push(item);
        }
    }

    _notifyError(title, error) {
        const message = String(error?.message ?? error).trim() || 'Unknown error';
        this._notifier.notify(title, message);
    }

    _notifySessionWarning(deadline) {
        const minutes = Math.max(1, Math.round((deadline - Date.now() / 1000) / 60));
        this._notifier.notify('NetBird Session Expires Soon',
            `Your NetBird session expires in ${minutes} minute${minutes === 1 ? '' : 's'}. ` +
            'Extend it to stay connected.', {
                actions: [['Extend Session', () => void this._extendSession()]],
                urgency: MessageTray.Urgency.HIGH,
            });
    }

    _notifySessionExpired() {
        this._notifier.notify('NetBird Session Expired',
            'Sign in again to reconnect to your NetBird network.', {
                actions: [['Sign In', () => this._extension.openPreferences()]],
                urgency: MessageTray.Urgency.HIGH,
            });
    }

    async _extendSession() {
        const controller = this._controller;
        try {
            const deadline = await controller.extendSession();
            if (this._controller !== controller)
                return;
            this._notifier.notify('NetBird Session Extended', deadline
                ? `Your session now lasts another ${formatDuration(deadline)}.`
                : 'Your session has been renewed.');
        } catch (error) {
            if (this._controller === controller)
                this._notifyError('Session Could Not Be Extended', error);
        }
    }
});

function formatDuration(deadline) {
    const minutes = Math.max(1, Math.round((deadline - Date.now() / 1000) / 60));
    if (minutes < 120)
        return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}
