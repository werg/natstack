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
    "@natstack/runtime": "workspace:*",
    "@natstack/react": "workspace:*"
  }
}
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `"app"` \| `"worker"` | Required | Panel type |
| `title` | string | Required | Display name |
| `entry` | string | `index.tsx` | Entry point |
| `unsafe` | boolean | `false` | Enable Node.js APIs |
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
  db, fs, fsReady, gitConfig, pubsubConfig,

  // Lifecycle
  closeSelf, getInfo, getTheme, onThemeChange, onFocus,
} from "@natstack/runtime";
```

## CreateChildOptions

| Option | Type | Description |
|--------|------|-------------|
| `name` | string | Stable ID within parent |
| `env` | Record<string, string> | Environment variables |
| `gitRef` | string | Git branch/tag/commit |
| `repoArgs` | Record<string, RepoArgSpec> | Bootstrap repos |
| `templateSpec` | string | Context template path |
| `contextId` | string | Storage partition ID |
| `unsafe` | boolean \| string | Node.js mode |
| `focus` | boolean | Focus after creation |

## Context & Storage

Panels have isolated OPFS storage based on context ID:

- **Safe**: `safe_tpl_{hash}_{instanceId}` - OPFS sandbox
- **Unsafe**: `unsafe_noctx_{instanceId}` - Node.js filesystem

Templates pre-populate OPFS:

```yaml
extends: contexts/base
structure:
  /workspace/tools/search: tools/web-search#main
```

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
