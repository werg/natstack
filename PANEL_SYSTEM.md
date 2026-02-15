# Panel System Overview

NatStack panels are dynamically loaded TypeScript apps that run in isolated webviews. Each panel can spawn child panels, workers, and browser panels, forming a hierarchical tree.

## Panel Types

| Type | Description | Use Case |
|------|-------------|----------|
| `app` | UI panel built from source | Editors, dashboards, tools |
| `worker` | Background process with console UI | Long-running tasks, computations |
| `browser` | External URL with Playwright automation | Web scraping, testing |

## Panel Structure

```
my-panel/
├── package.json      # Manifest with natstack field (required)
├── index.tsx         # Entry point
├── contract.ts       # Optional: RPC contract for typed communication
└── style.css         # Optional: Styles
```

## Manifest (`package.json`)

```json
{
  "name": "@workspace-panels/my-panel",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "natstack": {
    "type": "app",
    "title": "My Panel",
    "entry": "index.tsx",
    "repoArgs": ["history"],
    "exposeModules": ["@radix-ui/colors"]
  },
  "dependencies": {
    "@workspace/runtime": "workspace:*",
    "@workspace/react": "workspace:*"
  }
}
```

### Manifest Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `"app"` \| `"worker"` | **Required** | Panel type |
| `title` | string | **Required** | Display name |
| `entry` | string | `index.tsx` | Entry point file |
| `unsafe` | boolean | `false` | Enable Node.js APIs (bypasses OPFS sandbox) |
| `repoArgs` | string[] | `[]` | Named repo slots for bootstrap |
| `exposeModules` | string[] | `[]` | Extra modules to bundle |
| `injectHostThemeVariables` | boolean | `true` | Inherit theme CSS variables |

## Core Runtime API

```typescript
import {
  // Identity
  id,                    // This panel's ID
  parentId,              // Parent's ID or null
  contextId,             // Storage context ID

  // Child management
  createChild,           // Create app/worker child
  createBrowserChild,    // Create browser child
  createChildWithContract, // Create with typed contract
  children,              // ReadonlyMap of children
  getChild,              // Get child by name
  onChildAdded,          // Subscribe to child additions
  onChildRemoved,        // Subscribe to child removals (close)

  // Parent communication
  parent,                // ParentHandle (noop if root)
  getParent,             // Get typed parent handle
  getParentWithContract, // Get contract-typed parent
  noopParent,            // Safe fallback for null parent

  // RPC
  rpc,                   // RPC bridge for expose/events

  // Services
  db,                    // SQLite database access
  fs,                    // Filesystem (OPFS or Node.js)
  fsReady,               // Promise that resolves when fs ready

  // Configuration
  gitConfig,             // Git server config
  pubsubConfig,          // PubSub config
  bootstrapPromise,      // Resolves when repoArgs cloned

  // Lifecycle
  closeSelf,             // Close this panel
  getInfo,               // Get panel info
  getTheme,              // Get current theme
  onThemeChange,         // Subscribe to theme changes
  onFocus,               // Subscribe to focus events

  // Utilities
  parseContextId,        // Parse context ID components
  isSafeContext,         // Check if safe mode
  isUnsafeContext,       // Check if unsafe mode
  buildNsLink,           // Build ns:// navigation link
} from "@workspace/runtime";
```

## Creating Children

```typescript
// App or worker (type from manifest)
const editor = await createChild("panels/editor", {
  name: "editor",           // Optional stable ID
  env: { FILE: "/foo.txt" }, // Environment variables
  gitRef: "main",           // Git ref for source
});

// Browser panel
const browser = await createBrowserChild("https://example.com");

// With typed contract
import { editorContract } from "@workspace-panels/editor/contract";
const editor = await createChildWithContract(editorContract, { name: "editor" });
```

### CreateChildOptions

| Option | Type | Description |
|--------|------|-------------|
| `name` | string | Stable ID within parent (omit for ephemeral) |
| `env` | Record<string, string> | Environment variables |
| `gitRef` | string | Git branch/tag/commit for source |
| `repoArgs` | Record<string, RepoArgSpec> | Repo arguments for bootstrap |
| `templateSpec` | string | Context template path |
| `contextId` | string | Explicit context ID for storage partition sharing |
| `unsafe` | boolean \| string | Node.js mode (workers only) |
| `sourcemap` | boolean | Emit sourcemaps (default: true) |
| `focus` | boolean | Focus after creation |

### Context ID for Storage Sharing

When multiple panels need to share the same OPFS/IndexedDB storage partition, pass the same `contextId` in options:

```typescript
// Generate or receive a shared context ID
const sharedContextId = crypto.randomUUID();

// Create chat panel with shared context
const chat = await createChild("panels/chat", {
  name: "chat",
  contextId: sharedContextId,  // Sets storage partition
}, {
  contextId: sharedContextId,  // Also pass in stateArgs for app logic
});

// Create worker with same context - shares storage with chat
const worker = await createChild("workers/agent", {
  name: "agent",
  contextId: sharedContextId,
}, {
  contextId: sharedContextId,
});
```

Note: `contextId` must be passed in both `options` (for storage partition) and `stateArgs` (for application logic) if your panel needs to know its context ID at runtime.

## ChildHandle Methods

```typescript
child.id          // Unique ID
child.name        // Name from creation
child.type        // "app" | "worker" | "browser"
child.source      // Panel path or URL

child.call.method(args)           // Call exposed RPC method
child.onEvent("event", handler)   // Listen for events
child.emit("event", payload)      // Emit event to child
child.close()                     // Close the panel

// Browser-specific
child.navigate(url)
child.goBack() / child.goForward()
child.reload() / child.stop()
child.getCdpEndpoint()            // For Playwright
```

## ParentHandle Methods

```typescript
parent.id                         // Parent's ID
parent.call.method(args)          // Call parent's RPC method
parent.emit("event", payload)     // Emit event to parent
parent.onEvent("event", handler)  // Listen for parent events
```

## Typed RPC Contracts

Define contracts for type-safe parent-child communication:

```typescript
// panels/editor/contract.ts
import { z, defineContract } from "@workspace/runtime";

export interface EditorApi {
  getContent(): Promise<string>;
  setContent(text: string): Promise<void>;
}

export const editorContract = defineContract({
  source: "panels/editor",
  child: {
    methods: {} as EditorApi,
    emits: {
      "saved": z.object({ path: z.string() }),
    },
  },
});
```

Child exposes methods:
```typescript
import { rpc, getParentWithContract, noopParent } from "@workspace/runtime";
import { editorContract } from "./contract.js";

const parent = getParentWithContract(editorContract) ?? noopParent;

rpc.expose({
  async getContent() { return content; },
  async setContent(text) { setContent(text); },
});

parent.emit("saved", { path: "/file.txt" }); // Typed!
```

Parent uses contract:
```typescript
import { createChildWithContract } from "@workspace/runtime";
import { editorContract } from "@workspace-panels/editor/contract";

const editor = await createChildWithContract(editorContract);
const text = await editor.call.getContent(); // Typed!
editor.onEvent("saved", ({ path }) => console.log(path)); // Typed!
```

## Context & Storage

Panels have isolated OPFS storage based on their context ID:

- **Safe panels**: `safe_tpl_{hash}_{instanceId}` — OPFS sandbox with optional template
- **Unsafe panels**: `unsafe_noctx_{instanceId}` — Real Node.js filesystem

Context templates pre-populate OPFS with git repos. Define in `context-template.yml`:

```yaml
extends: contexts/base
deps:
  /tools/search:
    repo: tools/web-search
    ref: main
```

## Workspace Packages

Panels can share code via workspace packages:

| Scope | Location | Purpose |
|-------|----------|---------|
| `@workspace-panels/*` | `workspace/panels/` | Panel packages |
| `@workspace-workers/*` | `workspace/workers/` | Worker packages |
| `@workspace/*` | `workspace/packages/` | Shared utilities |

Export contracts for cross-panel imports:
```json
{
  "exports": {
    ".": "./index.tsx",
    "./contract": "./contract.ts"
  }
}
```

## Build System

- Panels built on-demand with esbuild
- Cached by source file hash
- State directory: `~/.config/natstack/` (Linux), `~/Library/Application Support/natstack/` (macOS)
