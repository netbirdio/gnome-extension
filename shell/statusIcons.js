// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';

const STATE_ICON_FILES = {
    Connected: 'netbird-systemtray-connected-symbolic.svg',
    Connecting: 'netbird-systemtray-connecting-symbolic.svg',
    Idle: 'netbird-systemtray-disconnected-symbolic.svg',
    LoginFailed: 'netbird-systemtray-needs-login-symbolic.svg',
    NeedsLogin: 'netbird-systemtray-needs-login-symbolic.svg',
    SessionExpired: 'netbird-systemtray-needs-login-symbolic.svg',
    Unavailable: 'netbird-systemtray-error-symbolic.svg',
    UpdateRequired: 'netbird-systemtray-error-symbolic.svg',
};

export class StatusIcons {
    constructor(extensionDirectory) {
        const scalable = extensionDirectory.get_child('icons')
            .get_child('hicolor')
            .get_child('scalable');
        const directory = scalable.get_child('status');
        this.appIcon = new Gio.FileIcon({
            file: scalable.get_child('apps').get_child('netbird.svg'),
        });

        this._icons = new Map();
        for (const filename of new Set(Object.values(STATE_ICON_FILES))) {
            const file = directory.get_child(filename);
            this._icons.set(filename, new Gio.FileIcon({file}));
        }
    }

    forState(state) {
        const filename = STATE_ICON_FILES[state] ??
            'netbird-systemtray-error-symbolic.svg';
        return this._icons.get(filename);
    }
}
