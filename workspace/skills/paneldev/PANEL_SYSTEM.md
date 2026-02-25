# Panel System Reference

NatStack panels are TypeScript apps running in isolated webviews with parent-child hierarchy.

## Panel Types

| Type | Description |
|------|-------------|
| `app` | UI panel built from source |
| `worker` | Background process with console UI |
| `browser` | External URL with Playwright automation |

## Manifest (`package.json`)

```json
{
  "name": "@workspace-panels/my-panel",
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

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `"app"` \| `"worker"` | Required | Panel type |
| `title` | string | Required | Display name |
| `entry` | string | `index.tsx` | Entry point |
| `repoArgs` | string[] | `[]` | Named repo slots for bootstrap |
| `exposeModules` | string[] | `[]` | Extra modules to bundle |

## Runtime API

```typescript
import {
  // Identity
  id, parentId, contextId,

  // Children
  createChild, createBrowserChild, createChildWithContract,
  children, getChild, onChildAdded, onChildRemoved,

  // Parent
  parent, getParent, getParentWithContract, noopParent,

  // RPC
  rpc,

  // Services
  db, fs, fsReady, gitConfig, pubsubConfig, env,

  // Lifecycle
  closeSelf, getInfo, getTheme, onThemeChange, onFocus,
} from "@workspace/runtime";
```

## CreateChildOptions

| Option | Type | Description |
|--------|------|-------------|
| `name` | string | Stable ID within parent |
| `env` | Record<string, string> | Environment variables |
| `gitRef` | string | Git branch/tag/commit |
| `repoArgs` | Record<string, RepoArgSpec> | Bootstrap repos |
| `contextId` | string | Storage partition ID |
| `focus` | boolean | Focus after creation |

## Context & Storage

Panels have isolated storage based on context ID:

- **Default**: `ctx_{instanceId}` — server-side context folder per panel
- **Shared**: Pass `contextId` in options to share storage between panels

## Workspace Packages

| Scope | Location |
|-------|----------|
| `@workspace-panels/*` | `workspace/panels/` |
| `@workspace-workers/*` | `workspace/workers/` |
| `@workspace/*` | `workspace/packages/` |

## Related Docs

- [PANEL_DEVELOPMENT.md](PANEL_DEVELOPMENT.md) - Practical guide
- [RPC.md](RPC.md) - Typed contracts
- [TOOLS.md](TOOLS.md) - Agent tools
