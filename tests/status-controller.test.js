// SPDX-License-Identifier: GPL-3.0-or-later

import {StatusController} from '../shell/statusController.js';

const tests = [
    ['profiles are available when policy allows them', async () => {
        const fixture = await createFixture(false);
        if (fixture.state.profileName !== 'Work' ||
            fixture.state.profiles.length !== 2)
            throw new Error('available profiles were not published');

        fixture.controller.destroy();
    }],
    ['profile policy removes Quick Settings profile actions', async () => {
        const fixture = await createFixture(true);
        if (fixture.state.profileName || fixture.state.profiles.length)
            throw new Error('disabled profiles were published');
        fixture.controller.destroy();
    }],
    ['unavailable state opens setup without trying to connect', async () => {
        const fixture = await createFixture(false);
        const handledInShell = await fixture.controller.toggleConnection();
        if (handledInShell)
            throw new Error('unavailable state was handled as a connection toggle');
        if (fixture.client.connectCalls !== 0)
            throw new Error('connection was attempted without a socket');
        fixture.controller.destroy();
    }],
    ['a failed profile switch reconnects the previous profile', async () => {
        const fixture = await createFixture(false);
        fixture.controller._snapshot = {
            ...fixture.controller._snapshot,
            connected: true,
            state: 'Connected',
        };
        fixture.client.switchError = new Error('profile "home" not found');
        await fixture.controller.selectProfile('home');
        if (fixture.client.connectedProfiles.join() !== 'work')
            throw new Error(`reconnected ${fixture.client.connectedProfiles.join()}, expected work`);
        if (!fixture.errors[0]?.message.includes('"Home" not found'))
            throw new Error(`error did not name the profile: ${fixture.errors[0]?.message}`);
        fixture.controller.destroy();
    }],
    ['warns about a session that expires within five minutes', async () => {
        const fixture = await createFixture(false);
        const deadline = Math.floor(Date.now() / 1000) + 120;
        fixture.client.emitStatus({...snapshot('Connected'), sessionExpiresAt: deadline});
        if (fixture.warnings.join() !== String(deadline))
            throw new Error(`expected one immediate warning, got ${fixture.warnings}`);
        // A repeated snapshot with the same deadline must not warn again.
        fixture.client.emitStatus({...snapshot('Connected'), sessionExpiresAt: deadline});
        if (fixture.warnings.length !== 1)
            throw new Error('the same deadline warned twice');
        fixture.controller.destroy();
    }],
    ['schedules the warning for a later deadline', async () => {
        const fixture = await createFixture(false);
        fixture.client.emitStatus({
            ...snapshot('Connected'),
            sessionExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        });
        if (fixture.warnings.length || !fixture.controller._sessionWarningSourceId)
            throw new Error('the warning was not scheduled for later');
        fixture.controller.destroy();
        if (fixture.controller._sessionWarningSourceId)
            throw new Error('destroy left the warning timer running');
    }],
    ['reports a session that expires while NetBird is running', async () => {
        const fixture = await createFixture(false);
        fixture.client.emitStatus(snapshot('SessionExpired'));
        if (fixture.expired !== 0)
            throw new Error('an already expired session was reported as news');
        // The daemon passes through Idle between Connected and the expiry.
        fixture.client.emitStatus(snapshot('Connected'));
        fixture.client.emitStatus(snapshot('Idle'));
        fixture.client.emitStatus(snapshot('SessionExpired'));
        fixture.client.emitStatus(snapshot('SessionExpired'));
        if (fixture.expired !== 1)
            throw new Error(`expected one expiry report, got ${fixture.expired}`);
        // Disconnecting on purpose is not followed by an expiry report.
        fixture.client.emitStatus(snapshot('Connected'));
        await fixture.controller.toggleConnection();
        fixture.client.emitStatus(snapshot('SessionExpired'));
        if (fixture.expired !== 1)
            throw new Error('a deliberate disconnect was reported as an expiry');
        fixture.controller.destroy();
    }],
    ['connect uses the profile that is active now, not a cached one', async () => {
        const fixture = await createFixture(false);
        fixture.controller._snapshot = {...fixture.controller._snapshot, state: 'Idle'};
        // Another window switched profiles after Quick Settings last refreshed.
        fixture.client.activeProfile = 'home';
        await fixture.controller.toggleConnection();
        if (fixture.client.connectedProfiles.join() !== 'home')
            throw new Error(`connected ${fixture.client.connectedProfiles.join()}, expected home`);
        fixture.controller.destroy();
    }],
];

async function createFixture(disableProfiles) {
    const client = new FakeClient(disableProfiles);
    let state = null;
    const errors = [];
    const fixture = {client, errors, expired: 0, warnings: []};
    const controller = new StatusController({
        client,
        onActionError(_title, error) {
            errors.push(error);
        },
        onSessionExpired() {
            fixture.expired++;
        },
        onSessionWarning(deadline) {
            fixture.warnings.push(deadline);
        },
        onStateChanged(nextState) {
            state = nextState;
        },
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    fixture.controller = controller;
    Object.defineProperty(fixture, 'state', {get: () => state});
    return fixture;
}

class FakeClient {
    constructor(disableProfiles) {
        this.activeProfile = 'work';
        this.cancelled = false;
        this.connectCalls = 0;
        this.connectedProfiles = [];
        this._disableProfiles = disableProfiles;
    }

    disconnect() {
        return Promise.resolve();
    }

    switchProfile() {
        return this.switchError ? Promise.reject(this.switchError) : Promise.resolve();
    }

    connect(profileId) {
        this.connectCalls++;
        this.connectedProfiles.push(profileId);
        return Promise.resolve();
    }

    destroy() {
        this.cancelled = true;
    }

    features() {
        return Promise.resolve({disableProfiles: this._disableProfiles});
    }

    profiles() {
        return Promise.resolve({
            activeProfile: this.activeProfile === 'work' ? 'Work' : 'Home',
            profiles: [
                {id: 'work', isActive: this.activeProfile === 'work', name: 'Work'},
                {id: 'home', isActive: this.activeProfile === 'home', name: 'Home'},
            ],
        });
    }

    subscribeStatus(onStatus) {
        this.emitStatus = onStatus;
    }
}

for (const [name, test] of tests) {
    try {
        await test();
        print(`ok ${name}`);
    } catch (error) {
        printerr(`not ok ${name}: ${error}`);
        throw error;
    }
}

function snapshot(state) {
    return {
        connected: state === 'Connected',
        daemonVersion: '0.80.0',
        localPeer: {fqdn: '', ipv4: '', ipv6: ''},
        networksRevision: 0,
        peers: [],
        sessionExpiresAt: 0,
        state,
    };
}
