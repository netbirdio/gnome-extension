# JSON API test coverage

The automated contract suite exercises every NetBird daemon method called by
the extension. It uses a real Unix-domain socket and HTTP/1.1 bytes, with a
small in-process daemon fixture. Requests are checked after JSON decoding and
responses pass through the production transport and normalization code.
The 21 method contracts were checked against NetBird
[`v0.77.0` `daemon.proto`](https://github.com/netbirdio/netbird/blob/v0.77.0/client/proto/daemon.proto)
(SHA-256 `325554187c103f46be58cdbf835ae0877f492d45370c57489afff931e049f89e`).

Run it with:

```sh
gjs -m tests/api.test.js
gjs -m tests/settings-controller.test.js
gjs -m tests/status-controller.test.js
```

This currently runs 112 isolated cases: 93 transport, contract, and model cases,
11 Settings-controller readback, policy, recovery, and lifecycle cases, and eight
Shell-controller policy, profile, and session cases. On an enrolled test guest, run the basic
reversible production-daemon checks with:

```sh
NETBIRD_LIVE_MUTATIONS=1 gjs -m tests/live-api.test.js
```

The exhaustive, reversible production-daemon matrix is intentionally separate
because it creates a disposable profile and changes live configuration. Give it
a user-readable secret file that is outside the source tree:

```sh
NETBIRD_LIVE_FULL=1 \
NETBIRD_TEST_MANAGEMENT_URL=https://management.example.com \
NETBIRD_TEST_SETUP_KEY_FILE=/run/user/1000/netbird-test-key \
gjs -m tests/live-features.test.js
```

The full matrix records the active profile, connection state, settings, and
route selection before changing anything. Each change is read back, restored in
a guaranteed cleanup path, and read back again. The disposable peer is logged
out and its profile is removed before the original profile and connection state
are restored.

| Method | Feature and covered cases |
| --- | --- |
| `Status` | Exact full-status request, all connection states, active profile lookup, version floor, local peer, peers, traffic, latency, handshake, networks revision, session expiry, malformed/default values |
| `SubscribeStatus` | Exact request, multiple snapshots, cancellation, daemon error frame, invalid JSON, invalid frame, non-chunked response, and unexpected completion |
| `Up` | Named profile, omitted profile, asynchronous flag, current username, cancellable, and Unicode JSON byte length |
| `Down` | Empty request, cancellable, and immediate client-side state |
| `GetActiveProfile` | Profile-name extraction and missing/default values through `Status` |
| `GetConfig` | Profile and username request plus every setting consumed by the UI |
| `SetConfig` | Partial update and every setting emitted by the UI, including explicit false/empty-capable protobuf fields |
| `ListNetworks` | Empty request, domains, resolved-IP map, selection, IPv4/IPv6 exit-node detection, and malformed/default values |
| `SelectNetworks` | Append, replace, explicit IDs, and all-networks modes |
| `DeselectNetworks` | Explicit IDs and all-networks modes |
| `ListProfiles` | Username request, IDs, active selection, no-active result, and unusable-entry filtering |
| `AddProfile` | Exact request, response ID, cancellable, Unicode-safe transport, and blank-name rejection |
| `RenameProfile` | Handle/new-name request and validation of both names |
| `RemoveProfile` | Exact request, response ID, cancellable, and blank-name rejection |
| `SwitchProfile` | Exact request, resolved response ID, active-profile result, cancellable, and blank-name rejection |
| `Logout` | Named and omitted profiles plus cancellable |
| `Login` | SSO response, setup-key response, self-hosted management URL, hostname, omitted optionals, and desktop-client marker |
| `WaitSSOLogin` | Exact device-code request, email response, and missing-code rejection |
| `GetFeatures` | Every daemon policy flag and protobuf truth-value normalization |
| `DebugBundle` | Defaults, every exposed option, result fields, cancellable, and close-delimited response |
| `TriggerUpdate` | Success, daemon refusal/error text, and cancellable |

## Live NetBird 0.80.0 results

Run on 2026-10-09 against a self-hosted NetBird 0.80.0 network (combined
server with the embedded IdP, an exit node, and a network with subnet and
domain resources), from a Fedora 44 / GNOME 50.5 guest:

- `live-api.test.js` with mutations: 11/11 pass.
- `live-features.test.js` full matrix: 47/47 pass. Quantum resistance
  (`rosenpassEnabled`) and its permissive mode are checked separately.
- `SetConfig.lazyConnectionEnabled` returns success without being applied:
  since 0.77 the client decides lazy mode from `NB_LAZY_CONN`/MDM and the
  management account settings, not from the profile config. The extension no
  longer offers the setting, and the matrix no longer checks it.
- `DebugBundle` uploads only to NetBird's default upload service without
  privileges; it returns `uploadedKey`, or `uploadFailureReason` with the local
  `path` still set.
- `RequestExtendAuthSession` and `WaitExtendAuthSession` renew an SSO session in
  the browser while the tunnel stays up; `Status.sessionExpiresAt` carries the
  deadline while connected and is cleared once the session has expired.
- Interactive SSO uses the browser (PKCE) flow, whose `Login` response has no
  user code; `WaitSSOLogin` must be called with an empty `userCode`, which also
  starts the daemon's `localhost:53000` redirect listener.
- `ListNetworks` returns HTTP 500 `not connected` whenever the engine is not
  running (Idle, NeedsLogin), so callers must not treat it as a daemon failure.
- An expired peer login is reported as `NeedsLogin`, not `SessionExpired`,
  unless the client waited on a synchronous `Up` (and then only once). The
  extension treats `NeedsLogin` as expired when the management error says the
  login expired or the session deadline has passed.
- The PKCE redirect listener fails the whole sign-in on the first request with
  a mismatched `state`, so a browser reloading an old `localhost:53000` URL
  breaks a new sign-in (seen with Firefox session restore).

## Live NetBird 0.77.0 results

The full matrix was run against NetBird 0.77.0 on Ubuntu 24.04.4 / GNOME 46.0
and Fedora 44 / GNOME 50.4. Both guests produced the same result:

- `Status`, active-profile lookup, `ListProfiles`, `GetConfig`, `GetFeatures`,
  and streamed `SubscribeStatus`: pass.
- 22 of the 23 Settings fields behaved correctly: mutable fields were accepted,
  read back, and restored, while daemon-protected fields returned the expected
  structured privilege refusal. Protected pre-shared-key data was never
  overwritten.
- `ListNetworks`, `SelectNetworks`, and `DeselectNetworks`: pass with original
  selection restored.
- `DebugBundle`, `TriggerUpdate`, and the invalid-code error path of
  `WaitSSOLogin`: pass.
- disposable `AddProfile`, `RenameProfile`, `SwitchProfile`, setup-key `Login`,
  `Up`, `Logout`, and `RemoveProfile`: pass; cleanup and original-profile
  restoration pass.
- reversible `Down` -> `Idle` -> `Up` -> `Connected`: pass.
- `SetConfig.lazyConnectionEnabled`: NetBird returned success but `GetConfig`
  remained `false`, including after a disconnect/reconnect. This is a reproduced
  NetBird 0.77.0 daemon behavior on both distributions, not a transport or UI
  parsing failure.

The Settings controller has a regression test for that exact silent-no-op case.
It verifies every write using a fresh `GetConfig`, restores the visible row, and
shows `Setting Could Not Be Saved` if the daemon does not apply the value.

Transport coverage applies to all unary methods: required method/path/headers,
UTF-8 content length, content-length and chunked responses, chunk precedence,
connection-close framing, empty messages, invalid JSON, malformed status and
chunk lines, truncated and oversized bodies, HTTP errors, structured
`PRIVILEGE_REQUIRED` details, missing sockets, timeouts, and cancellation.

The isolated 99-case suite deliberately uses non-secret test placeholders. It
never contacts a management server and cannot alter an enrolled NetBird peer.
