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
| `title` | string | package name | Display name |
| `entry` | string | `index.tsx` | Entry point file |
| `template` | string | `"default"` | Workspace template name (see below) |
| `sourcemap` | boolean | `true` | Include inline source maps |
| `externals` | Record | `{}` | Import map entries (externalized from bundle) |
| `exposeModules` | string[] | `[]` | Modules registered on `__natstackModuleMap__` |
| `dedupeModules` | string[] | `[]` | Additional packages to deduplicate (react/react-dom always deduped) |
| `shell` | boolean | `false` | Grants shell service access (about pages) |
| `hiddenInLauncher` | boolean | `false` | Hide from launcher UI |

## Workspace Templates

The `template` field in the natstack config selects a workspace template from `workspace/templates/{name}/`. Each template provides a `template.json` (framework config) and an `index.html` (HTML shell).

The `"default"` template (`workspace/templates/default/`) provides React + Radix UI and is used when no `template` is specified. Most panels should use the default. The template defines the framework, so panels do not need a separate `framework` field.

Alternative templates (e.g., Svelte) can be used by setting the `template` field and adding the corresponding runtime package (e.g., `@workspace/svelte`).

## Core Runtime API

```typescript
import {
  // Identity
  id,                    // Current panel runtime entity ID
  entityId,              // Same current runtime entity ID
  slotId,                // Stable visible panel slot ID
  parentId,              // Parent's ID or null
  contextId,             // Storage context ID

  // Navigation
  buildPanelLink,        // Build URL for panel navigation

  // Panel handles and tree
  parent,                // Parent PanelHandle surface; operations fail loudly when root has no parent
  panelTree,             // Get/list/open/focus/drive any panel-tree member
  getPanelHandle,        // Get a PanelHandle by ID
  listPanels,            // List accessible panels
  getParent,             // Get typed parent PanelHandle or null
  getParentWithContract, // Get contract-typed parent PanelHandle or null

  // RPC
  rpc,                   // RPC bridge for expose/events

  // Services
  db,                    // SQLite database access
  fs,                    // Filesystem (RPC-backed)
  ai,                    // AI client (streaming text generation with tools)

  // Configuration
  env,                   // Environment variables (Record<string, string>)

  // Lifecycle
  focusPanel,            // Focus an existing panel by ID (does NOT open new panels)
  getInfo,               // Get panel info
  getTheme,              // Get current theme
  onThemeChange,         // Subscribe to theme changes
  onFocus,               // Subscribe to focus events
  expose,                // Expose RPC methods
  onConnectionError,     // Subscribe to RPC connection errors

  // Workspace/VCS utilities
  workspace,             // Workspace catalog, source tree, and unit helpers
  vcs,                   // GAD-native repo status/log/diff/commit operations

  // Utilities
  parseContextId,        // Parse context ID components
  isValidContextId,      // Validate context ID format
  getInstanceId,         // Extract instance ID from context ID

  // Path utilities
  normalizePath,         // Cross-platform path normalization
  getFileName,           // Extract file name from path
  resolvePath,           // Resolve relative paths

  // State args
  getStateArgs,          // Get panel state arguments
  useStateArgs,          // React hook for state arguments
  setStateArgs,          // Set panel state arguments

  // Panel navigation
  openPanel,             // Open any panel — URLs become browser panels, source paths open workspace panels
  buildPanelLink,        // Build URL for panel navigation (low-level — prefer openPanel)

  // External URLs
  openExternal,          // Open URL in system browser
  onChildCreated,        // Subscribe to child-created events (window.open flow)
} from "@workspace/runtime";
export type { PanelHandle } from "@workspace/runtime";
```

Use `slotId` for panel-tree operations and PubSub/channel client identity. Use
`id`/`entityId`/`rpc.selfId` only when you need the current live runtime entity;
that entity can change when a panel navigates or reopens in place.

`panelTree` is a top-level runtime export. Do not call
`workspace.panelTree`; the `workspace` namespace is for workspace catalog,
source-tree, and unit helpers, with only `workspace.openPanel` as a panel-opening
convenience.

## Navigation

Use `openPanel` to open panels. It handles both URLs (browser panels) and workspace sources:

```typescript
import { openPanel } from "@workspace/runtime";

await openPanel("panels/editor");                          // Open a workspace panel
await openPanel("panels/chat", { stateArgs: { ch: "x" }}); // With state args
await openPanel("https://github.com");                     // Open URL as browser panel
```

For in-page navigation (replacing the current panel), use `buildPanelLink` + `window.location.href`:

```typescript
import { buildPanelLink } from "@workspace/runtime";

// Same-context navigation (relative URL)
window.location.href = buildPanelLink("panels/chat");

// Cross-context navigation (absolute URL with contextId query parameter)
window.location.href = buildPanelLink("panels/chat", { contextId: "abc-123" });
```

`buildPanelLink` returns a relative path for same-context navigation and an absolute URL with `contextId` in the query string when `contextId` is provided.


## PanelHandle Methods

```typescript
const handle = panelTree.get("panel-id");

handle.id                         // Stable panel slot ID
await handle.refresh()            // Hydrate metadata for an existing slot
handle.call.method(args)          // Call exposed RPC method
handle.emit("event", payload)     // Emit event to the panel
handle.on("event", handler)       // Listen for events from the panel
handle.cdp.lightweightPage()      // Approval-gated CDP page access
handle.ensureLoaded()             // Explicit load for RPC/introspection
handle.close()                    // Approval-gated structural operation
```

Use `panelTree.get/list/roots/children` for existing panels;
`openPanel()`/`panelTree.open()` creates a new panel. Existing handles are
non-owned: do not navigate, reload, or close them unless requested; clean up
temporary panels opened by the workflow when it is done.

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
import { rpc, getParentWithContract } from "@workspace/runtime";
import { editorContract } from "./contract.js";

const parent = getParentWithContract(editorContract);

rpc.expose({
  async getContent() { return content; },
  async setContent(text) { setContent(text); },
});

await parent?.emit("saved", { path: "/file.txt" }); // Typed when a parent is present.
```

## Repo Utilities

Query workspace repo metadata through the workspace and VCS namespaces:

```typescript
import { workspace, vcs } from "@workspace/runtime";

// Get the full workspace source tree
const tree = await workspace.sourceTree();
// tree.children: WorkspaceNode[] — each node has name, path, isUnit,
//   launchable?: { title }, packageInfo?: { name, version }, children

// Resolve a source path to its owning repo
const owner = await workspace.findUnitForPath("panels/editor/src/index.tsx");
// { unitPath: "panels/editor", relativePath: "src/index.tsx" }

// Read recent GAD-native repo history
const history = await vcs.log("panels/editor", { limit: 50 });
```

## Connection Error Handling

Monitor RPC connection health:

```typescript
import { onConnectionError } from "@workspace/runtime";

const unsubscribe = onConnectionError((error) => {
  console.error(`Connection error [${error.code}]: ${error.reason}`);
  // error.source is "electron" or "server" when using dual transports
});

// Later: unsubscribe();
```

Fires on terminal WebSocket close codes (auth failures like invalid token or bad handshake). Does not fire on normal disconnects (e.g., panel closing).

## Context & Storage

Panels have isolated storage based on their context ID:

- **Default**: `ctx_{instanceId}` -- server-side context folder per panel
- **Shared**: Panels sharing the same `contextId` share storage

## Workspace Packages

Panels can share code via workspace packages:

| Scope | Location | Purpose |
|-------|----------|---------|
| `@workspace/*` | `workspace/packages/` | Shared utilities |
| `@workspace-panels/*` | `workspace/panels/` | Panel packages |
| `@workspace-about/*` | `workspace/about/` | About/shell panels |
| `@workspace-agents/*` | `workspace/agents/` | Agent packages |

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
- Cached by effective version (content hash + transitive dependency hashes)
- Build store: `{userData}/builds/{build_key}/`
- See [BUILD_SYSTEM.md](BUILD_SYSTEM.md) for full details
