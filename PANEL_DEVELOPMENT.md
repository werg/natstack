# Panel Development Guide

This guide covers developing mini-apps (panels) for NatStack with the simplified hooks-based API and workspace package system.

## Table of Contents

- [Quick Start](#quick-start)
- [Panel Basics](#panel-basics)
- [Panel Types](#panel-types)
- [React Hooks API](#react-hooks-api)
- [Typed RPC Communication](#typed-rpc-communication)
- [Event System](#event-system)
- [File System Access (OPFS)](#file-system-access-opfs)
- [FS + Git in Panels](#fs--git-in-panels)
- [AI Integration](#ai-integration)
- [Browser Automation](#browser-automation)

---

## Quick Start

### Minimal Panel Example

The simplest possible panel is just a React component:

```tsx
// panels/my-app/index.tsx
export default function MyApp() {
  return <div>Hello World!</div>;
}
```

```json
// panels/my-app/package.json
{
  "name": "@natstack-panels/my-app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "natstack": {
    "title": "My App"
  },
  "dependencies": {
    "@natstack/core": "workspace:*",
    "@natstack/react": "workspace:*"
  }
}
```

That's it! No imports, no mounting code, no boilerplate.

---

## Panel Basics

### Panel Manifest (`package.json`)

Every panel requires a `package.json` with a `natstack` field:

```json
{
  "name": "@natstack-panels/my-app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "natstack": {
    "title": "My Panel",
    "entry": "index.tsx",
    "runtime": "panel",
    "injectHostThemeVariables": true,
    "singletonState": false,
    "gitDependencies": {
      "shared": "panels/shared-lib"
    }
  },
  "dependencies": {
    "@natstack/core": "workspace:*",
    "@natstack/react": "workspace:*"
  }
}
```

### Manifest Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `title` | string | **Required** | Display name shown in panel UI |
| `entry` | string | `index.tsx` | Entry point file |
| `runtime` | `"panel"` \| `"worker"` | `"panel"` | Build as UI panel or background worker |
| `injectHostThemeVariables` | boolean | `true` | Inherit NatStack theme CSS variables |
| `singletonState` | boolean | `false` | Share storage across all instances |
| `gitDependencies` | object | `{}` | Git repos to clone into panel's OPFS |

### File Structure

```
panels/my-app/
  ├── package.json        # Manifest with natstack field (required)
  ├── index.tsx           # Entry point (or specify in natstack.entry)
  ├── api.ts              # Optional: Exported RPC types for parent panels
  └── style.css           # Optional: Custom styles
```

---

## Panel Types

NatStack supports three types of panels:

### App Panels (`type: "app"`)

Standard UI panels built from source code.

```typescript
const editorId = await panel.createChild({
  type: 'app',
  name: 'editor',
  path: 'panels/editor',
  env: { FILE_PATH: '/foo.txt' },
});
```

### Worker Panels (`type: "worker"`)

Background processes running in isolated-vm. Useful for CPU-intensive tasks.

```typescript
const computeId = await panel.createChild({
  type: 'worker',
  name: 'compute-worker',
  path: 'workers/compute',
  memoryLimitMB: 512,
  env: { MODE: 'production' },
});
```

Worker manifest uses `runtime: "worker"`:

```json
{
  "name": "@natstack-workers/compute",
  "natstack": {
    "title": "Compute Worker",
    "runtime": "worker"
  }
}
```

### Browser Panels (`type: "browser"`)

External URLs with Playwright automation support.

```typescript
const browserId = await panel.createChild({
  type: 'browser',
  name: 'web-scraper',
  url: 'https://example.com',
  title: 'Scraper',
});
```

---

## React Hooks API

NatStack provides React hooks for all panel features. Import from `@natstack/react`:

### Basic Hooks

#### `usePanel()`

Get the panel API object:

```tsx
import { usePanel } from "@natstack/react";

function MyPanel() {
  const panel = usePanel();

  const handleRename = async () => {
    await panel.setTitle("New Title");
  };

  return <button onClick={handleRename}>Rename Panel</button>;
}
```

#### `usePanelTheme()`

Access the current theme and subscribe to changes:

```tsx
import { usePanelTheme } from "@natstack/react";

function MyPanel() {
  const theme = usePanelTheme();

  return (
    <div style={{
      background: theme.appearance === "dark" ? "#000" : "#fff"
    }}>
      Current theme: {theme.appearance}
    </div>
  );
}
```

#### `usePanelId()`

Get the panel's unique ID:

```tsx
import { usePanelId } from "@natstack/react";

function MyPanel() {
  const panelId = usePanelId();
  return <div>My ID: {panelId}</div>;
}
```

#### `usePanelEnv()`

Access environment variables passed from parent:

```tsx
import { usePanelEnv } from "@natstack/react";

function MyPanel() {
  const env = usePanelEnv();

  return (
    <div>
      {env.PARENT_ID && <p>Parent: {env.PARENT_ID}</p>}
      {env.MESSAGE && <p>Message: {env.MESSAGE}</p>}
    </div>
  );
}
```

#### `usePanelPartition()`

Get the storage partition name:

```tsx
import { usePanelPartition } from "@natstack/react";

function MyPanel() {
  const partition = usePanelPartition();
  return <div>Storage: {partition ?? "loading..."}</div>;
}
```

### Child Panel Management

#### `useChildPanels()`

Manage child panels with automatic cleanup:

```tsx
import { useChildPanels } from "@natstack/react";

function MyPanel() {
  const { children, createChild, removeChild } = useChildPanels();

  const handleAddAppPanel = async () => {
    const childId = await createChild({
      type: 'app',
      name: 'example',
      path: 'panels/example',
      env: { MESSAGE: "Hello from parent!" }
    });
    console.log("Created child:", childId);
  };

  const handleAddWorker = async () => {
    const workerId = await createChild({
      type: 'worker',
      name: 'compute',
      path: 'workers/compute',
      memoryLimitMB: 512,
    });
    console.log("Created worker:", workerId);
  };

  const handleAddBrowser = async () => {
    const browserId = await createChild({
      type: 'browser',
      name: 'scraper',
      url: 'https://example.com',
    });
    console.log("Created browser:", browserId);
  };

  return (
    <div>
      <button onClick={handleAddAppPanel}>Add App Panel</button>
      <button onClick={handleAddWorker}>Add Worker</button>
      <button onClick={handleAddBrowser}>Add Browser</button>
      <ul>
        {children.map(childId => (
          <li key={childId}>
            {childId}
            <button onClick={() => removeChild(childId)}>Remove</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

---

## Typed RPC Communication

NatStack provides fully type-safe RPC communication between panels and workers.

### Defining the API

Create an `api.ts` file to export types for parent panels:

```tsx
// panels/editor/api.ts
import type { RpcEventMap } from "@natstack/react";

export interface EditorAPI {
  getContent(): Promise<string>;
  setContent(text: string): Promise<void>;
  save(path: string): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

export interface EditorEvents extends RpcEventMap {
  "content-changed": { text: string; cursor: number };
  "saved": { path: string; timestamp: string };
  "error": { message: string };
}
```

### Exposing the API (Child Panel)

```tsx
// panels/editor/index.tsx
import { useEffect, useState } from "react";
import { panel, usePanelEnv } from "@natstack/react";
import type { EditorAPI } from "./api";

export default function Editor() {
  const [content, setContent] = useState("");
  const env = usePanelEnv();

  useEffect(() => {
    // Expose typed API
    panel.rpc.expose<EditorAPI>({
      async getContent() {
        return content;
      },

      async setContent(text: string) {
        setContent(text);
      },

      async save(path: string) {
        // Save logic...
        // Emit typed event
        if (env.PARENT_ID) {
          panel.rpc.emit(env.PARENT_ID, "saved", {
            path,
            timestamp: new Date().toISOString()
          });
        }
      },

      async undo() { /* ... */ },
      async redo() { /* ... */ }
    });
  }, [content, env.PARENT_ID]);

  return <textarea value={content} onChange={e => setContent(e.target.value)} />;
}
```

### Calling the API (Parent Panel)

```tsx
// panels/parent/index.tsx
import { useState, useEffect } from "react";
import { usePanelRpc, panel } from "@natstack/react";
import type { EditorAPI, EditorEvents } from "../editor/api";

export default function Parent() {
  const [editorId, setEditorId] = useState<string | null>(null);

  // Get typed RPC handle
  const editorHandle = usePanelRpc<EditorAPI, EditorEvents>(editorId);

  // Listen to typed events
  useEffect(() => {
    if (!editorHandle) return;

    return editorHandle.on("saved", (payload) => {
      console.log("File saved:", payload.path);
      console.log("At:", payload.timestamp); // Fully typed!
    });
  }, [editorHandle]);

  const handleLaunch = async () => {
    const id = await panel.createChild({
      type: 'app',
      name: 'editor',
      path: 'panels/editor',
    });
    setEditorId(id);
  };

  const handleGetContent = async () => {
    if (!editorHandle) return;
    const content = await editorHandle.call.getContent(); // Typed!
    console.log(content);
  };

  const handleSave = async () => {
    if (!editorHandle) return;
    await editorHandle.call.save("/file.txt"); // Typed!
  };

  return (
    <div>
      {!editorHandle && <button onClick={handleLaunch}>Launch Editor</button>}
      {editorHandle && (
        <>
          <button onClick={handleGetContent}>Get Content</button>
          <button onClick={handleSave}>Save</button>
        </>
      )}
    </div>
  );
}
```

### RPC Hooks

#### `usePanelRpc()`

Get a typed RPC handle to another panel or worker:

```tsx
const childHandle = usePanelRpc<ChildAPI, ChildEvents>(childId);

// Fully typed method calls
await childHandle?.call.methodName(arg1, arg2);

// Fully typed event subscriptions
childHandle?.on("event-name", (payload) => {
  // payload is typed!
});
```

#### `usePanelRpcEvent()`

Subscribe to a specific event from a panel:

```tsx
import { usePanelRpcEvent } from "@natstack/react";

usePanelRpcEvent(childId, "data-changed", (payload) => {
  console.log("Data changed:", payload);
});
```

#### `usePanelRpcGlobalEvent()`

Subscribe to events from any panel:

```tsx
import { usePanelRpcGlobalEvent } from "@natstack/react";

usePanelRpcGlobalEvent("status-update", (fromPanelId, payload) => {
  console.log(`${fromPanelId} sent:`, payload);
});
```

---

## Event System

### Type-Safe Events

Define event types using `RpcEventMap`:

```tsx
import type { RpcEventMap } from "@natstack/react";

interface MyEvents extends RpcEventMap {
  "user-login": { userId: string; timestamp: number };
  "data-sync": { syncedItems: number; errors: string[] };
  "notification": { level: "info" | "warning" | "error"; message: string };
}
```

### Emitting Events

```tsx
import { panel } from "@natstack/react";

// Emit to parent
const env = await panel.getEnv();
if (env.PARENT_ID) {
  panel.rpc.emit(env.PARENT_ID, "user-login", {
    userId: "123",
    timestamp: Date.now()
  });
}

// Emit to specific panel
panel.rpc.emit(targetPanelId, "notification", {
  level: "info",
  message: "Hello!"
});
```

### Listening to Events

Using the RPC handle:

```tsx
const handle = usePanelRpc<ChildAPI, ChildEvents>(childId);

useEffect(() => {
  if (!handle) return;

  return handle.on("user-login", (payload) => {
    console.log("User logged in:", payload.userId);
    // payload is fully typed!
  });
}, [handle]);
```

Using the event hook:

```tsx
usePanelRpcEvent<{ userId: string }>(childId, "user-login", (payload) => {
  console.log("User logged in:", payload.userId);
});
```

---

## File System Access (OPFS)

Panels have access to Origin Private File System (OPFS) through a Node.js-compatible API.

### Using the `fs` API

```tsx
import { promises as fs } from "fs";

export default function FileManager() {
  const handleWrite = async () => {
    await fs.writeFile("/myfile.txt", "Hello World!", "utf-8");
  };

  const handleRead = async () => {
    const content = await fs.readFile("/myfile.txt", "utf-8");
    console.log(content);
  };

  const handleList = async () => {
    const files = await fs.readdir("/");
    console.log("Files:", files);
  };

  const handleDelete = async () => {
    await fs.rm("/myfile.txt");
  };

  return (
    <div>
      <button onClick={handleWrite}>Write File</button>
      <button onClick={handleRead}>Read File</button>
      <button onClick={handleList}>List Files</button>
      <button onClick={handleDelete}>Delete File</button>
    </div>
  );
}
```

### Storage Isolation

Each panel has its own OPFS partition:

- **Isolated by default**: Each panel instance gets unique storage
- **Singleton mode**: Set `singletonState: true` in `natstack` field to share across instances

---

## FS + Git in Panels

NatStack exposes an OPFS-backed `fs` implementation (via ZenFS) in panel builds, and `@natstack/git` works atop it. To use them in your panel:

1) Import the shimmed `fs` and a Git client:

```ts
import fs from "fs/promises";
import { GitClient } from "@natstack/git";
```

2) Initialize your storage and inject `fs` where needed (e.g., notebook kernels, agent tools):

```ts
// Example wiring inside your panel bootstrap
const git = new GitClient();
// fs is already the OPFS-backed impl from preload/build
await storage.initialize(fs, git);   // your storage layer
kernel.injectFileSystemBindings(fs); // so user code can use fs in the kernel
agent.registerFileTools(fs);         // if your agent exposes file tools
```

3) Common gotchas:
- Do not bring your own `fs` polyfill; the build/runtime already maps `fs`/`fs/promises` to OPFS.
- Ensure you call your storage initialization before rendering history UIs; otherwise you may see loading skeletons forever.
- When using `@natstack/git`, no extra polyfills are needed—the shimmed `fs` is sufficient.

With this wiring, panels get persistent OPFS storage, git capabilities, and `fs` available both in panel code and injected runtime environments (kernels/agents).

## AI Integration

Use the Vercel AI SDK with NatStack's AI provider:

```tsx
import { useState } from "react";
import { models } from "@natstack/ai";

export default function AIChatPanel() {
  const [messages, setMessages] = useState<Array<{ role: string; text: string }>>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);

  const handleSend = async () => {
    if (!input.trim()) return;

    const userMessage = { role: "user", text: input };
    setMessages(prev => [...prev, userMessage]);
    setInput("");
    setStreaming(true);

    try {
      const model = models["claude-3-5-sonnet-20241022"];
      const { stream } = await model.doStream({
        prompt: [
          { role: "system", content: "You are a helpful assistant." },
          ...messages.map(m => ({
            role: m.role,
            content: [{ type: "text", text: m.text }]
          })),
          { role: "user", content: [{ type: "text", text: input }] }
        ]
      });

      let assistantText = "";
      const reader = stream.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value?.type === "text-delta") {
          assistantText += value.delta;
          setMessages(prev => [
            ...prev.slice(0, -1),
            { role: "assistant", text: assistantText }
          ]);
        }
      }
    } finally {
      setStreaming(false);
    }
  };

  return (
    <div>
      <div>
        {messages.map((msg, i) => (
          <div key={i}>
            <strong>{msg.role}:</strong> {msg.text}
          </div>
        ))}
      </div>
      <input
        value={input}
        onChange={e => setInput(e.target.value)}
        disabled={streaming}
      />
      <button onClick={handleSend} disabled={streaming}>
        Send
      </button>
    </div>
  );
}
```

---

## Browser Automation

Control browser panels programmatically with Playwright:

```typescript
import { chromium } from 'playwright-core';
import { panel } from "@natstack/react";

// Create browser panel
const browserId = await panel.createChild({
  type: 'browser',
  name: 'automation-target',
  url: 'https://example.com',
});

// Get CDP endpoint for Playwright
const cdpUrl = await panel.browser.getCdpEndpoint(browserId);

// Connect Playwright
const browser = await chromium.connectOverCDP(cdpUrl);
const page = browser.contexts()[0].pages()[0];

// Automate!
await page.click('.button');
await page.fill('input[name="search"]', 'query');
const content = await page.textContent('.result');
```

### Browser API Methods

```typescript
panel.browser.getCdpEndpoint(browserId): Promise<string>  // Get CDP WebSocket URL
panel.browser.navigate(browserId, url): Promise<void>     // Navigate to URL
panel.browser.goBack(browserId): Promise<void>            // Go back in history
panel.browser.goForward(browserId): Promise<void>         // Go forward in history
panel.browser.reload(browserId): Promise<void>            // Reload page
panel.browser.stop(browserId): Promise<void>              // Stop loading
```

---

## Best Practices

### 1. Use Hooks for Everything

```tsx
// ✅ Good
import { usePanelTheme, useChildPanels } from "@natstack/react";

function MyPanel() {
  const theme = usePanelTheme();
  const { children, createChild } = useChildPanels();
  // ...
}

// ❌ Avoid
import { panel } from "@natstack/react";

function MyPanel() {
  const [theme, setTheme] = useState(panel.getTheme());
  // Manual subscription management...
}
```

### 2. Define Types for RPC

Always create an `api.ts` file to export RPC types:

```tsx
// api.ts
export interface MyAPI {
  method1(): Promise<string>;
  method2(arg: number): Promise<void>;
}

export interface MyEvents extends RpcEventMap {
  "event1": { data: string };
}
```

### 3. Clean Up Resources

Hooks handle cleanup automatically, but for manual subscriptions:

```tsx
useEffect(() => {
  const unsubscribe = panel.rpc.onEvent("my-event", handler);
  return unsubscribe; // Clean up on unmount
}, []);
```

### 4. Handle Loading States

```tsx
const partition = usePanelPartition();

if (partition === null) {
  return <div>Loading...</div>;
}

return <div>Storage: {partition}</div>;
```

---

## Complete Examples

See the example panels:
- [panels/example/](panels/example/) - **Root panel**: Comprehensive demo with child management, OPFS, typed RPC, and environment variables
- [panels/agentic-chat/](panels/agentic-chat/) - AI integration with Vercel AI SDK streaming
- [panels/agentic-notebook/](panels/agentic-notebook/) - Jupyter-style notebook with AI agent
- [panels/shared-opfs-demo/](panels/shared-opfs-demo/) - Demonstrates shared file storage across panel instances

---

## API Reference

### Child Spec Types

```typescript
// App panel spec
interface AppChildSpec {
  type: 'app';
  name: string;                      // Unique name (becomes part of panel ID)
  path: string;                      // Workspace-relative path to source
  env?: Record<string, string>;      // Environment variables
  branch?: string;                   // Git branch to track
  commit?: string;                   // Specific commit hash
  tag?: string;                      // Git tag to pin to
}

// Worker spec
interface WorkerChildSpec {
  type: 'worker';
  name: string;                      // Unique name (becomes part of worker ID)
  path: string;                      // Workspace-relative path to source
  env?: Record<string, string>;      // Environment variables
  memoryLimitMB?: number;            // Memory limit (default: 1024)
  branch?: string;                   // Git branch to track
  commit?: string;                   // Specific commit hash
  tag?: string;                      // Git tag to pin to
}

// Browser panel spec
interface BrowserChildSpec {
  type: 'browser';
  name: string;                      // Unique name (becomes part of panel ID)
  url: string;                       // Initial URL to load
  title?: string;                    // Optional title (defaults to URL hostname)
  env?: Record<string, string>;      // Environment variables
}

type ChildSpec = AppChildSpec | WorkerChildSpec | BrowserChildSpec;
```

### Panel API (`panel`)

```tsx
import { panel } from "@natstack/react";

// Core methods
panel.getId(): string
panel.createChild(spec: ChildSpec): Promise<string>
panel.removeChild(childId: string): Promise<void>
panel.setTitle(title: string): Promise<void>
panel.close(): Promise<void>
panel.getTheme(): PanelTheme
panel.onThemeChange(callback: (theme: PanelTheme) => void): () => void
panel.getEnv(): Promise<Record<string, string>>
panel.getPartition(): Promise<string | null>
panel.getInfo(): Promise<{ panelId: string; partition: string }>

// RPC methods
panel.rpc.expose<T>(methods: T): void
panel.rpc.getHandle<T, E>(panelId: string): PanelRpcHandle<T, E>
panel.rpc.emit(panelId: string, event: string, payload: unknown): Promise<void>
panel.rpc.onEvent(event: string, handler: (from: string, payload: unknown) => void): () => void

// Git methods
panel.git.getConfig(): Promise<GitConfig>

// Browser methods
panel.browser.getCdpEndpoint(browserId: string): Promise<string>
panel.browser.navigate(browserId: string, url: string): Promise<void>
panel.browser.goBack(browserId: string): Promise<void>
panel.browser.goForward(browserId: string): Promise<void>
panel.browser.reload(browserId: string): Promise<void>
panel.browser.stop(browserId: string): Promise<void>
```

### React Hooks

```tsx
usePanel(): PanelAPI
usePanelTheme(): PanelTheme
usePanelId(): string
usePanelEnv(): Record<string, string>
usePanelPartition(): string | null
usePanelRpc<T, E>(panelId: string | null): PanelRpcHandle<T, E> | null
usePanelRpcEvent<T>(panelId: string | null, event: string, handler: (payload: T) => void): void
usePanelRpcGlobalEvent<T>(event: string, handler: (from: string, payload: T) => void): void
useChildPanels(): { children: string[]; createChild: (spec: ChildSpec) => Promise<string>; removeChild: (id: string) => Promise<void> }
usePanelFocus(): boolean
```
