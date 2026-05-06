# NatStack State Directory

## Location

NatStack uses platform-specific directories for storing application state, following OS conventions:

| Platform | Location |
|----------|----------|
| **Linux** | `~/.config/natstack/` |
| **macOS** | `~/Library/Application Support/natstack/` |
| **Windows** | `%APPDATA%\natstack\` |

These paths are determined by `getUserDataPath()` from `@natstack/env-paths`.

## Contents

### `builds/`

Content-addressed build store. Each build is stored immutably at `{userData}/builds/{build_key}/`:

```
{build_key}/
  ├── bundle.js
  ├── bundle.css      (panels/about only)
  ├── index.html      (panels/about only)
  ├── package.json    (agents only — {"type":"module"})
  ├── assets/         (chunks, images, fonts)
  └── metadata.json   (sentinel — kind, name, ev, sourcemap, builtAt)
```

The build key is a hash of `BUILD_CACHE_VERSION + unitName + effectiveVersion + sourcemap`. No LRU or TTL — garbage collection prunes entries not referenced by any active unit.

**When to clear**:
- If you suspect stale/corrupt builds
- To force rebuild all panels
- To reclaim disk space

### `build-artifacts/`

Stores external dependency installs (npm `node_modules`) for panels and agents, keyed by a hash of the merged dependency set.

### `context-scopes/`

Per-workspace, per-context filesystem scopes at `{userData}/context-scopes/{workspaceId}/{contextId}/`. Each context gets an isolated filesystem root.

### `.databases/workerd-do/`

The only SQLite files NatStack owns are workerd Durable Object databases:

```
.databases/
  workerd-do/
    natstack_internal:ScopeStoreDO/
      <object-hash>.sqlite
    natstack_internal:WebhookStoreDO/
      <object-hash>.sqlite
    natstack_internal:PanelStoreDO/
      <object-hash>.sqlite
    natstack_internal:BrowserDataDO/
      <object-hash>.sqlite
    <workspace-source>:<WorkspaceDOClass>/
      <object-hash>.sqlite
```

The internal stores are:

- `ScopeStoreDO` (`objectKey: "global"`) for REPL scope snapshots.
- `WebhookStoreDO` (`objectKey: "global"`) for webhook ingress subscriptions.
- `PanelStoreDO` (`objectKey: <workspaceId>`) for panel tree and panel FTS.
- `BrowserDataDO` (`objectKey: "global"`) for imported browser data.

Legacy host-owned SQLite files are removed on server startup. There are no
other NatStack-managed SQLite files outside `workerd-do/`.

### `ev-map.json`

Persisted effective version map — derived state, safe to delete (triggers full recompute on next startup).

### `ref-state.json`

Per-unit commit SHAs used for cold-start diffing. Compared against current refs to determine which units need EV recomputation.

## Fallback Behavior

If the platform-specific directory cannot be accessed (e.g., permissions issues), NatStack falls back to:

```
<os-config-dir>/natstack/  (or ultimately a temp directory)
```

This ensures the app continues to work even in restricted environments.

## Implementation

See [`src/main/paths.ts`](src/main/paths.ts) and
[`docs/architecture/storage.md`](docs/architecture/storage.md) for the
implementation details.
