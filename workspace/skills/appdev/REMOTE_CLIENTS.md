# Remote Clients And Pairing

NatStack remote clients use device credentials and short-lived principal grants.
Apps that help connect other clients need the `connection-management`
capability.

## Concepts

| Concept           | Purpose                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| Pairing invite    | One-time bootstrap material: server URL plus pairing code                 |
| Device credential | Long-lived device id plus refresh token, stored by the client/native host |
| Shell token       | Desktop remote shell token refreshed from a device credential             |
| Principal grant   | Short-lived grant scoped to one app/runtime principal                     |
| Connection info   | Server URL and public connection metadata                                 |

## Desktop Remote Shell

Desktop remote startup can use:

- admin token bootstrap
- device credential bootstrap
- hybrid admin + device bootstrap

Device bootstrap refreshes a shell token through `/auth/refresh-shell`. If the
device credential is revoked or expired, desktop startup should recover by
falling back to local mode or asking for re-pairing rather than leaving the app
dead.

`pnpm start:remote --pair "natstack://connect?url=...&code=..."` exchanges a
pairing invite, stores a CLI device credential, and launches Electron against
the remote server.

## Mobile Client

Mobile native host stores a device credential and requests a principal grant for
the React Native app:

```json
{
  "principal": "react-native-app"
}
```

The resulting caller id is device-scoped, for example:

```text
app:apps/mobile:<device-id>
```

For workspaces with more than one React Native app, the selected mobile source
is supplied to pairing, bundle bootstrap, and principal-grant refresh:

```json
{
  "principal": "react-native-app",
  "source": "apps/field-mobile"
}
```

That yields a source-scoped caller id such as:

```text
app:apps/field-mobile:<device-id>
```

The native host persists the selected source alongside the activated bundle so
future reconnects refresh grants for the same app. If no source is supplied,
the server keeps the legacy fallback behavior: prefer the active `apps/mobile`
React Native app, or the only active React Native app when there is exactly one.

The workspace app should use that principal grant for RPC. It should not store
or handle the refresh token directly in JS.

## Terminal Client

The terminal target produces a Node ESM entry and the server can launch it as a
supervised app process. A terminal remote client should:

- connect over `/rpc` with the runner-provided principal grant
- use app identity and manifest capabilities for privileged calls
- create pairing invites with `auth.createPairingInvite` only when it has
  `connection-management`
- parse or accept pairing invites when acting as an external CLI client
- call `/auth/complete-pairing` for external device bootstrap flows
- store external device credentials in CLI/user config, not in trusted app
  bundle state

The built-in `@workspace-apps/remote-cli` is the canonical terminal app shape:
it connects as an app principal, lists workspace status, and can mint a pairing
invite for another client. It is declared in the template so it is available for
server pairing/debugging, but it stays dormant until the shell UI or
`workspace.units.restart("@workspace-apps/remote-cli")` starts it.

Fresh workspaces created from the product template trust their initial declared
app/extension set during startup. Later meta pushes, capability changes, source
changes, dependency changes, and target changes still go through the normal unit
approval path.

## Pairing Invite Creation

An app caller needs `connection-management` to call `auth.createPairingInvite`.
Host callers can be allowed explicitly at the auth service call site.

Do not grant `connection-management` to arbitrary apps. It lets the app mint
new client bootstrap material.

## URL And Transport Rules

- Cleartext HTTP is allowed only for trusted local/private/Tailscale-style
  hosts.
- Prefer HTTPS public URLs for mobile OAuth and app-link/universal-link flows.
- `natstack://connect` is for pairing bootstrap, not OAuth callbacks.
- Mobile OAuth callbacks should use verified app-link/universal-link routes
  where configured.

## Recovery And UX

Remote-client UX should handle:

- revoked device credential
- stale server boot id
- server URL change
- TLS fingerprint or CA mismatch
- no active mobile app bootstrap
- terminal app build available but process not started
- terminal app process exited or failed WebSocket auth

The recovery surface should remain usable even when the workspace app cannot be
loaded.

## Operational Debugging

When testing pairing or remote-server state without a shell UI:

1. Start the server with `--ready-file` and read `gatewayUrl` plus
   `adminToken`.
2. Use `scripts/natstack-admin.mjs approvals list` to inspect pending trusted
   unit approvals.
3. Use `scripts/natstack-admin.mjs approvals approve version` only for local
   trusted-template/dev scenarios where the unit set is expected.
4. Use `scripts/natstack-admin.mjs units list` to inspect active build keys and
   lifecycle states.
5. Use `scripts/natstack-admin.mjs units restart <app>` for terminal apps.
6. Use `scripts/natstack-admin.mjs units logs <app>` to inspect stdout/stderr
   and runner errors.
