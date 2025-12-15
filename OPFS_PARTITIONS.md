# OPFS and Storage Partitions

This document explains how Origin Private File System (OPFS) storage isolation works for NatStack **app panels**.

## What is OPFS?

OPFS (Origin Private File System) is a browser storage API that provides a private file system for web applications. In Electron, OPFS is scoped to the **session partition**, so different partitions get different storage.

## Partition Model in NatStack

- App panels run in their own Electron session partition: `persist:${panelId}`
- `@natstack/runtime` exposes a *logical* partition key via `getInfo()`:

```ts
import { getInfo } from "@natstack/runtime";

const info = await getInfo();
console.log(info.panelId);   // e.g. "tree/panels~root"
console.log(info.partition); // currently the same value as panelId
```

In other words: `getInfo().partition` is the key that NatStack uses to derive the Electron session partition (`persist:${partition}`).

## Default Behavior (Isolated Storage)

Child panels without an explicit `name` get auto-generated IDs that include a nonce, so they receive unique partitions and isolated OPFS.

```ts
import { createChild } from "@natstack/runtime";

// New panelId each time -> new partition -> isolated OPFS
await createChild({ type: "app", source: "panels/editor" });
```

## Shared Storage

NatStack intentionally does **not** support arbitrary “partition override” in `createChild(...)`. Instead, shared storage is achieved by making the **panel ID stable**, which makes the partition stable.

### 1) `singletonState: true` (Recommended for shared data panels)

Set `singletonState: true` in the panel’s `package.json` `natstack` manifest:

```json
{
  "natstack": {
    "title": "Shared OPFS Panel",
    "entry": "index.tsx",
    "singletonState": true
  }
}
```

This makes the panel ID stable (`singleton/<path>`) and all launches reuse the same partition (and therefore the same OPFS).

### 2) Provide `name` (Stable within a parent)

Providing `name` makes the child’s ID stable *within the same parent panel*:

```ts
await createChild({ type: "app", source: "panels/editor", name: "editor" });
```

This is useful when you want a stable partition across restarts for a specific child, but it does not allow two concurrent instances with the same name.

## Inspecting the Current Partition

From React:

```tsx
import { usePanelPartition } from "@natstack/react";

const partition = usePanelPartition(); // string | null (loading)
```

From plain runtime:

```ts
import { getInfo } from "@natstack/runtime";
const { partition } = await getInfo();
```

## Implementation Notes

- App panels are created with `partition: persist:${panelId}` in `src/main/panelManager.ts`.
- Browser panels do not use isolated partitions (they use the default session so cookies/auth can work like a normal browser).

## Security Considerations

- Each partition is isolated at the Chromium level
- Partitions use persistent storage (data survives app restarts)
- OPFS is origin-private (and partition-private)
- Context isolation and sandboxing are enabled for app panels

