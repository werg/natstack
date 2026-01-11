# OPFS and Storage Partitions

This document explains how Origin Private File System (OPFS) storage isolation works for NatStack **app panels**.

## What is OPFS?

OPFS (Origin Private File System) is a browser storage API that provides a private file system for web applications. In Electron, OPFS is scoped to the **session partition**, so different partitions get different storage.

## Session-Based Partition Model

NatStack uses **sessions** to determine storage partitions. Each session has a unique ID that maps to an Electron partition.

### Session ID Format

Session IDs follow the format: `{mode}_{type}_{identifier}`

- **mode**: `safe` | `unsafe` - security context of the panel
- **type**: `auto` | `named` - how the session was determined
- **identifier**: the session key (escaped tree path or random string)

Examples:
- `safe_auto_panels~editor` - auto-derived session for a safe panel
- `unsafe_auto_panels~terminal` - auto-derived session for an unsafe panel
- `safe_named_abc123` - explicitly named session

### Getting Session Info

From React:

```tsx
import { useSessionId, usePanelPartition } from "@natstack/react";

const sessionId = useSessionId();  // e.g. "safe_auto_panels~root"
const partition = usePanelPartition(); // string | null (loading)
```

From plain runtime:

```ts
import { getInfo, sessionId } from "@natstack/runtime";

console.log(sessionId);  // e.g. "safe_auto_panels~root"
const { partition } = await getInfo();
```

## Default Behavior (Auto Sessions)

By default, panels derive their session from their full panel ID (tree path). **Named children** are deterministic and resumable - reopening the same panel tree gives you the same storage.

**Important**: Unnamed children include a random nonce in their panel ID, making their sessions non-resumable. Use `name` for resumable storage.

```ts
import { createChild } from "@natstack/runtime";

// Named child - deterministic, resumable session: safe_auto_panels~root~myeditor
await createChild("panels/editor", { name: "myeditor" });

// Unnamed child - random nonce in ID, NOT resumable (new session each time)
await createChild("panels/editor");
```

## Shared Sessions

To share storage between multiple panels, use explicit `sessionId`:

```ts
// Both panels share the same session and OPFS storage
await createChild("panels/editor", { sessionId: "safe_named_shared-workspace" });
await createChild("panels/preview", { sessionId: "safe_named_shared-workspace" });
```

**Important**: Session mode must match the panel's security context. Safe panels cannot use `unsafe_*` sessions.

## Isolated Sessions

For panels that need fresh, isolated storage each time:

```ts
// Generates a unique session ID (e.g. safe_named_1a2b3c-abc123)
await createChild("panels/scratch", { newSession: true });
```

## Session Inheritance via URLs

Sessions can be passed through `natstack-child://` URLs:

```ts
import { buildChildLink } from "@natstack/runtime";

// Create a link that shares the current session
const link = buildChildLink("panels/editor", { sessionId: "safe_named_shared" });
// Result: natstack-child:///panels/editor?session=safe_named_shared
```

## Implementation Notes

- App panels are created with `partition: persist:${sessionId}` in `src/main/panelManager.ts`
- Unsafe panels share filesystem scope with their session via `session-scopes/` directory
- Browser panels do not use isolated partitions (they use the default session so cookies/auth can work like a normal browser)

## Security Considerations

- Each session partition is isolated at the Chromium level
- Session mode (`safe`/`unsafe`) is encoded in the ID and validated
- Safe panels cannot use unsafe sessions (prevents privilege escalation)
- OPFS is origin-private and partition-private
- Context isolation and sandboxing are enabled for app panels
