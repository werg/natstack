# Context Folders and Storage Partitions

This document explains how per-context filesystem storage works for NatStack panels.

## How Context Folders Work

Each panel gets a **context ID** that maps to a real directory on the server at
`{workspace}/.contexts/{contextId}/`. When a context folder is first accessed, the
server copies all workspace git repos into it (minus `.git/`, `node_modules/`,
`.cache/`, `.databases/`). Panel `fs` calls go through RPC to a sandboxed `FsService`
that operates on these folders using Node.js `fs/promises`.

```
Panel code  ->  fs shim  ->  RPC  ->  FsService  ->  Node.js fs (per-context folder)
```

## Context ID Format

```
ctx_{instanceId}
```

- **ctx_**: Prefix for all context IDs
- **instanceId**: Derived from the panel ID (with `/` and `:` replaced by `~`)

Example: `ctx_panels~editor`

Panels can also receive an explicit `contextId` via `CreateChildOptions.contextId`
to enable context sharing (multiple panels operating on the same folder).

## Getting Context Info

### From React

```tsx
import { usePanelPartition } from "@workspace/react";

function MyPanel() {
  const partition = usePanelPartition(); // string | null (loading)
  return <div>Context: {partition ?? "loading..."}</div>;
}
```

### From Runtime

```ts
import { getInfo, contextId } from "@workspace/runtime";

console.log(contextId);  // e.g. "ctx_panels~editor"
const { partition, contextId: cid } = await getInfo();
```

### Parsing Context IDs

```ts
import { parseContextId } from "@workspace/runtime";

const parsed = parseContextId("ctx_panels~editor");
// { mode: "safe", instanceId: "panels~editor" }
```

## Context Behavior by Panel Type

### App Panels (Default)

- Filesystem backed by server-side context folder
- Files visible on disk at `{workspace}/.contexts/{contextId}/`
- Storage is isolated per context ID
- Context ID format: `ctx_{instanceId}`

### Browser Panels

- Use default Electron session (for cookies/auth compatibility)
- Do not use context partitions

## Implementation Details

- Panels use `partition: persist:${contextId}` in Electron for browser-level storage (cookies, localStorage, IndexedDB)
- Context folders are created on-demand when first accessed
- Filesystem operations are sandboxed: path traversal and symlink escapes are rejected
- FileHandles have a 5-minute idle timeout and are cleaned up on panel disconnect
- Context folders persist across panel restarts; no automatic cleanup

## Security Considerations

- All fs operations are sandboxed to the context folder root
- Path traversal (`../../etc/passwd`) is rejected
- Symlinks pointing outside the sandbox are rejected
- FileHandle ownership is verified per panel — a panel cannot access another panel's open handles
- Context ID validation rejects unsafe characters (`/`, `\`, `..`, null bytes)
