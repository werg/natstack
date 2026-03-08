# Panel System Reference

NatStack panels are TypeScript apps running in isolated webviews.

## Manifest (`package.json`)

```json
{
  "name": "@workspace-panels/my-panel",
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

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `title` | string | package name | Display name |
| `entry` | string | `index.tsx` | Entry point |
| `sourcemap` | boolean | `true` | Include inline source maps |
| `externals` | Record | `{}` | Import map entries (externalized from bundle) |
| `exposeModules` | string[] | `[]` | Modules registered on `__natstackModuleMap__` |
| `dedupeModules` | string[] | `[]` | Additional packages to deduplicate |
| `shell` | boolean | `false` | Grants shell service access (about pages) |
| `hiddenInLauncher` | boolean | `false` | Hide from launcher UI |

## Runtime API

```typescript
import {
  // Identity
  id, parentId, contextId,

  // Parent
  parent, getParent, getParentWithContract, noopParent,

  // RPC
  rpc,

  // Services
  db, fs, ai, gitConfig, pubsubConfig, env,

  // Lifecycle
  closeSelf, focusPanel, getInfo, getTheme, onThemeChange, onFocus, exposeMethod,
  onConnectionError,

  // Git utilities
  getWorkspaceTree, listBranches, listCommits,

  // Navigation
  buildPanelLink, contextIdToSubdomain,

  // Utilities
  parseContextId, isValidContextId, getInstanceId,
  normalizePath, getFileName, resolvePath,
  getStateArgs, useStateArgs, setStateArgs,
} from "@workspace/runtime";
```

## Navigation

Panels navigate via URLs, not RPC calls:

```typescript
import { buildPanelLink } from "@workspace/runtime";

// Same-context navigation (relative URL, stays on current subdomain)
window.location.href = buildPanelLink("panels/editor");

// Cross-context navigation (absolute URL, different subdomain)
window.location.href = buildPanelLink("panels/chat", {
  contextId: "abc-123",
  stateArgs: { channelName: "general" },
});

// Open in new tab
window.open(buildPanelLink("panels/editor"));
```

## Git Utilities

```typescript
import { getWorkspaceTree, listBranches, listCommits } from "@workspace/runtime";

// Get workspace directory tree (nodes have name, path, isGitRepo, launchable, packageInfo)
const tree = await getWorkspaceTree();

// List branches: [{ name: "main", current: true }, ...]
const branches = await listBranches("panels/editor");

// List commits (default: HEAD, limit 50): [{ oid, message, author: { name, timestamp } }]
const commits = await listCommits("panels/editor", "main", 20);
```

## Connection Error Handling

```typescript
import { onConnectionError } from "@workspace/runtime";

const unsubscribe = onConnectionError((error) => {
  // error: { code: number, reason: string, source?: "electron" | "server" }
  console.error(`Connection error [${error.code}]: ${error.reason}`);
});
```

Fires on terminal auth failures (invalid token, bad handshake). Not on normal disconnects.

## Context & Storage

Panels have isolated storage based on context ID:

- **Default**: `ctx_{instanceId}` — server-side context folder per panel
- **Shared**: Navigate with `contextId` to share storage between panels

## Workspace Packages

| Scope | Location |
|-------|----------|
| `@workspace/*` | `workspace/packages/` |
| `@workspace-panels/*` | `workspace/panels/` |
| `@workspace-about/*` | `workspace/about/` |
| `@workspace-agents/*` | `workspace/agents/` |

## Related Docs

- [PANEL_DEVELOPMENT.md](PANEL_DEVELOPMENT.md) - Practical guide
- [RPC.md](RPC.md) - Typed contracts
- [TOOLS.md](TOOLS.md) - Agent tools
