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
  "natstack": { "type": "app", "title": "My App" },
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
  useChildPanels,     // Manage children
  usePanelChild,      // Get specific child
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

### Children

```tsx
import { useChildPanels } from "@workspace/react";

function Parent() {
  const { children, createChild, createBrowserChild } = useChildPanels();

  return (
    <div>
      <button onClick={() => createChild("panels/editor", { name: "editor" })}>
        Add Editor
      </button>
      <ul>
        {children.map(c => <li key={c.id}>{c.name}</li>)}
      </ul>
    </div>
  );
}
```

### Shared Storage

Multiple panels sharing filesystem and storage:

```tsx
const contextId = crypto.randomUUID();

await createChild("panels/chat", { name: "chat", contextId }, { contextId });
await createChild("workers/agent", { name: "agent", contextId }, { contextId });
```

Pass `contextId` in both options (for storage) and stateArgs (for app logic).

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

## Unsafe Mode (Node.js)

Enable real filesystem access:

```json
{ "natstack": { "type": "app", "title": "Terminal", "unsafe": true } }
```

```typescript
import { readFileSync, readdirSync } from "fs";
const files = readdirSync(process.env.HOME);
```

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
{ "natstack": { "type": "worker", "title": "Compute" } }
```

---

## Related Docs

- [RPC.md](RPC.md) - Typed contracts for parent-child communication
- [AI.md](AI.md) - AI integration and browser automation
- [PANEL_SYSTEM.md](PANEL_SYSTEM.md) - API reference
- [TOOLS.md](TOOLS.md) - Agent tools reference
