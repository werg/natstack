# Panel Development Guide

Practical guide to building NatStack panels. For API reference, see [PANEL_SYSTEM.md](PANEL_SYSTEM.md).

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
    "@natstack/runtime": "workspace:*",
    "@natstack/react": "workspace:*"
  }
}
```

That's it. NatStack auto-mounts your default export.

---

## React Hooks

Import from `@natstack/react`:

```tsx
import {
  usePanel,           // Get full runtime API
  usePanelTheme,      // "light" | "dark", auto-updates
  usePanelId,         // Panel's unique ID
  usePanelPartition,  // Storage partition (null while loading)
  useContextId,       // Context ID for storage grouping
  usePanelFocus,      // Whether panel is focused
  useChildPanels,     // Manage child panels
  usePanelChild,      // Get specific child by name
  usePanelChildren,   // All children as Map
  usePanelParent,     // Parent handle (null if root)
  useBootstrap,       // Bootstrap state for repoArgs
} from "@natstack/react";
```

### Theme Integration

```tsx
import { Theme } from "@radix-ui/themes";
import { usePanelTheme } from "@natstack/react";

export default function App() {
  const appearance = usePanelTheme();
  return (
    <Theme appearance={appearance}>
      {/* Your UI */}
    </Theme>
  );
}
```

### Managing Children

```tsx
import { useChildPanels } from "@natstack/react";

function ParentPanel() {
  const { children, createChild, createBrowserChild } = useChildPanels();

  const addEditor = async () => {
    await createChild("panels/editor", { name: "editor" });
  };

  const addBrowser = async () => {
    await createBrowserChild("https://example.com");
  };

  return (
    <div>
      <button onClick={addEditor}>Add Editor</button>
      <button onClick={addBrowser}>Add Browser</button>
      <ul>
        {children.map(child => (
          <li key={child.id}>{child.name} ({child.type})</li>
        ))}
      </ul>
    </div>
  );
}
```

### Shared Storage with contextId

When panels need to share the same OPFS/IndexedDB storage (e.g., chat + agents in a session):

```tsx
function SessionLauncher() {
  const launchSession = async () => {
    // Generate shared context ID for the session
    const sessionContextId = crypto.randomUUID();

    // Create chat panel with shared storage
    const chat = await createChild("panels/chat", {
      name: "chat-session",
      contextId: sessionContextId,  // Sets storage partition
    }, {
      channelName: "my-channel",
      contextId: sessionContextId,  // App logic also needs context ID
    });

    // Create agent worker sharing the same storage
    await createChild("workers/agent", {
      name: "agent",
      contextId: sessionContextId,  // Same partition as chat
    }, {
      channel: "my-channel",
      contextId: sessionContextId,
    });
  };

  return <button onClick={launchSession}>Start Session</button>;
}
```

**Important:** Pass `contextId` in both options (for storage) and stateArgs (for app logic).

### Bootstrap State

When your panel declares `repoArgs`, use `useBootstrap` to track cloning progress:

```tsx
import { useBootstrap } from "@natstack/react";

function App() {
  const { loading, result, error } = useBootstrap();

  if (loading) return <div>Cloning repositories...</div>;
  if (error) return <div>Bootstrap failed: {error}</div>;

  // result.argPaths contains { argName: "/args/argName" }
  return <div>Ready! Repos at: {JSON.stringify(result?.argPaths)}</div>;
}
```

---

## Typed RPC Communication

For type-safe parent-child communication, define a contract:

### 1. Define Contract (child panel)

```typescript
// panels/editor/contract.ts
import { z, defineContract } from "@natstack/runtime";

export interface EditorApi {
  getContent(): Promise<string>;
  setContent(text: string): Promise<void>;
  save(): Promise<void>;
}

export const editorContract = defineContract({
  source: "panels/editor",
  child: {
    methods: {} as EditorApi,
    emits: {
      "saved": z.object({ path: z.string(), timestamp: z.number() }),
      "modified": z.object({ dirty: z.boolean() }),
    },
  },
});
```

### 2. Export Contract (child's package.json)

```json
{
  "name": "@workspace-panels/editor",
  "exports": {
    ".": "./index.tsx",
    "./contract": "./contract.ts"
  }
}
```

### 3. Implement Child

```tsx
// panels/editor/index.tsx
import { useEffect, useState } from "react";
import { rpc, getParentWithContract, noopParent } from "@natstack/runtime";
import { editorContract } from "./contract.js";

const parent = getParentWithContract(editorContract) ?? noopParent;

export default function Editor() {
  const [content, setContent] = useState("");

  useEffect(() => {
    rpc.expose({
      async getContent() { return content; },
      async setContent(text) { setContent(text); },
      async save() {
        // Save logic...
        parent.emit("saved", { path: "/file.txt", timestamp: Date.now() });
      },
    });
  }, [content]);

  return (
    <textarea
      value={content}
      onChange={e => {
        setContent(e.target.value);
        parent.emit("modified", { dirty: true });
      }}
    />
  );
}
```

### 4. Use from Parent

```tsx
// panels/ide/index.tsx
import { useState, useEffect } from "react";
import { createChildWithContract } from "@natstack/runtime";
import { editorContract } from "@workspace-panels/editor/contract";

export default function IDE() {
  const [editor, setEditor] = useState(null);
  const [dirty, setDirty] = useState(false);

  const launch = async () => {
    const child = await createChildWithContract(editorContract, { name: "editor" });
    setEditor(child);
  };

  useEffect(() => {
    if (!editor) return;
    const unsub1 = editor.onEvent("saved", ({ path }) => {
      console.log("Saved:", path);
      setDirty(false);
    });
    const unsub2 = editor.onEvent("modified", ({ dirty }) => setDirty(dirty));
    return () => { unsub1(); unsub2(); };
  }, [editor]);

  return (
    <div>
      <button onClick={launch}>Open Editor</button>
      {editor && (
        <>
          <span>{dirty ? "Modified" : "Saved"}</span>
          <button onClick={() => editor.call.save()}>Save</button>
        </>
      )}
    </div>
  );
}
```

---

## File System (OPFS)

Safe panels use OPFS with a Node.js-compatible API:

```tsx
import { promises as fs } from "fs";

async function example() {
  await fs.writeFile("/data.json", JSON.stringify({ key: "value" }));
  const content = await fs.readFile("/data.json", "utf-8");
  const files = await fs.readdir("/");
  await fs.mkdir("/subdir", { recursive: true });
  await fs.rm("/data.json");
}
```

### Git Operations

```typescript
import { promises as fs } from "fs";
import { GitClient } from "@natstack/git";
import { gitConfig } from "@natstack/runtime";

const git = new GitClient(fs, {
  serverUrl: gitConfig.serverUrl,
  token: gitConfig.token,
});

await git.clone({ url: `${gitConfig.serverUrl}/my-repo`, dir: "/repo" });
await git.pull({ dir: "/repo" });
```

---

## Unsafe Mode (Node.js)

Enable full Node.js access for panels that need real filesystem:

```json
{
  "natstack": {
    "type": "app",
    "title": "Terminal",
    "unsafe": true
  }
}
```

In unsafe mode:

```typescript
import { readFileSync, readdirSync } from "fs";
import { platform, homedir } from "os";
import { join } from "path";

// Sync APIs work (not available in OPFS)
const content = readFileSync("/etc/hostname", "utf-8");
const files = readdirSync(homedir());

// Real process.env
console.log(process.env.HOME);

// Dynamic require
const crypto = require("crypto");
```

Unsafe globals:
- `__natstackFsRoot` — Scoped fs root (if configured)
- `__natstackId` — Panel ID
- `__natstackKind` — "panel" or "worker"

---

## AI Integration

Use `@natstack/ai` for streaming text generation with tool calling:

```tsx
import { ai } from "@natstack/ai";

// Simple streaming
const stream = ai.streamText({
  model: "fast",
  system: "You are helpful.",
  messages: [{ role: "user", content: "Hello!" }],
});

for await (const event of stream) {
  if (event.type === "text-delta") {
    process.stdout.write(event.text);
  }
}
```

### Tool Calling

```tsx
import { ai, tool } from "@natstack/ai";
import { z } from "@natstack/runtime";

const tools = {
  get_time: tool({
    description: "Get current time",
    parameters: z.object({}),
    execute: async () => ({ time: new Date().toISOString() }),
  }),
  calculate: tool({
    description: "Evaluate math expression",
    parameters: z.object({
      expression: z.string().describe("Math expression like '2+2'"),
    }),
    execute: async ({ expression }) => ({
      result: new Function(`return (${expression})`)(),
    }),
  }),
};

const stream = ai.streamText({
  model: "fast",
  system: "Use tools when helpful.",
  messages,
  tools,
  maxSteps: 5,
});

for await (const event of stream) {
  switch (event.type) {
    case "text-delta":
      console.log(event.text);
      break;
    case "tool-call":
      console.log(`Calling ${event.toolName}:`, event.args);
      break;
    case "tool-result":
      console.log(`Result:`, event.result);
      break;
    case "finish":
      console.log(`Done in ${event.totalSteps} steps`);
      break;
  }
}
```

### Available Roles

```typescript
const roles = await ai.listRoles();
// { fast: { displayName: "...", modelId: "..." }, smart: {...}, ... }
```

---

## Browser Automation

Control browser panels with Playwright:

```typescript
import { chromium } from "playwright-core";
import { createBrowserChild } from "@natstack/runtime";

const browser = await createBrowserChild("https://example.com");
const cdpUrl = await browser.getCdpEndpoint();

const conn = await chromium.connectOverCDP(cdpUrl);
const page = conn.contexts()[0].pages()[0];

await page.click(".button");
await page.fill("input[name=search]", "query");
const text = await page.textContent(".result");

// Navigation
await browser.navigate("https://other.com");
await browser.goBack();
await browser.reload();
```

---

## Context Templates

Pre-populate OPFS with git repos for consistent environments:

```yaml
# panels/my-agent/context-template.yml
extends: contexts/base-agent

deps:
  /tools/search:
    repo: tools/web-search
    ref: main
  /data/prompts:
    repo: shared/prompts
    ref: v1.0.0
```

Templates are built once and copied to each panel instance.

---

## Sharing Code

### Export from Panel

```json
{
  "name": "@workspace-panels/my-panel",
  "exports": {
    ".": "./index.tsx",
    "./contract": "./contract.ts",
    "./types": "./types.ts"
  }
}
```

### Import in Another Panel

```json
{
  "dependencies": {
    "@workspace-panels/my-panel": "workspace:*"
  }
}
```

```typescript
import { myContract } from "@workspace-panels/my-panel/contract";
import type { MyType } from "@workspace-panels/my-panel/types";
```

---

## Workers

Workers are background processes with console UI:

```typescript
// workers/compute/index.ts
import { rpc, parent } from "@natstack/runtime";

rpc.expose({
  async compute(data: number[]) {
    const sum = data.reduce((a, b) => a + b, 0);
    parent.emit("progress", { percent: 100 });
    return sum;
  },
});
```

```json
{
  "natstack": { "type": "worker", "title": "Compute Worker" }
}
```

Create from parent:
```typescript
const worker = await createChild("workers/compute", { name: "compute" });
const result = await worker.call.compute([1, 2, 3, 4, 5]);
```

---

## Best Practices

1. **Use hooks** — `useChildPanels`, `usePanelTheme`, etc. handle subscriptions automatically

2. **Use contracts** — Type safety across panel boundaries catches errors at compile time

3. **Use noopParent** — Avoid null checks when panel may run standalone:
   ```typescript
   const parent = getParentWithContract(contract) ?? noopParent;
   parent.emit("event", data); // Safe even if no parent
   ```

4. **Export contracts** — Put contract in separate file and export via package.json

5. **Wait for fs** — Use `fsReady` before filesystem operations:
   ```typescript
   import { fsReady } from "@natstack/runtime";
   await fsReady;
   // Now safe to use fs
   ```
