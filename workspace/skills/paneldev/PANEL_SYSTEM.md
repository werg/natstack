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
| `template` | string | `"default"` | Workspace template name (see below) |
| `sourcemap` | boolean | `true` | Include inline source maps |
| `externals` | Record | `{}` | Import map entries (externalized from bundle) |
| `exposeModules` | string[] | `[]` | Modules registered on `__natstackModuleMap__` |
| `dedupeModules` | string[] | `[]` | Additional packages to deduplicate |
| `shell` | boolean | `false` | Grants shell service access (about pages) |
| `hiddenInLauncher` | boolean | `false` | Hide from launcher UI |

## Workspace Templates

The `template` field in the natstack config selects a workspace template from `workspace/templates/{name}/`. Each template provides a `template.json` (framework config) and an `index.html` (HTML shell).

The `"default"` template (`workspace/templates/default/`) provides React + Radix UI and is used when no `template` is specified. Most panels should use the default. The template defines the framework, so panels do not need a separate `framework` field.

Alternative templates (e.g., Svelte) can be used by setting the `template` field and adding the corresponding runtime package (e.g., `@workspace/svelte`).

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
  db, fs, ai, workers, workspace, gitConfig, pubsubConfig, env,

  // Lifecycle
  closeSelf, focusPanel, getInfo, getTheme, onThemeChange, onFocus, exposeMethod,
  onConnectionError,

  // Git utilities
  getWorkspaceTree, listBranches, listCommits,

  // Navigation
  openPanel, buildPanelLink, contextIdToSubdomain,

  // Utilities
  parseContextId, isValidContextId, getInstanceId,
  normalizePath, getFileName, resolvePath,
  getStateArgs, useStateArgs, setStateArgs,

  // Browser panels
  createBrowserPanel, openExternal, onChildCreated, getBrowserHandle,
} from "@workspace/runtime";
export type { BrowserHandle } from "@workspace/runtime";
```

## Navigation

Use `openPanel` to open panels. It handles both URLs (browser panels) and workspace sources:

```typescript
import { openPanel } from "@workspace/runtime";

// Open a workspace panel
await openPanel("panels/editor");

// Open with stateArgs
await openPanel("panels/chat", { stateArgs: { channelName: "general" } });

// Open a URL as a browser panel
await openPanel("https://github.com");
```

For in-page navigation (replacing the current panel), use `buildPanelLink` + `window.location.href`:

```typescript
import { buildPanelLink } from "@workspace/runtime";

// Navigate this panel to a different source
window.location.href = buildPanelLink("panels/editor");

// Cross-context navigation (absolute URL, different subdomain)
window.location.href = buildPanelLink("panels/chat", {
  contextId: "abc-123",
  stateArgs: { channelName: "general" },
});
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

## Workspace Management

Panels can list, create, configure, and switch workspaces programmatically:

```typescript
import { workspace } from "@workspace/runtime";

// List all workspaces (sorted by last opened)
const workspaces = await workspace.list();
// => [{ name: "default", lastOpened: 1710000000000 }, ...]

// Get current workspace name
const name = await workspace.getActive();
// => "default"

// Get full entry (for metadata)
const active = await workspace.getActiveEntry();
// => { name: "default", lastOpened: 1710000000000 }

// Read workspace config (natstack.yml)
const config = await workspace.getConfig();
// => { id: "default", initPanels: [{ source: "panels/chat" }], git: { port: 63524 } }

// Create a new workspace (fork from current)
const entry = await workspace.create("experiment", { forkFrom: name });

// Set the init panels for this workspace
await workspace.setInitPanels([{ source: "panels/my-app" }]);

// Switch to a workspace (triggers app relaunch)
await workspace.switchTo("experiment");
```

### workspace.create Options

| Option | Type | Description |
|--------|------|-------------|
| `forkFrom` | string | Copy panels, packages, and agents from an existing workspace |

If no option is given, creates an empty workspace.

### workspace.setInitPanels

Updates `natstack.yml` safely, preserving all other config. The workspace `id` and `git` config are not writable via RPC.

### Restrictions

- Panels **cannot** delete workspaces — deletion is only available through the workspace switcher UI.
- `getConfig` and `setInitPanels` operate on the **active** workspace only — no cross-workspace access.

## Related Docs

- [PANEL_DEVELOPMENT.md](PANEL_DEVELOPMENT.md) - Practical guide
- [RPC.md](RPC.md) - Typed contracts
- [TOOLS.md](TOOLS.md) - Agent tools
