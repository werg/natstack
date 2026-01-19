# OPFS and Storage Partitions

This document explains how Origin Private File System (OPFS) storage isolation works for NatStack **app panels**.

## What is OPFS?

OPFS (Origin Private File System) is a browser storage API that provides a private file system for web applications. In Electron, OPFS is scoped to the **session partition**, so different partitions get different storage.

## Context-Based Partition Model

NatStack uses **contexts** to determine storage partitions. Each context has a unique ID that maps to an Electron partition.

### Context ID Format

Context IDs follow the format: `{mode}_{type}_{identifier}`

- **mode**: `safe` | `unsafe` - security context of the panel
- **type**: `auto` | `named` - how the context was determined
- **identifier**: the context key (escaped tree path or random string)

Examples:
- `safe_auto_panels~editor` - auto-derived context for a safe panel
- `unsafe_auto_panels~terminal` - auto-derived context for an unsafe panel
- `safe_named_abc123` - explicitly named context

### Getting Context Info

From React:

```tsx
import { useContextId, usePanelPartition } from "@natstack/react";

const contextId = useContextId();  // e.g. "safe_auto_panels~root"
const partition = usePanelPartition(); // string | null (loading)
```

From plain runtime:

```ts
import { getInfo, contextId } from "@natstack/runtime";

console.log(contextId);  // e.g. "safe_auto_panels~root"
const { partition } = await getInfo();
```

## Default Behavior (Auto Contexts)

By default, panels derive their context from their full panel ID (tree path). **Named children** are deterministic and resumable - reopening the same panel tree gives you the same storage.

**Important**: Unnamed children include a random nonce in their panel ID, making their contexts non-resumable. Use `name` for resumable storage.

```ts
import { createChild } from "@natstack/runtime";

// Named child - deterministic, resumable context: safe_auto_panels~root~myeditor
await createChild("panels/editor", { name: "myeditor" });

// Unnamed child - random nonce in ID, NOT resumable (new context each time)
await createChild("panels/editor");
```

## Shared Contexts

To share storage between multiple panels, use explicit `contextId`:

```ts
// Both panels share the same context and OPFS storage
await createChild("panels/editor", { contextId: "safe_named_shared-workspace" });
await createChild("panels/preview", { contextId: "safe_named_shared-workspace" });
```

**Important**: Context mode must match the panel's security context. Safe panels cannot use `unsafe_*` contexts.

## Isolated Contexts

For panels that need fresh, isolated storage each time:

```ts
// Generates a unique context ID (e.g. safe_named_1a2b3c-abc123)
await createChild("panels/scratch", { newContext: true });
```

## Context Inheritance via URLs

Contexts can be passed through `ns://` URLs:

```ts
import { buildNsLink } from "@natstack/runtime";

// Create a link that shares the current context
const link = buildNsLink("panels/editor", { context: "safe_named_shared", action: "child" });
// Result: ns:///panels/editor?action=child&context=safe_named_shared
```

## Implementation Notes

- App panels are created with `partition: persist:${contextId}` in `src/main/panelManager.ts`
- Unsafe panels share filesystem scope with their context via `context-scopes/` directory
- Browser panels do not use isolated partitions (they use the default session so cookies/auth can work like a normal browser)

## Security Considerations

- Each context partition is isolated at the Chromium level
- Context mode (`safe`/`unsafe`) is encoded in the ID and validated
- Safe panels cannot use unsafe contexts (prevents privilege escalation)
- OPFS is origin-private and partition-private
- Context isolation and sandboxing are enabled for app panels
