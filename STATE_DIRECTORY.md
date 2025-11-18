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

## Panel Build Artifacts

In addition to the cache directory, each panel directory contains a `.natstack/` subdirectory with:

- `bundle.js` - Compiled and bundled JavaScript
- `node_modules/` - Panel-specific dependencies (if any)

These are **NOT** stored in the state directory because:
1. They should live alongside the panel source for quick iteration during development
2. They're specific to each panel's location
3. They can be easily regenerated from source

## Fallback Behavior

If the platform-specific directory cannot be accessed (e.g., permissions issues), NatStack falls back to:

```
<current-working-directory>/.natstack/
```

This ensures the app continues to work even in restricted environments.

## Implementation

See [`src/main/paths.ts`](src/main/paths.ts) for the implementation details.
