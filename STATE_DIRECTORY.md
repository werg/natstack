# NatStack State Directory

## Location

NatStack uses platform-specific directories for storing application state, following OS conventions:

| Platform | Location |
|----------|----------|
| **Linux** | `~/.config/natstack/` |
| **macOS** | `~/Library/Application Support/natstack/` |
| **Windows** | `%APPDATA%\natstack\` |

These paths are managed by Electron's `app.getPath('userData')` API.

## Contents

### `panel-cache/`

Stores cached panel builds to avoid rebuilding panels when their source hasn't changed.

- `build-cache.json` - Metadata about cached builds (panel path, hash, timestamps)

**Size**: Grows with the number of unique panels you've loaded. Each panel typically uses a few KB.

**When to clear**:
- If you suspect stale/corrupt builds
- To force rebuild all panels
- To reclaim disk space

## Build Artifacts (`build-artifacts/`)

NatStack stores build outputs and dependency installs centrally under the NatStack state root:

- With an active workspace: `<workspace>/.cache/build-artifacts/`
- Otherwise: `<userData>/build-artifacts/` (usually `~/.config/natstack/build-artifacts/`)

This avoids creating build directories inside panel/worker repositories.

Typical contents:
- `panel/<id>/<commit>/deps/` - Per-panel dependency installs (`node_modules/`, `package.json`, lockfile)
- `worker/<id>/<commit>/deps/` - Per-worker dependency installs
- `git/<id>/temp-builds/` - Temporary git worktrees/checkouts used for versioned builds

## Fallback Behavior

If the platform-specific directory cannot be accessed (e.g., permissions issues), NatStack falls back to:

```
<os-config-dir>/natstack/  (or ultimately a temp directory)
```

This ensures the app continues to work even in restricted environments.

## Implementation

See [`src/main/paths.ts`](src/main/paths.ts) for the implementation details.
