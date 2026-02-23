# OPFS and Storage Partitions

This document explains how Origin Private File System (OPFS) storage isolation works for NatStack panels.

## What is OPFS?

OPFS (Origin Private File System) is a browser storage API that provides a private file system for web applications. In Electron, OPFS is scoped to the **session partition**, so different partitions get different storage.

## Context ID Formats

NatStack uses two context ID formats:

### Safe Panels

```
safe_{instanceId}
```

- **safe_**: Prefix indicating a safe, sandboxed panel
- **instanceId**: Unique identifier for this instance (derived from panel ID)

Example: `safe_panels~editor`

### Unsafe Panels

```
unsafe_noctx_{instanceId}
```

- **unsafe_noctx_**: Prefix indicating an unsafe panel without OPFS
- **instanceId**: Unique identifier for this instance

Example: `unsafe_noctx_panels~terminal`

## Getting Context Info

### From React

```tsx
import { usePanelPartition } from "@workspace/react";

function MyPanel() {
  const partition = usePanelPartition(); // string | null (loading)
  return <div>Storage: {partition ?? "loading..."}</div>;
}
```

### From Runtime

```ts
import { getInfo, contextId } from "@workspace/runtime";

console.log(contextId);  // e.g. "safe_panels~editor"
const { partition } = await getInfo();
```

### Parsing Context IDs

```ts
import { parseContextId } from "@workspace/runtime";

const parsed = parseContextId("safe_panels~editor");
// { mode: "safe", instanceId: "panels~editor" }

const unsafe = parseContextId("unsafe_noctx_panels~terminal");
// { mode: "unsafe", instanceId: "panels~terminal" }
```

## Context Behavior by Panel Type

### Safe Panels (Default)

- Use OPFS for storage
- Storage is isolated per context partition
- Context ID format: `safe_{instanceId}`

### Unsafe Panels

- Use native Node.js filesystem
- Storage is in `context-scopes/` directory
- Context ID format: `unsafe_noctx_{instanceId}`

### Browser Panels

- Use default Electron session (for cookies/auth compatibility)
- Do not use context partitions

## Implementation Details

- Safe panels use `partition: persist:${contextId}` in Electron
- Context partitions are stored in `partitions/` directory

## Security Considerations

- Each context partition is isolated at the Chromium level
- Context mode (`safe`/`unsafe`) is encoded in the ID and validated
- Safe panels cannot use unsafe contexts (prevents privilege escalation)
- OPFS is origin-private and partition-private
- Context isolation and sandboxing are enabled for safe panels
