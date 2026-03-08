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
  "natstack": { "title": "My App" },
  "dependencies": {
    "@workspace/runtime": "workspace:*",
    "@workspace/react": "workspace:*"
  }
}
```

That's it. NatStack auto-mounts your default export.

---

## React Hooks

Import from `@workspace/react`:

```tsx
import {
  usePanel,           // Get full runtime API
  usePanelTheme,      // "light" | "dark", auto-updates
  usePanelId,         // Panel's unique ID
  usePanelPartition,  // Storage partition name (null while loading)
  useContextId,       // Context ID for storage grouping
  usePanelFocus,      // Whether panel is focused
  usePanelParent,     // Parent handle (null if root)
} from "@workspace/react";
```

### Theme Integration

```tsx
import { Theme } from "@radix-ui/themes";
import { usePanelTheme } from "@workspace/react";

export default function App() {
  const appearance = usePanelTheme();
  return (
    <Theme appearance={appearance}>
      {/* Your UI */}
    </Theme>
  );
}
```

### Navigation

Navigation between panels is URL-based using `buildPanelLink` from `@workspace/runtime`:

```tsx
import { buildPanelLink } from "@workspace/runtime";

function NavigationExample() {
  // Navigate in the same context (replaces current panel)
  const openEditor = () => {
    window.location.href = buildPanelLink("panels/editor");
  };

  // Navigate to a panel in a different context, passing state
  const openChat = () => {
    window.location.href = buildPanelLink("panels/chat", {
      contextId: "abc-123",
      stateArgs: { channel: "my-channel" },
    });
  };

  // Open a panel in a new tab
  const openEditorTab = () => {
    window.open(buildPanelLink("panels/editor"));
  };

  return (
    <div>
      <button onClick={openEditor}>Open Editor</button>
      <button onClick={openChat}>Open Chat</button>
      <button onClick={openEditorTab}>Editor (New Tab)</button>
    </div>
  );
}
```

### Shared Storage with contextId

When panels need to share the same filesystem and storage (e.g., chat + agents in a session):

```tsx
import { buildPanelLink } from "@workspace/runtime";

function SessionLauncher() {
  const launchSession = () => {
    // Generate shared context ID for the session
    const sessionContextId = crypto.randomUUID();

    // Navigate to chat panel with shared storage
    window.location.href = buildPanelLink("panels/chat", {
      contextId: sessionContextId,
      stateArgs: {
        channelName: "my-channel",
        contextId: sessionContextId,
      },
    });

    // Or open an agent worker in a new tab sharing the same storage
    window.open(buildPanelLink("workers/agent", {
      contextId: sessionContextId,
      stateArgs: {
        channel: "my-channel",
        contextId: sessionContextId,
      },
    }));
  };

  return <button onClick={launchSession}>Start Session</button>;
}
```

**Important:** Pass `contextId` in both the link options (for storage) and stateArgs (for app logic).

---

## Typed RPC Communication

For type-safe parent-child communication, define a contract:

### 1. Define Contract (child panel)

```typescript
// panels/editor/contract.ts
import { z, defineContract } from "@workspace/runtime";

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
import { rpc, getParentWithContract, noopParent } from "@workspace/runtime";
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
import { buildPanelLink } from "@workspace/runtime";
import { editorContract } from "@workspace-panels/editor/contract";

export default function IDE() {
  const [dirty, setDirty] = useState(false);

  const launch = () => {
    // Navigate to the editor panel via URL
    window.open(buildPanelLink("panels/editor"));
  };

  return (
    <div>
      <button onClick={launch}>Open Editor</button>
      <span>{dirty ? "Modified" : "Saved"}</span>
    </div>
  );
}
```

---

## File System

Safe panels use an RPC-backed filesystem with a Node.js-compatible API:

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
import { GitClient } from "@workspace/git";
import { gitConfig } from "@workspace/runtime";

const git = new GitClient(fs, {
  serverUrl: gitConfig.serverUrl,
  token: gitConfig.token,
});

await git.clone({ url: `${gitConfig.serverUrl}/my-repo`, dir: "/repo" });
await git.pull({ dir: "/repo" });
```

---

## Environment Variables

Access environment variables passed to your panel via `env` from the runtime:

```typescript
import { env } from "@workspace/runtime";

const workspace = env["NATSTACK_WORKSPACE"] || "/workspace";
```

---

## AI Integration

Use `@workspace/runtime` for streaming text generation with tool calling:

```tsx
import { ai } from "@workspace/runtime";

// Simple streaming
const stream = ai.streamText({
  model: "fast",
  system: "You are helpful.",
  messages: [{ role: "user", content: "Hello!" }],
});

for await (const event of stream) {
  if (event.type === "text-delta") {
    console.log(event.text);
  }
}
```

### Tool Calling

```tsx
import { ai } from "@workspace/runtime";
import { tool } from "@natstack/ai";
import { z } from "@workspace/runtime";

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

### Browser Automation

Create browser panels that load external URLs and control them via Playwright/CDP. Works in both Electron and headless modes.

#### Typed API (recommended for automation)

```typescript
import { createBrowserPanel, openExternal } from "@workspace/runtime";
import { chromium } from "playwright-core";

// 1. Create a browser panel — returns a BrowserHandle
const handle = await createBrowserPanel("https://example.com", { focus: true });

// 2. Get CDP endpoint and connect Playwright
const cdpUrl = await handle.getCdpEndpoint();
const browser = await chromium.connectOverCDP(cdpUrl);
const page = browser.contexts()[0].pages()[0];

// 3. Interact with the page
await page.fill("input[name=query]", "NatStack");
await page.click(".search-button");
const text = await page.textContent(".results .first");

// 4. Navigate via handle
await handle.navigate("https://other.com");
await handle.goBack();
await handle.reload();

// 5. Close when done
await handle.close();

// Or open in system browser (no CDP access)
await openExternal("https://docs.example.com");
```

#### Fire-and-forget (window.open)

In Electron mode, `window.open("https://...")` also creates browser panels. Discover the child ID via event:

```typescript
import { onChildCreated, getBrowserHandle } from "@workspace/runtime";

onChildCreated(({ childId, url }) => {
  const handle = getBrowserHandle(childId);
  // Now use handle.getCdpEndpoint(), handle.navigate(), etc.
});
window.open("https://example.com");
```

#### BrowserHandle methods

| Method | Description |
|--------|-------------|
| `getCdpEndpoint()` | Get CDP WebSocket URL for Playwright |
| `navigate(url)` | Load a URL |
| `goBack()` | Navigate back |
| `goForward()` | Navigate forward |
| `reload()` | Reload page |
| `stop()` | Stop loading |
| `close()` | Close browser panel |

**Security:** Panels can only control browser panels they own.

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

## State Args

Pass and receive configuration data during panel navigation:

```typescript
import { buildPanelLink, getStateArgs, useStateArgs, setStateArgs } from "@workspace/runtime";

// Pass state when navigating
window.location.href = buildPanelLink("panels/chat", {
  contextId: "abc-123",
  stateArgs: { channelName: "general", mode: "compact" },
});

// Read state reactively in a component (re-renders on update)
const stateArgs = useStateArgs<{ channelName: string; mode: string }>();

// Read state non-reactively (snapshot, for event handlers)
const args = getStateArgs<{ channelName: string }>();

// Update state (persists to DB + triggers re-render via WebSocket)
await setStateArgs({ mode: "expanded" });
```

---

## Database

SQLite database access via `db` from the runtime:

```typescript
import { db } from "@workspace/runtime";

const database = await db.open("my-data");
await database.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)");
await database.run("INSERT INTO items (name) VALUES (?)", ["example"]);
const rows = await database.query<{ id: number; name: string }>("SELECT * FROM items");
const one = await database.get<{ id: number; name: string }>("SELECT * FROM items WHERE id = ?", [1]);
await database.close();
```

Databases are stored at `<workspace>/.databases/<name>.db` and backed by `better-sqlite3`.

---

## PubSub

Real-time messaging between panels via `@natstack/pubsub`:

```typescript
import { pubsubConfig } from "@workspace/runtime";
import { connectWithConfig } from "@natstack/pubsub";

const client = connectWithConfig(pubsubConfig, {
  channel: "my-channel",
  contextId,
  handle: "my-panel",
  reconnect: true,
});

await client.ready();
await client.publish("chat", { text: "Hello!" });

for await (const msg of client.messages()) {
  console.log(msg.type, msg.payload);
}
```

Key PubSub client APIs:
- `publish(type, payload)` -- Send a message
- `messages()` -- Async iterator for incoming messages
- `onRoster(handler)` -- Track connected participants
- `updateMetadata(meta)` -- Update participant metadata
- `ready(timeoutMs?)` -- Wait for replay completion

---

## Best Practices

1. **Use hooks** -- `usePanelTheme`, `useContextId`, etc. handle subscriptions automatically

2. **Use contracts** -- Type safety across panel boundaries catches errors at compile time

3. **Use noopParent** -- Avoid null checks when panel may run standalone:
   ```typescript
   const parent = getParentWithContract(contract) ?? noopParent;
   parent.emit("event", data); // Safe even if no parent
   ```

4. **Export contracts** -- Put contract in separate file and export via package.json

5. **Use buildPanelLink for navigation** -- All panel navigation uses URL-based links:
   ```typescript
   import { buildPanelLink } from "@workspace/runtime";
   window.location.href = buildPanelLink("panels/target");
   ```
