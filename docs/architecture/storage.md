# Storage Architecture

NatStack has one durable SQL primitive: workerd Durable Object storage. User
code that needs persistence should own a Durable Object and use `this.sql`
inside that object. There is no userland database RPC service and no native
SQLite module in the host process.

## Durable Object SQL

Every DO gets a private SQLite database from workerd. Schema ownership stays
inside the DO class:

- `createTables()` creates the current schema with `CREATE TABLE IF NOT EXISTS`.
- `schemaVersion` declares the target schema version.
- `migrate(fromVersion, toVersion)` runs after `createTables()` and before the
  version row is updated.

The host stores DO SQLite files under:

```text
<statePath>/.databases/workerd-do/<source_class_unique_key>/<object_hash>.sqlite
```

## Internal NatStack DOs

Framework-owned storage is implemented as internal DO classes in
`src/server/internalDOs/`, registered with source `natstack/internal`.

| Class | Service | Object key | Owns |
|---|---|---|---|
| `ScopeStoreDO` | `scope` | `global` | `repl_scopes` |
| `WebhookStoreDO` | `webhookIngress` | `global` | `webhook_ingress_subscriptions` |
| `PanelStoreDO` | `panel-persistence` | workspace id | `panels`, `panel_search_metadata`, `panel_fts` |
| `BrowserDataDO` | `browser-data` | `global` | bookmarks, history, history FTS, passwords, cookies, autofill, permissions, import log |

`PanelStoreDO` and `BrowserDataDO` use FTS5 in workerd. Tests that assert FTS
behavior run against real workerd, not the `sql.js` unit harness.

## Registration Channel

`src/server/internalDOs/internalDoLoader.ts` bundles the internal DO entrypoint
with esbuild and gives it a stable content hash. `WorkerdManager` treats
`natstack/internal` as a reserved source, registers those classes alongside
workspace DO classes, and skips public route registration for them.

To add another internal store:

1. Add the DO class under `src/server/internalDOs/`.
2. Export it from `src/server/internalDOs/index.ts`.
3. Add the class name to `INTERNAL_DO_CLASSES`.
4. Add a server service that dispatches to `{ source: INTERNAL_DO_SOURCE, className, objectKey }`.
5. Add workerd-backed tests for any storage feature that depends on workerd extensions.

## Trusted Bridge Identity

Electron main connects to the server with the admin token, but renderer calls
must retain the renderer's caller identity for service policy checks. The
WebSocket RPC envelope supports `forwardedIdentity: { callerId, callerKind }`.
`RpcServer` honors it only on admin-authenticated connections.

This lets shell renderers call shell-only server methods through Electron's
trusted bridge while preventing workers or panels from forging shell identity.
`browser-data` relies on this: sensitive methods such as password, cookie, and
history reads remain method-level shell-only policies.

## External SQLite Input

Browser importers still read Chrome, Firefox, and Safari profile SQLite files
from disk, but they do it with `sql.js` in read-only mode. Imported data is
persisted by the server-side `browser-data` service into `BrowserDataDO`.
