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

## Blobstore (Content-Addressable Objects)

Bytes that don't fit a relational shape — large attachments, build artifacts,
the underlying object store for the workspace's git-replacement layer — live
in a per-workspace content-addressable filesystem store, separate from any DO.

The store is implemented by `blobstoreService` in
`src/server/services/blobstoreService.ts` and lives under the user-data
directory, **outside the workspace source tree**:

```text
<userData>/blobs/
  tmp/                          # incoming partial writes
  sha256/<aa>/<bb>/<rest>       # final objects, two-level fanout
```

`<userData>` is the per-workspace user-data dir resolved via `getUserDataPath()`
from `@natstack/env-paths` (see [STATE_DIRECTORY.md](../../STATE_DIRECTORY.md)).
Tmp leftovers are swept on service startup.

### API surface

The service publishes both an RPC contract and HTTP routes:

| Method | Kind | Auth / policy | Use |
|---|---|---|---|
| `PUT /_r/s/blobstore/blob` | HTTP | `caller-token` (panel/worker/shell/server) | Stream a body in; response `{ digest, size }`. Hash is computed while writing to a tmp file; `fs.link` then promotes to `sha256/<aa>/<bb>/<rest>`. EEXIST is a dedup hit. |
| `GET /_r/s/blobstore/blob/:digest` | HTTP | `caller-token` | Stream bytes out. Sets `Content-Length`, quoted `ETag: "<digest>"`, and `Cache-Control: immutable, max-age=31536000`. 404 on missing, 400 on malformed digest. |
| `blobstore.has(digest)` | RPC | panel/worker/shell/server | Existence check. |
| `blobstore.stat(digest)` | RPC | panel/worker/shell/server | `{ size, mtime } \| null`. |
| `blobstore.delete(digest)` | RPC | **shell/server only** | Caller-driven GC. Restricted to trusted callers — panels and workers cannot corrupt the store. |
| `blobstore.list({ prefix?, limit? })` | RPC | **shell/server only** | Enumerate digests; admin/debug. |

### Design properties

- **Per-workspace isolation.** Each workspace's user-data dir is a separate
  blob store. No cross-workspace dedup.
- **Algorithm in the path.** `sha256/` is part of the layout so additional
  algorithms can be introduced without migrating existing objects.
- **No refcounting / GC inside the store.** The reachability layer above
  (e.g. the git-replacement format) tracks what's live and calls `delete`
  to sweep. v1 has no automatic GC.
- **No verify-on-read.** Bytes are trusted from the FS. A future `verify`
  method can be added if the format above grows distrust.
- **Immutable from the caller's perspective.** Once written, a digest's bytes
  never change; clients can cache aggressively (we set `immutable`).

Auth threading uses the new `caller-token` mode on the route registry —
`TokenManager.validateToken()` accepts panel/worker/shell/server tokens but
**not** the admin token (admin is a separate, higher-privilege mode). See
[../routes.md](../routes.md#auth-model).

## Trusted Shell Identity

Electron main exchanges the admin token for a shell caller token before opening
RPC. Server policy checks use the authenticated WebSocket caller identity
directly; the wire protocol does not support caller-identity forwarding.

Shell-only methods remain restricted by method-level policies. `browser-data`
relies on this: sensitive methods such as password, cookie, and history reads
are available to shell callers, not panels or workers.

## External SQLite Input

Browser importers still read Chrome, Firefox, and Safari profile SQLite files
from disk, but they do it with `sql.js` in read-only mode. Imported data is
persisted by the server-side `browser-data` service into `BrowserDataDO`.
