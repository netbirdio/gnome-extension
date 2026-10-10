// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const WRAP_AT = 36;

// Shows a terminal command with a copy button. Long commands break before
// their flags and quoted paths with shell line continuations, so the visible text still runs
// when pasted; the copy button copies the original single line.
export function createCommandView(command, {copyLabel = 'Copy command'} = {}) {
    const box = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
    const label = new Gtk.Label({
        css_classes: ['monospace'],
        hexpand: true,
        label: formatCommand(command),
        selectable: true,
        xalign: 0,
    });
    const button = new Gtk.Button({
        css_classes: ['flat'],
        icon_name: 'edit-copy-symbolic',
        tooltip_text: 'Copy',
        valign: Gtk.Align.CENTER,
    });
    button.update_property([Gtk.AccessibleProperty.LABEL], [copyLabel]);

    let resetId = 0;
    button.connect('clicked', () => {
        button.get_clipboard().set(command);
        button.icon_name = 'object-select-symbolic';
        button.tooltip_text = 'Copied';
        if (resetId)
            GLib.Source.remove(resetId);
        resetId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            resetId = 0;
            button.icon_name = 'edit-copy-symbolic';
            button.tooltip_text = 'Copy';
            return GLib.SOURCE_REMOVE;
        });
    });
    button.connect('destroy', () => {
        if (resetId)
            GLib.Source.remove(resetId);
        resetId = 0;
    });

    box.append(label);
    box.append(button);
    return box;
}

export function formatCommand(command) {
    return command.split('; ')
        .map(part => part.length <= WRAP_AT
            ? part
            : part.replace(/ (?=--|')/g, ' \\\n    '))
        .join(';\n');
}
