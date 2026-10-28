// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {hostAddress} from '../netbird/normalize.js';
import {createCopyButton} from './commandView.js';
import {sameStrings} from './stringFactory.js';

const FILTER_ALL = 0;
const FILTER_CONNECTED = 1;
const FILTER_OFFLINE = 2;

// Matches the official NetBird client, which pulses peers that are still
// connecting between full and half opacity.
const PEER_STATUS_CSS = `
image.netbird-peer-connecting {
    animation: netbird-peer-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

@keyframes netbird-peer-pulse {
    0% { opacity: 1; }
    50% { opacity: 0.5; }
    100% { opacity: 1; }
}
`;

let peerStatusCssInstalled = false;

export function createPeersPage() {
    installPeerStatusCss();

    const root = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
    });
    const controls = new Gtk.Box({
        margin_end: 18,
        margin_start: 18,
        margin_top: 18,
        spacing: 12,
    });
    const search = new Gtk.SearchEntry({
        hexpand: true,
        placeholder_text: 'Search by name or IP address',
    });
    const filter = new Gtk.DropDown({
        model: Gtk.StringList.new(['All', 'Connected', 'Offline']),
        selected: FILTER_ALL,
        tooltip_text: 'Filter peers by connection state',
    });
    filter.update_property(
        [Gtk.AccessibleProperty.LABEL],
        ['Peer connection filter']);
    controls.append(search);
    controls.append(filter);
    root.append(controls);

    const overlay = new Gtk.Overlay({
        hexpand: true,
        vexpand: true,
    });
    const scrolled = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        margin_bottom: 18,
        margin_end: 18,
        margin_start: 18,
        margin_top: 12,
        vexpand: true,
    });
    const peerGroup = new Adw.PreferencesGroup({
        valign: Gtk.Align.START,
    });
    scrolled.set_child(peerGroup);
    overlay.set_child(scrolled);

    const empty = new Adw.StatusPage({
        description: 'Connected peers will appear here',
        icon_name: 'network-offline-symbolic',
        title: 'No Peers',
    });
    overlay.add_overlay(empty);
    root.append(overlay);

    const entries = new Map();
    let connected = true;
    let currentPeers = [];
    let rowOrder = [];

    function matches(peer) {
        const selected = filter.selected;
        if (selected === FILTER_CONNECTED && peer.state !== 'Connected')
            return false;
        if (selected === FILTER_OFFLINE && peer.state === 'Connected')
            return false;

        const query = search.text.trim().toLocaleLowerCase();
        if (!query)
            return true;
        return [peer.fqdn, peer.ip, peer.ipv6, peer.state]
            .some(value => String(value ?? '').toLocaleLowerCase().includes(query));
    }

    function updateFilter() {
        let visible = 0;
        for (const entry of entries.values()) {
            entry.row.visible = matches(entry.peer);
            if (entry.row.visible)
                visible++;
        }
        scrolled.visible = visible > 0;
        empty.visible = visible === 0;
        if (!connected) {
            empty.title = 'Not Connected';
            empty.description = 'Connect to NetBird to see your peers';
        } else if (currentPeers.length === 0) {
            empty.title = 'No Peers';
            empty.description = 'Connected peers will appear here';
        } else {
            empty.title = 'No Matching Peers';
            empty.description = 'Try changing the search or connection filter';
        }
    }

    search.connect('search-changed', updateFilter);
    filter.connect('notify::selected', updateFilter);

    return {
        root,
        focusSearch() {
            search.grab_focus();
        },
        update({snapshot}) {
            connected = snapshot.connected;
            currentPeers = snapshot.peers;
            const currentKeys = new Set();
            for (const [index, peer] of snapshot.peers.entries()) {
                const key = peerKey(peer, index);
                currentKeys.add(key);
                let entry = entries.get(key);
                if (!entry) {
                    entry = createPeerRow();
                    entries.set(key, entry);
                    peerGroup.add(entry.row);
                }
                entry.peer = peer;
                updatePeerRow(entry, peer);
            }

            for (const [key, entry] of entries) {
                if (!currentKeys.has(key)) {
                    peerGroup.remove(entry.row);
                    entries.delete(key);
                }
            }
            const nextOrder = [...entries.entries()]
                .sort(([, left], [, right]) => comparePeers(left.peer, right.peer))
                .map(([key]) => key);
            if (!sameStrings(rowOrder, nextOrder)) {
                for (const key of nextOrder)
                    peerGroup.remove(entries.get(key).row);
                for (const key of nextOrder)
                    peerGroup.add(entries.get(key).row);
                rowOrder = nextOrder;
            }
            updateFilter();
        },
    };
}

function installPeerStatusCss() {
    const display = Gdk.Display.get_default();
    if (peerStatusCssInstalled || !display)
        return;

    const provider = new Gtk.CssProvider();
    provider.load_from_string(PEER_STATUS_CSS);
    Gtk.StyleContext.add_provider_for_display(
        display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    peerStatusCssInstalled = true;
}

function createPeerRow() {
    const row = new Adw.ActionRow({
        subtitle_lines: 1,
        title_lines: 1,
        use_markup: false,
    });
    const icon = new Gtk.Image();
    const latency = new Gtk.Label({
        css_classes: ['dim-label'],
        valign: Gtk.Align.CENTER,
    });
    const entry = {icon, latency, peer: {}, row};
    const copy = createCopyButton(() => hostAddress(entry.peer.ip || entry.peer.ipv6),
        'Copy peer IP address');
    row.add_prefix(icon);
    row.add_suffix(latency);
    row.add_suffix(copy);
    entry.copy = copy;
    return entry;
}

function updatePeerRow(entry, peer) {
    const connected = peer.state === 'Connected';
    entry.row.title = peerName(peer);
    entry.row.subtitle = [
        peer.ip,
        peer.ipv6,
        peer.relayed ? 'Relayed' : '',
    ].filter(Boolean).join('  •  ');
    entry.icon.icon_name = connected
        ? 'network-transmit-receive-symbolic'
        : 'network-offline-symbolic';
    entry.icon.css_classes = [
        connected ? 'success' : 'warning',
        ...peer.state === 'Connecting' ? ['netbird-peer-connecting'] : [],
    ];
    entry.icon.tooltip_text = peer.state;
    entry.icon.update_property([Gtk.AccessibleProperty.LABEL], [peer.state]);
    entry.latency.label = connected && peer.latencyMs > 0
        ? `${Math.round(peer.latencyMs)} ms`
        : '';
    entry.latency.visible = Boolean(entry.latency.label);
    entry.copy.visible = Boolean(peer.ip || peer.ipv6);
    entry.row.tooltip_text = peerDetails(peer);
}

function peerDetails(peer) {
    const lines = [peer.fqdn, `Status: ${peer.state}`];
    if (peer.bytesRx || peer.bytesTx) {
        lines.push(`Received: ${GLib.format_size(peer.bytesRx)}`);
        lines.push(`Sent: ${GLib.format_size(peer.bytesTx)}`);
    }
    if (peer.lastHandshake)
        lines.push(`Last handshake: ${timeAgo(peer.lastHandshake)}`);
    return lines.filter(Boolean).join('\n');
}

function timeAgo(timestampSeconds) {
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestampSeconds);
    if (seconds < 60)
        return 'just now';
    const units = [[86400, 'day'], [3600, 'hour'], [60, 'minute']];
    const [size, unit] = units.find(([unitSeconds]) => seconds >= unitSeconds);
    const count = Math.floor(seconds / size);
    return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

function peerKey(peer, index) {
    return peer.fqdn || peer.ip || peer.ipv6 || `unknown-${index}`;
}

function peerName(peer) {
    const fqdn = String(peer.fqdn ?? '');
    return fqdn.split('.')[0] || peer.ip || peer.ipv6 || 'Unknown Peer';
}

function comparePeers(left, right) {
    const stateDifference = peerStateOrder(left.state) - peerStateOrder(right.state);
    if (stateDifference !== 0)
        return stateDifference;
    return peerName(left).localeCompare(peerName(right));
}

function peerStateOrder(state) {
    if (state === 'Connected')
        return 0;
    if (state === 'Connecting')
        return 1;
    return 2;
}
