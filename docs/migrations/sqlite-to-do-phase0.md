# SQLite To Durable Objects Phase 0

## Trusted Bridge Audit

The server services reachable through `SERVER_SERVICE_NAMES` had shell-only
method policies that were sensitive to Electron main's admin-token bridge
identity. The relevant current services are:

| Service | Shell-only methods | Result |
|---|---|---|
| `browser-data` | password, cookie, history, autofill, and export methods | Requires an authenticated shell caller token |
| `workspace` | shell UI operations such as workspace selection | Requires an authenticated shell caller token |
| `git` | token-management helpers restricted to shell/server | Requires an authenticated shell or server caller token |

`RpcServer` rejects admin tokens for RPC and does not accept forwarded caller
identity on the WebSocket envelope. Tests cover admin-token rejection and worker
denial for shell-only `browser-data` methods.

## FTS5 Gate

FTS5 behavior is validated in workerd-backed tests:

- `PanelStoreDO` indexes panel metadata in `panel_fts` and returns search hits.
- `BrowserDataDO` indexes browser history in `history_fts` and returns search hits.

The lightweight `createTestDO` helper still uses `sql.js`, which is useful for
fast non-FTS unit tests but does not provide the production FTS5 extension.
FTS-dependent tests therefore use real workerd.

## Remote Server Follow-Up

Browser-data import currently assumes a single-host deployment: the server can
read browser profile paths from the same filesystem as Electron main. In a
future remote-server deployment, the browser profile lives on the Electron host,
not the remote server. That requires a host-callback primitive where the server
can request host-local profile reads from the trusted Electron bridge.
