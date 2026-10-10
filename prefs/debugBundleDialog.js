// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {createCommandView} from './commandView.js';

const NETBIRD_ISSUES_URL = 'https://github.com/netbirdio/netbird/issues';
const EXTENSION_ISSUES_URL = 'https://github.com/netbirdio/gnome-extension/issues';

// Problems in NetBird itself belong upstream; only extension-specific ones
// should reach this project's tracker.
const REPORTING_GUIDANCE =
    'Before reporting a problem, check whether it also happens in the official ' +
    `NetBird app. If it does, <a href="${NETBIRD_ISSUES_URL}">report it to ` +
    'NetBird</a>. If it only happens in this extension, ' +
    `<a href="${EXTENSION_ISSUES_URL}">report it to NetBird for GNOME</a>.`;

export function presentDebugBundleDialog(parent, {createBundle, onError}) {
    const options = new Gtk.ListBox({
        css_classes: ['boxed-list'],
        selection_mode: Gtk.SelectionMode.NONE,
    });
    const upload = new Adw.SwitchRow({
        active: false,
        subtitle: 'Get an upload key to share with NetBird support',
        title: 'Upload to NetBird',
    });
    const anonymize = new Adw.SwitchRow({
        active: true,
        subtitle: 'Hide IP addresses, domains, and other sensitive values',
        title: 'Anonymize Sensitive Information',
    });
    const systemInfo = new Adw.SwitchRow({
        active: true,
        subtitle: 'Include OS, kernel, network interfaces, and routes',
        title: 'Include System Information',
    });
    for (const row of [upload, anonymize, systemInfo])
        options.append(row);

    const dialog = new Adw.AlertDialog({
        body: REPORTING_GUIDANCE,
        body_use_markup: true,
        close_response: 'cancel',
        default_response: 'create',
        extra_child: options,
        heading: 'Create Debug Bundle',
    });
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('create', 'Create');
    dialog.set_response_appearance('create', Adw.ResponseAppearance.SUGGESTED);
    dialog.connect('response', (_dialog, response) => {
        if (response !== 'create')
            return;

        const uploading = upload.active;
        const toast = new Adw.Toast({
            timeout: 0,
            title: uploading
                ? 'Creating and uploading the debug bundle…'
                : 'Creating the debug bundle…',
        });
        parent.add_toast(toast);
        void createBundle({
            anonymize: anonymize.active,
            systemInfo: systemInfo.active,
            upload: uploading,
        }).then(result => {
            toast.dismiss();
            if (result)
                presentResult(parent, result, uploading);
        }).catch(error => {
            toast.dismiss();
            onError(error);
        });
    });
    dialog.present(parent);
}

function presentResult(parent, {path, uploadFailureReason, uploadedKey}, uploading) {
    // The daemon writes the bundle as root; this copies it somewhere the user can attach it.
    const copyHome = `sudo install -m 600 -o "$USER" ${GLib.shell_quote(path)} ~/`;
    let heading = 'Debug Bundle Saved';
    let body = 'The NetBird service saved the bundle where only administrators ' +
        'can read it. To attach it to a report, copy it to your home folder:';
    let extraChild = createCommandView(copyHome);

    if (uploading && uploadedKey) {
        heading = 'Debug Bundle Uploaded';
        body = 'Share this upload key with NetBird support. A local copy was also saved.';
        extraChild = createCommandView(uploadedKey, {copyLabel: 'Copy upload key'});
    } else if (uploading) {
        body = `Upload failed: ${uploadFailureReason || 'unknown error'}. The bundle ` +
            'is still saved locally, where only administrators can read it. ' +
            'To attach it to a report, copy it to your home folder:';
    }

    const dialog = new Adw.AlertDialog({
        body,
        close_response: 'close',
        extra_child: extraChild,
        heading,
    });
    dialog.add_response('close', 'Close');
    dialog.present(parent);
}
