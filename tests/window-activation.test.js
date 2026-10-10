// SPDX-License-Identifier: GPL-3.0-or-later

import {activateExistingPreferences} from '../shell/windowActivation.js';

const tests = [
    ['opens a new window when NetBird is not running', () => {
        let activated = false;
        const found = activateExistingPreferences([
            fakeWindow('Files'),
        ], () => {
            activated = true;
        });
        if (found || activated)
            throw new Error('an unrelated window was activated');
    }],
    ['raises an existing NetBird window', () => {
        const window = fakeWindow('NetBird');
        let activatedWindow = null;
        const found = activateExistingPreferences([window], candidate => {
            activatedWindow = candidate;
        });
        if (!found || activatedWindow !== window)
            throw new Error('the NetBird window was not activated');
        if (window.unminimizeCalls !== 0)
            throw new Error('an unminimized window was changed');
    }],
    ['unminimizes NetBird before raising it', () => {
        const window = fakeWindow('NetBird', true);
        const events = [];
        window.unminimize = () => events.push('unminimize');
        const found = activateExistingPreferences([window], () => {
            events.push('activate');
        });
        if (!found || events.join(',') !== 'unminimize,activate')
            throw new Error('the minimized window was not restored first');
    }],
    ['ignores a NetBird window that belongs to another app', () => {
        let activated = false;
        const found = activateExistingPreferences([
            fakeWindow('NetBird', false, 'io.netbird.client'),
        ], () => {
            activated = true;
        });
        if (found || activated)
            throw new Error('the official NetBird app window was activated');
    }],
    ['recognizes the host window before its custom title is applied', () => {
        const window = fakeWindow('NetBird for GNOME');
        const found = activateExistingPreferences([window], () => {
        });
        if (!found)
            throw new Error('the GNOME preferences host was not recognized');
    }],
];

function fakeWindow(title, minimized = false, appId = 'org.gnome.Shell.Extensions') {
    return {
        minimized,
        unminimizeCalls: 0,
        get_gtk_application_id() {
            return appId;
        },
        get_title() {
            return title;
        },
        get_wm_class() {
            return appId;
        },
        unminimize() {
            this.unminimizeCalls++;
        },
    };
}

for (const [name, test] of tests) {
    try {
        test();
        print(`ok ${name}`);
    } catch (error) {
        printerr(`not ok ${name}: ${error}`);
        throw error;
    }
}
