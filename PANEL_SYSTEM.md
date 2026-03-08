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
| `sourcemap` | boolean | `true` | Include inline source maps |
| `externals` | Record | `{}` | Import map entries (externalized from bundle) |
| `exposeModules` | string[] | `[]` | Modules registered on `__natstackModuleMap__` |
| `dedupeModules` | string[] | `[]` | Additional packages to deduplicate (react/react-dom always deduped) |
| `shell` | boolean | `false` | Grants shell service access (about pages) |
| `hiddenInLauncher` | boolean | `false` | Hide from launcher UI |

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
  fs,                    // Filesystem (RPC-backed)
  ai,                    // AI client (streaming text generation with tools)

  // Configuration
  gitConfig,             // Git server config
  pubsubConfig,          // PubSub config
  env,                   // Environment variables (Record<string, string>)

  // Lifecycle
  closeSelf,             // Close this panel
  focusPanel,            // Focus another panel by ID
  getInfo,               // Get panel info
  getTheme,              // Get current theme
  onThemeChange,         // Subscribe to theme changes
  onFocus,               // Subscribe to focus events
  exposeMethod,          // Expose RPC methods
  onConnectionError,     // Subscribe to RPC connection errors

  // Git utilities
  getWorkspaceTree,      // Get workspace directory tree with metadata
  listBranches,          // List branches for a repo (repoPath) → BranchInfo[]
  listCommits,           // List commits for a repo (repoPath, ref?, limit?) → CommitInfo[]

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

## Git Utilities

Query workspace repository metadata:

```typescript
import { getWorkspaceTree, listBranches, listCommits } from "@workspace/runtime";

// Get the full workspace directory tree
const tree = await getWorkspaceTree();
// tree.children: WorkspaceNode[] — each node has name, path, isGitRepo,
//   launchable?: { title }, packageInfo?: { name, version }, children

// List branches for a repo
const branches = await listBranches("panels/editor");
// [{ name: "main", current: true }, { name: "feature-x", current: false }]

// List recent commits (default: HEAD, limit 50)
const commits = await listCommits("panels/editor");
// [{ oid: "abc123...", message: "Fix bug", author: { name: "...", timestamp: 1709900000 } }]

// List commits on a specific branch with custom limit
const history = await listCommits("panels/editor", "feature-x", 10);
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
