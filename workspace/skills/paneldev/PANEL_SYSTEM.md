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
| `title` | string | Required | Display name |
| `entry` | string | `index.tsx` | Entry point |
| `exposeModules` | string[] | `[]` | Extra modules to bundle |

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
  db, fs, fsReady, gitConfig, pubsubConfig, env,

  // Lifecycle
  closeSelf, getInfo, getTheme, onThemeChange, onFocus,

  // Navigation
  buildPanelLink, contextIdToSubdomain,
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

## Context & Storage

Panels have isolated storage based on context ID:

- **Default**: `ctx_{instanceId}` — server-side context folder per panel
- **Shared**: Navigate with `contextId` to share storage between panels

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
