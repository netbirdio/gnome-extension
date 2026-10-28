// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import {versionErrorMessage} from '../netbird/client.js';
import {OFFLINE_STATES, statusLabel} from '../netbird/controller.js';
import {hostAddress} from '../netbird/normalize.js';
import {
    createCheckedStringFactory,
    createEllipsizedStringFactory,
    sameStrings,
} from './stringFactory.js';

export function createHomePage(actions) {
    const root = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
    });
    const banner = new Adw.Banner({
        button_label: 'Show Me How',
        revealed: false,
        title: 'Finish setting up NetBird',
    });
    banner.connect('button-clicked', actions.onSocketHelp);
    root.append(banner);

    const scrolled = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vexpand: true,
    });
    const clamp = new Adw.Clamp({
        margin_bottom: 24,
        margin_end: 24,
        margin_start: 24,
        margin_top: 24,
        maximum_size: 480,
        valign: Gtk.Align.CENTER,
    });
    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 14,
    });
    clamp.set_child(content);

    const brand = new Gtk.Box({
        halign: Gtk.Align.CENTER,
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
    });
    brand.append(new Gtk.Image({
        halign: Gtk.Align.CENTER,
        icon_name: 'netbird',
        pixel_size: 56,
        valign: Gtk.Align.CENTER,
    }));
    brand.append(new Gtk.Label({
        css_classes: ['title-1'],
        halign: Gtk.Align.CENTER,
        label: 'NetBird',
        valign: Gtk.Align.CENTER,
    }));
    content.append(brand);

    const connectionSwitch = new Gtk.Switch({
        halign: Gtk.Align.CENTER,
        tooltip_text: 'Connect or disconnect NetBird',
        valign: Gtk.Align.CENTER,
    });
    connectionSwitch.update_property(
        [Gtk.AccessibleProperty.LABEL],
        ['NetBird connection']);
    content.append(connectionSwitch);

    const stateLabel = new Gtk.Label({
        css_classes: ['title-2'],
        halign: Gtk.Align.CENTER,
        label: 'Loading…',
    });
    content.append(stateLabel);

    const fqdnLabel = detailLabel();
    const ipv4Label = detailLabel();
    const ipv6Label = detailLabel();
    content.append(fqdnLabel);
    content.append(ipv4Label);
    content.append(ipv6Label);

    const exitGroup = new Adw.PreferencesGroup({
        margin_top: 28,
    });
    const exitNode = new Adw.ComboRow({
        factory: createEllipsizedStringFactory(24, true),
        list_factory: createCheckedStringFactory(),
        subtitle: 'Route traffic through another NetBird peer',
        title: 'Exit Node',
    });
    exitGroup.add(exitNode);
    content.append(exitGroup);

    scrolled.set_child(clamp);
    root.append(scrolled);

    let suppressConnection = false;
    let suppressExitNode = false;
    let exitNodeIds = [];
    let selectedExitNodeId = '';
    let selectionSourceId = 0;

    connectionSwitch.connect('notify::active', () => {
        if (!suppressConnection)
            actions.onToggleConnection();
    });
    exitNode.connect('notify::selected', () => {
        if (suppressExitNode)
            return;

        const id = exitNodeIds[exitNode.selected] ?? '';
        if (id === selectedExitNodeId)
            return;

        if (selectionSourceId)
            GLib.Source.remove(selectionSourceId);
        selectionSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            selectionSourceId = 0;
            actions.onSelectExitNode(id);
            return GLib.SOURCE_REMOVE;
        });
    });
    root.connect('destroy', () => {
        if (selectionSourceId) {
            GLib.Source.remove(selectionSourceId);
            selectionSourceId = 0;
        }
    });

    return {
        root,
        update({busy, features = {}, networks, snapshot}) {
            updateBanner(banner, snapshot);
            suppressConnection = true;
            connectionSwitch.active = snapshot.connected || snapshot.state === 'Connecting';
            suppressConnection = false;
            connectionSwitch.sensitive = !busy && !OFFLINE_STATES.includes(snapshot.state);

            stateLabel.label = statusLabel(snapshot.state);
            setDetail(fqdnLabel, snapshot.connected ? snapshot.localPeer.fqdn : '');
            setDetail(ipv4Label,
                snapshot.connected ? hostAddress(snapshot.localPeer.ipv4) : '');
            setDetail(ipv6Label,
                snapshot.connected ? hostAddress(snapshot.localPeer.ipv6) : '');

            const exits = networks.filter(network => network.isExitNode);
            exitGroup.visible = !features.disableNetworks;
            const names = ['No exit node', ...exits.map(network => network.id)];
            const nextExitNodeIds = ['', ...exits.map(network => network.id)];
            selectedExitNodeId = exits.find(network => network.selected)?.id ?? '';
            suppressExitNode = true;
            if (!sameStrings(exitNodeIds, nextExitNodeIds)) {
                exitNodeIds = nextExitNodeIds;
                exitNode.model = Gtk.StringList.new(names);
            }
            const selected = exits.findIndex(network => network.selected);
            exitNode.selected = selected === -1 ? 0 : selected + 1;
            suppressExitNode = false;
            exitNode.sensitive = !busy && snapshot.connected && exits.length > 0;
        },
    };
}

// Setup and updates are both done outside the extension; only setup has
// a command to show.
function updateBanner(banner, snapshot) {
    banner.revealed = OFFLINE_STATES.includes(snapshot.state);
    if (snapshot.state === 'UpdateRequired') {
        banner.title = versionErrorMessage(snapshot.daemonVersion);
        banner.button_label = null;
    } else {
        banner.title = 'Finish setting up NetBird';
        banner.button_label = 'Show Me How';
    }
}

// Addresses are copied whole: a click selects all of it, the menu only offers
// Copy, and Ctrl+C copies it. GTK's own label gestures would allow partial
// selections and offer Cut, Paste, and Delete, which mean nothing here.
function detailLabel() {
    const label = new Gtk.Label({
        css_classes: ['dim-label', 'monospace'],
        ellipsize: Pango.EllipsizeMode.END,
        selectable: true,
        visible: false,
    });

    const actions = new Gio.SimpleActionGroup();
    const copy = new Gio.SimpleAction({name: 'copy'});
    copy.connect('activate', () => label.get_clipboard().set(label.label));
    actions.add_action(copy);
    label.insert_action_group('address', actions);

    const menu = new Gio.Menu();
    menu.append('Copy', 'address.copy');
    const popover = Gtk.PopoverMenu.new_from_model(menu);
    popover.has_arrow = false;
    popover.set_parent(label);
    label.connect('destroy', () => popover.unparent());

    const selectAll = () => {
        label.grab_focus();
        label.select_region(0, -1);
    };
    const showMenu = (x, y) => {
        selectAll();
        popover.pointing_to = new Gdk.Rectangle({x, y, width: 1, height: 1});
        popover.popup();
    };

    // The capture phase runs before the label's own gestures and stops them.
    const click = new Gtk.GestureClick({
        button: 0,
        propagation_phase: Gtk.PropagationPhase.CAPTURE,
    });
    click.connect('pressed', (gesture, _presses, x, y) => {
        gesture.set_state(Gtk.EventSequenceState.CLAIMED);
        if (gesture.get_current_button() === Gdk.BUTTON_SECONDARY)
            showMenu(x, y);
        else
            selectAll();
    });
    label.add_controller(click);

    const shortcuts = new Gtk.ShortcutController({
        propagation_phase: Gtk.PropagationPhase.CAPTURE,
    });
    shortcuts.add_shortcut(new Gtk.Shortcut({
        action: Gtk.NamedAction.new('address.copy'),
        trigger: Gtk.ShortcutTrigger.parse_string('<Control>c|<Control>Insert'),
    }));
    shortcuts.add_shortcut(new Gtk.Shortcut({
        action: Gtk.CallbackAction.new(() => {
            showMenu(label.get_width() / 2, label.get_height() / 2);
            return true;
        }),
        trigger: Gtk.ShortcutTrigger.parse_string('<Shift>F10|Menu'),
    }));
    label.add_controller(shortcuts);

    return label;
}

function setDetail(label, text) {
    label.label = text;
    label.tooltip_text = text;
    label.visible = Boolean(text);
}
