// SPDX-License-Identifier: GPL-3.0-or-later

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

// Notifications appear under "NetBird" instead of GNOME's generic "System".
export class NetBirdNotifier {
    constructor(icon) {
        this._icon = icon;
        this._source = null;
    }

    notify(title, body, {actions = [], urgency = MessageTray.Urgency.NORMAL} = {}) {
        const source = this._getSource();
        const notification = new MessageTray.Notification({body, source, title, urgency});
        for (const [label, callback] of actions)
            notification.addAction(label, callback);
        source.addNotification(notification);
        return notification;
    }

    destroy() {
        this._source?.destroy();
        this._source = null;
        this._icon = null;
    }

    _getSource() {
        if (!this._source) {
            this._source = new MessageTray.Source({icon: this._icon, title: 'NetBird'});
            // Shell destroys a source once its last notification is gone.
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        return this._source;
    }
}
