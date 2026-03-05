# Panel Development Guide

Practical guide to building NatStack panels.

## Quick Start

```tsx
// panels/my-app/index.tsx
export default function MyApp() {
  return <div>Hello World!</div>;
}
```

```json
// panels/my-app/package.json
{
  "name": "@workspace-panels/my-app",
  "natstack": { "title": "My App" },
  "dependencies": {
    "@workspace/runtime": "workspace:*",
    "@workspace/react": "workspace:*"
  }
}
```

---

## React Hooks

```tsx
import {
  usePanel,           // Full runtime API
  usePanelTheme,      // "light" | "dark"
  usePanelId,         // Panel's unique ID
  useContextId,       // Context ID for storage
  usePanelFocus,      // Focus state
  usePanelParent,     // Parent handle
  useBootstrap,       // Bootstrap state for repoArgs
} from "@workspace/react";
```

### Theme

```tsx
import { Theme } from "@radix-ui/themes";
import { usePanelTheme } from "@workspace/react";

export default function App() {
  const appearance = usePanelTheme();
  return <Theme appearance={appearance}>{/* UI */}</Theme>;
}
```

### Navigation

Panels navigate via URLs using `buildPanelLink`:

```tsx
import { buildPanelLink } from "@workspace/runtime";

// Same-context navigation
window.location.href = buildPanelLink("panels/editor");

// Cross-context navigation (different storage partition)
window.location.href = buildPanelLink("panels/chat", {
  contextId: "abc-123",
  stateArgs: { channelName: "general" },
});

// Open in new tab
window.open(buildPanelLink("panels/editor"));
```

### Shared Storage

Multiple panels sharing filesystem and storage via cross-context navigation:

```tsx
const contextId = "shared-session-id";

// Navigate to chat in shared context
window.location.href = buildPanelLink("panels/chat", {
  contextId,
  stateArgs: { contextId },
});
```

The `contextId` must be DNS-safe (lowercase alphanumeric + hyphens).

---

## File System

```tsx
import { promises as fs } from "fs";

await fs.writeFile("/data.json", JSON.stringify({ key: "value" }));
const content = await fs.readFile("/data.json", "utf-8");
await fs.mkdir("/subdir", { recursive: true });
```

### Git

```typescript
import { GitClient } from "@workspace/git";
import { gitConfig } from "@workspace/runtime";

const git = new GitClient(fs, { serverUrl: gitConfig.serverUrl, token: gitConfig.token });
await git.clone({ url: `${gitConfig.serverUrl}/my-repo`, dir: "/repo" });
```

---

## Environment Variables

```typescript
import { env } from "@workspace/runtime";
const workspace = env["NATSTACK_WORKSPACE"] || "/workspace";
```

Environment variables are set at panel creation time via the server.

---

## Workers

Background processes with console UI:

```typescript
// workers/compute/index.ts
import { rpc, parent } from "@workspace/runtime";

rpc.expose({
  async compute(data: number[]) {
    const sum = data.reduce((a, b) => a + b, 0);
    parent.emit("progress", { percent: 100 });
    return sum;
  },
});
```

```json
{ "natstack": { "title": "Compute" } }
```

---

## Related Docs

- [RPC.md](RPC.md) - Typed contracts for parent-child communication
- [AI.md](AI.md) - AI integration
- [PANEL_SYSTEM.md](PANEL_SYSTEM.md) - API reference
- [TOOLS.md](TOOLS.md) - Agent tools reference
