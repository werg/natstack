# Panel System Overview

NatStack panels are dynamically loaded TypeScript apps that run in isolated webviews. Panels navigate to each other via URL-based navigation.

## Panel Structure

```
my-panel/
├── package.json      # Manifest with natstack field (required)
├── index.tsx         # Entry point
├── contract.ts       # Optional: RPC contract for typed parent communication
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
    "title": "My Panel",
    "entry": "index.tsx",
    "repoArgs": ["history"],
    "exposeModules": ["@radix-ui/colors"],
    "injectHostThemeVariables": true
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
| `title` | string | **Required** | Display name |
| `entry` | string | `index.tsx` | Entry point file |
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

  // Navigation
  buildPanelLink,        // Build URL for panel navigation
  contextIdToSubdomain,  // Convert context ID to subdomain string

  // Parent communication
  parent,                // ParentHandle (noop if root)
  getParent,             // Get typed parent handle
  getParentWithContract, // Get contract-typed parent
  noopParent,            // Safe fallback for null parent

  // RPC
  rpc,                   // RPC bridge for expose/events

  // Services
  db,                    // SQLite database access
  fs,                    // Filesystem (RPC-backed or Node.js)
  fsReady,               // Promise that resolves when fs ready

  // Configuration
  gitConfig,             // Git server config
  pubsubConfig,          // PubSub config
  env,                   // Environment variables (Record<string, string>)
  bootstrapPromise,      // Resolves when repoArgs cloned

  // Lifecycle
  closeSelf,             // Close this panel
  getInfo,               // Get panel info
  getTheme,              // Get current theme
  onThemeChange,         // Subscribe to theme changes
  onFocus,               // Subscribe to focus events

  // Utilities
  parseContextId,        // Parse context ID components
} from "@workspace/runtime";
```

## Navigation

Panels navigate to other panels using URL-based navigation with `buildPanelLink`.

### Same-context navigation

Navigate to another panel within the same context:

```typescript
import { buildPanelLink } from "@workspace/runtime";

// Navigate to the chat panel in the current context
window.location.href = buildPanelLink("panels/chat");
```

### Cross-context navigation

Navigate to a panel in a different context by providing a `contextId`:

```typescript
import { buildPanelLink } from "@workspace/runtime";

// Navigate to a panel in a specific context
window.location.href = buildPanelLink("panels/chat", { contextId: "abc-123" });
```

`buildPanelLink` returns a relative path for same-context navigation and an absolute URL (with the context subdomain) when `contextId` is provided.

The `contextIdToSubdomain` utility (exported from `@workspace/runtime`) converts a context ID into the subdomain string used in cross-context URLs.

## ParentHandle Methods

```typescript
parent.id                         // Parent's ID
parent.call.method(args)          // Call parent's RPC method
parent.emit("event", payload)     // Emit event to parent
parent.onEvent("event", handler)  // Listen for parent events
```

## Typed RPC Contracts

Define contracts for type-safe parent communication:

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

A panel exposes methods and communicates with its parent using the contract:

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

## Context & Storage

Panels have isolated storage based on their context ID:

- **Default**: `ctx_{instanceId}` -- server-side context folder per panel
- **Shared**: Panels sharing the same `contextId` share storage

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
