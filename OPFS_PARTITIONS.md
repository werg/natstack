# OPFS and Partition Management

This document explains how Origin Private File System (OPFS) works with partitions in NatStack panels.

## What is OPFS?

OPFS (Origin Private File System) is a browser storage API that provides a private file system for web applications. It offers:
- Fast, efficient file storage
- Support for large files
- Async API with file handles
- Private to the origin (and partition in Electron)

## Partition-Based Storage Isolation

In NatStack, each webview can have its own storage partition, which determines what OPFS data it can access.

### Default Behavior (Isolated OPFS)

By default, each panel instance gets its own unique partition:
- Partition name: `persist:panel-${panel.id}`
- Each panel instance has completely isolated storage
- Files written by one panel instance are NOT accessible to other instances

**Example**: The default example panel uses isolated OPFS. If you launch multiple child panels, each one has its own separate file system.

### Shared OPFS Storage

There are three ways to configure OPFS partitions:

#### 1. Runtime Override (Highest Precedence)

When creating a child panel, specify the partition directly in the `createChild` call:

```typescript
// Launch a panel with a specific partition
await panelAPI.createChild("panels/example", {
  partition: "shared-storage",
  env: { /* optional env vars */ }
});

// Launch with only partition (no env vars)
await panelAPI.createChild("panels/shared-opfs-demo", {
  partition: "my-custom-partition"
});
```

#### 2. Manifest Partition (Medium Precedence)

Define a default partition in the panel's `panel.json`:

```json
{
  "title": "My Shared Panel",
  "entry": "index.tsx",
  "partition": "shared-storage",
  "dependencies": { ... }
}
```

#### 3. Auto-Generated Partition (Default/Lowest Precedence)

If no partition is specified, each panel instance gets a unique partition: `persist:panel-${panel.id}`

**Precedence Order:** Runtime override > Manifest partition > Auto-generated

All panels with the same partition name will share the same OPFS context, meaning:
- Files written by one panel are accessible to all other panels with the same partition
- Storage quota is shared across all panels in that partition
- Perfect for collaborative or data-sharing scenarios

## Usage Examples

### Writing to OPFS

```typescript
const root = await navigator.storage.getDirectory();
const fileHandle = await root.getFileHandle("example.txt", { create: true });
const writable = await fileHandle.createWritable();
await writable.write("Hello, OPFS!");
await writable.close();
```

### Reading from OPFS

```typescript
const root = await navigator.storage.getDirectory();
const fileHandle = await root.getFileHandle("example.txt");
const file = await fileHandle.getFile();
const text = await file.text();
console.log(text);
```

### Listing Files

```typescript
const root = await navigator.storage.getDirectory();
for await (const entry of root.values()) {
  console.log(`${entry.name} (${entry.kind})`);
}
```

### Deleting Files

```typescript
const root = await navigator.storage.getDirectory();
await root.removeEntry("example.txt");
```

## Demo Panels

### 1. Example Panel (Isolated OPFS)
- Location: `panels/example/`
- Partition: Unique per instance (`persist:panel-${panel.id}`)
- Each instance has isolated storage
- Try launching multiple child panels and note they can't see each other's files

### 2. Shared OPFS Demo Panel
- Location: `panels/shared-opfs-demo/`
- Partition: `shared-storage` (defined in panel.json)
- All instances share the same OPFS
- Try launching multiple instances and see them share files!

## How to Test

### Test 1: Isolated OPFS (Default Behavior)
1. Start the app: `npm run dev`
2. In the example panel, click "Write to OPFS" to create a file
3. Click "Launch child panel (isolated)" - the child won't see the parent's file
4. Each panel has its own isolated storage

### Test 2: Shared Partition via Manifest
1. Click "Launch Shared OPFS Demo" (uses `"partition": "shared-storage"` in panel.json)
2. In the shared demo, click "Write Shared File"
3. Click "Launch Another Shared Panel" - the new panel CAN see the shared file!

### Test 3: Shared Partition via Runtime Override
1. In the main example panel, click "Launch child (shared partition)"
2. This launches an example panel but with partition override to "shared-storage"
3. Click "Write to OPFS" in the new panel
4. Go back to the Shared OPFS Demo panel
5. Click "List Shared Files" - you'll see files from both panels!
6. This demonstrates runtime override taking precedence over the default isolated behavior

## Implementation Details

### Webview Configuration

The partition is set on the `<webview>` tag in [PanelStack.tsx](src/renderer/components/PanelStack.tsx):

```tsx
<webview
  partition={panel.partition ? `persist:${panel.partition}` : `persist:panel-${panel.id}`}
  // ... other props
/>
```

### Panel Types

The partition field is defined in [panelTypes.ts](src/main/panelTypes.ts):

```typescript
export interface PanelManifest {
  // ...
  partition?: string; // Custom partition name for shared OPFS
}

export interface Panel {
  // ...
  partition?: string; // Custom partition name
}
```

### Panel API

The `createChild` method supports partition override in [panelApi.ts](src/panelRuntime/panelApi.ts):

```typescript
// New signature with options object
await panelAPI.createChild("panels/example", {
  env: { /* environment variables */ },
  partition: "shared-storage"  // Optional partition override
});

// Legacy signature still supported (just env vars)
await panelAPI.createChild("panels/example", {
  KEY: "value"
});
```

#### Inspecting Current Partition

Panels can inspect their current partition at runtime:

```typescript
// Get full panel info (currently just partition)
const info = await panelAPI.getInfo();
console.log(info.partition); // "shared-storage" or undefined

// Or get partition directly
const partition = await panelAPI.getPartition();
console.log(partition); // "shared-storage" or undefined (if isolated)
```

If `partition` is `undefined`, the panel is using an auto-generated isolated partition.

### IPC Handler

The main process handler in [panelManager.ts](src/main/panelManager.ts) implements partition precedence:

```typescript
// Partition precedence: runtime override > manifest > undefined (auto-generated)
const partition = partitionOverride ?? manifest.partition;
```

### Security Considerations

- Each partition is isolated at the Chromium level
- Partitions use persistent storage (data survives app restarts)
- OPFS is origin-private (not accessible to other origins)
- Context isolation and sandboxing are enabled for security

## Storage Location

OPFS data is stored in Electron's session partition directories:
- Linux: `~/.config/natstack/Partitions/persist_<partition-name>/`
- macOS: `~/Library/Application Support/natstack/Partitions/persist_<partition-name>/`
- Windows: `%APPDATA%\natstack\Partitions\persist_<partition-name>\`

## Use Cases

### Isolated Storage (Default)
- Independent panels that don't need to share data
- Privacy-sensitive applications
- Testing/development environments

### Shared Storage (Custom Partition)
- Collaborative panels that share data
- Multiple views of the same dataset
- Communication between related panels
- Shared caches or resources
