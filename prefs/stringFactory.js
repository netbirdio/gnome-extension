// SPDX-License-Identifier: GPL-3.0-or-later

import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

export function createEllipsizedStringFactory(widthChars, alignEnd = false) {
    const factory = new Gtk.SignalListItemFactory();
    factory.connect('setup', (_factory, listItem) => {
        listItem.child = new Gtk.Label({
            ellipsize: Pango.EllipsizeMode.END,
            halign: alignEnd ? Gtk.Align.END : Gtk.Align.FILL,
            max_width_chars: widthChars,
            xalign: alignEnd ? 1 : 0,
        });
    });
    factory.connect('bind', (_factory, listItem) => {
        const text = listItem.item?.string ?? '';
        listItem.child.label = text;
        listItem.child.tooltip_text = text;
    });
    return factory;
}

// Custom popup factories replace the default checkmark on the selected item.
export function createCheckedStringFactory() {
    const factory = new Gtk.SignalListItemFactory();
    factory.connect('setup', (_factory, listItem) => {
        const box = new Gtk.Box({spacing: 12});
        const label = new Gtk.Label({hexpand: true, xalign: 0});
        const check = new Gtk.Image({icon_name: 'object-select-symbolic'});
        box.append(label);
        box.append(check);
        listItem.child = box;
        listItem.connect('notify::selected', () => {
            check.opacity = listItem.selected ? 1 : 0;
        });
    });
    factory.connect('bind', (_factory, listItem) => {
        const box = listItem.child;
        box.get_first_child().label = listItem.item?.string ?? '';
        box.get_last_child().opacity = listItem.selected ? 1 : 0;
    });
    return factory;
}
