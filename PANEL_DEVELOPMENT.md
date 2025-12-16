# Panel Development Guide

This guide covers developing mini-apps (panels) for NatStack with the simplified hooks-based API and workspace package system.

## Table of Contents

- [Quick Start](#quick-start)
- [Panel Basics](#panel-basics)
- [TypeScript Configuration](#typescript-configuration)
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
    "@natstack/runtime": "workspace:*",
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
    "repoArgs": ["history", "components"]
  },
  "dependencies": {
    "@natstack/runtime": "workspace:*",
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
| `repoArgs` | string[] | `[]` | Named repo argument slots that callers must provide via `createChild` |

### File Structure

```
panels/my-app/
  ├── package.json        # Manifest with natstack field (required)
  ├── index.tsx           # Entry point (or specify in natstack.entry)
  ├── api.ts              # Optional: Exported RPC types for parent panels
  └── style.css           # Optional: Custom styles
```

---

## TypeScript Configuration

NatStack builds panels/workers with an internal, build-owned `tsconfig.json` so user repositories can’t accidentally (or intentionally) change module resolution or emit behavior for the app.

### What userland can configure

You can add a `tsconfig.json` in your panel/worker repo. NatStack will read it and merge an allowlisted set of “safe” `compilerOptions` into the build config (userland values take priority).

Allowlisted fields:

- **Decorators (legacy TypeScript)**: `experimentalDecorators`, `emitDecoratorMetadata`, `useDefineForClassFields`
  - Useful for libraries that rely on decorator metadata.
  - Note: legacy decorators typically expect `useDefineForClassFields: false`.
- **JSX import source (panels only)**: `jsxImportSource`
  - Useful for React-compatible tooling like Emotion (`@emotion/react`) without changing the JSX runtime mode.

Explicitly ignored (not merged):

- **Module resolution / graph shape**: `baseUrl`, `paths`, `moduleResolution`, `rootDir`, `outDir`, `typeRoots`, `types`
- **Output targeting**: `target`, `module`, `lib`

The goal is “userland opt-in for ergonomics” without letting projects redirect imports (e.g. `@natstack/*`) or change the runtime contract.

---

## Panel Types

NatStack supports three types of panels:

### App Panels (`type: "app"`)

Standard UI panels built from source code.

```typescript
import { createChild } from "@natstack/runtime";

const editor = await createChild({
  type: 'app',
  name: 'editor',
  source: 'panels/editor',
  env: { FILE_PATH: '/foo.txt' },
});
```

### Worker Panels (`type: "worker"`)

Background processes running in isolated-vm. Useful for CPU-intensive tasks.

```typescript
import { createChild } from "@natstack/runtime";

const computeWorker = await createChild({
  type: 'worker',
  name: 'compute-worker',
  source: 'workers/compute',
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
import { createChild } from "@natstack/runtime";

const browser = await createChild({
  type: 'browser',
  name: 'web-scraper',
  source: 'https://example.com',
  title: 'Scraper',
});
```

---

## React Hooks API

NatStack provides React hooks for all panel features. Import from `@natstack/react`:

### Basic Hooks

#### `usePanel()`

Get the NatStack runtime API object:

```tsx
import { usePanel } from "@natstack/react";

function MyPanel() {
  const runtime = usePanel();

  const handleRename = async () => {
    await runtime.setTitle("New Title");
  };

  return <button onClick={handleRename}>Rename Panel</button>;
}
```

#### `usePanelTheme()`

Access the current theme and subscribe to changes:

```tsx
import { usePanelTheme } from "@natstack/react";

function MyPanel() {
  const appearance = usePanelTheme();

  return (
    <div style={{
      background: appearance === "dark" ? "#000" : "#fff"
    }}>
      Current theme: {appearance}
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

NatStack’s recommended typed RPC pattern is contract-based:

1. Define a shared contract object with `defineContract(...)`
2. Parent creates the child with `createChildWithContract(contract, ...)`
3. Child gets a typed parent handle with `getParentWithContract(contract)`

### Defining a Contract

```ts
// panels/editor/contract.ts
import { z, defineContract } from "@natstack/runtime";

export interface EditorApi {
  getContent(): Promise<string>;
  setContent(text: string): Promise<void>;
  save(path: string): Promise<void>;
}

export const editorContract = defineContract({
  source: "panels/editor",
  child: {
    methods: {} as EditorApi,
    emits: {
      "saved": z.object({ path: z.string(), timestamp: z.string() }),
    },
  },
});
```

### Exposing Methods (Child Panel)

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
      async getContent() {
        return content;
      },
      async setContent(text: string) {
        setContent(text);
      },
      async save(path: string) {
        await parent.emit("saved", { path, timestamp: new Date().toISOString() });
      },
    });
  }, [content]);

  return <textarea value={content} onChange={(e) => setContent(e.target.value)} />;
}
```

### Calling Methods + Listening to Events (Parent Panel)

```tsx
import { useState, useEffect } from "react";
import { createChildWithContract, type ChildHandleFromContract } from "@natstack/runtime";
import { editorContract } from "../editor/contract.js";

export default function Parent() {
  const [editor, setEditor] = useState<ChildHandleFromContract<typeof editorContract> | null>(null);

  useEffect(() => {
    if (!editor) return;
    return editor.onEvent("saved", (payload) => {
      console.log("Saved:", payload.path, payload.timestamp);
    });
  }, [editor]);

  const launchEditor = async () => {
    const child = await createChildWithContract(editorContract, { name: "editor" });
    setEditor(child);
  };

  const save = async () => {
    await editor?.call.save("/file.txt");
  };

  return (
    <div>
      <button onClick={launchEditor}>Launch Editor</button>
      <button onClick={save} disabled={!editor}>Save</button>
    </div>
  );
}
```

---

## Event System

There are two main event patterns:

### Typed Events (Recommended)

Use contracts + `ChildHandle.onEvent(...)` / `ParentHandle.emit(...)` for type-safe events. See “Typed RPC Communication”.

### Global Events (Low-Level)

Use `rpc.emit(...)` and `rpc.onEvent(...)` for ad-hoc events between arbitrary endpoints:

```ts
import { rpc, parent } from "@natstack/runtime";

// Emit to parent (noop if no parent)
await parent.emit("user-login", { userId: "123", timestamp: Date.now() });

// Emit to a specific endpoint id
await rpc.emit("tree/some/panel", "notification", { level: "info", message: "Hello!" });

// Listen for events from any endpoint
const unsubscribe = rpc.onEvent("notification", (fromId, payload) => {
  console.log("notification from", fromId, payload);
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
import { createChild } from "@natstack/runtime";

// Create browser panel
const browserPanel = await createChild({
  type: 'browser',
  name: 'automation-target',
  source: 'https://example.com',
});

// Get CDP endpoint for Playwright
const cdpUrl = await browserPanel.getCdpEndpoint();

// Connect Playwright
const browserConn = await chromium.connectOverCDP(cdpUrl);
const page = browserConn.contexts()[0].pages()[0];

// Automate!
await page.click('.button');
await page.fill('input[name="search"]', 'query');
const content = await page.textContent('.result');
```

### Browser API Methods

```typescript
await browserPanel.getCdpEndpoint()
await browserPanel.navigate(url)
await browserPanel.goBack()
await browserPanel.goForward()
await browserPanel.reload()
await browserPanel.stop()
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
import * as runtime from "@natstack/runtime";

function MyPanel() {
  const [theme, setTheme] = useState(runtime.getTheme());
  // Manual subscription management...
}
```

### 2. Use Contracts for Typed RPC

Prefer `defineContract(...)` + `createChildWithContract(...)` + `getParentWithContract(...)` (see “Typed RPC Communication”).

```tsx
// contract.ts
import { z, defineContract } from "@natstack/runtime";

export const myContract = defineContract({
  source: "panels/my-panel",
  child: {
    emits: { "event1": z.object({ data: z.string() }) },
  },
});
```

### 3. Clean Up Resources

Hooks handle cleanup automatically, but for manual subscriptions:

```tsx
useEffect(() => {
  const unsubscribe = runtime.rpc.onEvent("my-event", handler);
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
  type: "app";
  name?: string;                     // Optional name (stable ID within parent if provided)
  source: string;                    // Workspace-relative path to source
  env?: Record<string, string>;      // Environment variables
  sourcemap?: boolean;               // Emit inline sourcemaps (default: true)
  branch?: string;                   // Git branch to track
  commit?: string;                   // Specific commit hash
  tag?: string;                      // Git tag to pin to
  repoArgs?: Record<string, RepoArgSpec>; // Must match child's manifest repoArgs
}

// Worker spec
interface WorkerChildSpec {
  type: "worker";
  name?: string;                     // Optional name (stable ID within parent if provided)
  source: string;                    // Workspace-relative path to source
  env?: Record<string, string>;      // Environment variables
  memoryLimitMB?: number;            // Memory limit (default: 1024)
  branch?: string;                   // Git branch to track
  commit?: string;                   // Specific commit hash
  tag?: string;                      // Git tag to pin to
  repoArgs?: Record<string, RepoArgSpec>; // Must match child's manifest repoArgs
}

// Browser panel spec
interface BrowserChildSpec {
  type: "browser";
  name?: string;                     // Optional name
  source: string;                    // Initial URL to load
  title?: string;                    // Optional title (defaults to URL hostname in UI)
  env?: Record<string, string>;      // Environment variables
}

type ChildSpec = AppChildSpec | WorkerChildSpec | BrowserChildSpec;
```

### Runtime API (`@natstack/runtime`)

```tsx
import * as runtime from "@natstack/runtime";

// Identity
runtime.id: string
runtime.parentId: string | null

// Core services
runtime.rpc: RpcBridge
runtime.db: { open(name: string, readOnly?: boolean): Promise<Database> }
runtime.fs: RuntimeFs
runtime.parent: ParentHandle

// Parent handles
runtime.getParent<T, E, EmitE>(): ParentHandle<T, E, EmitE> | null
runtime.getParentWithContract(contract): ParentHandleFromContract | null

// Child management
runtime.createChild(spec: ChildSpec): Promise<ChildHandle>
runtime.createChildWithContract(contract, options?): Promise<ChildHandleFromContract>
runtime.children: ReadonlyMap<string, ChildHandle>
runtime.getChild(name: string): ChildHandle | undefined
runtime.onChildAdded(cb): () => void
runtime.onChildRemoved(cb): () => void

// Lifecycle
runtime.removeChild(childId: string): Promise<void>
runtime.setTitle(title: string): Promise<void>
runtime.close(): Promise<void>
runtime.getEnv(): Promise<Record<string, string>>
runtime.getInfo(): Promise<{ panelId: string; partition: string }>

// Theme/focus
runtime.getTheme(): ThemeAppearance
runtime.onThemeChange(cb: (appearance: ThemeAppearance) => void): () => void
runtime.onFocus(cb: () => void): () => void

// Startup data (synchronous, set at startup)
runtime.gitConfig: GitConfig | null
runtime.bootstrap: BootstrapResult | null
runtime.bootstrapError: string | null
```

### React Hooks

```tsx
usePanel(): typeof import("@natstack/runtime")
usePanelTheme(): ThemeAppearance
usePanelId(): string
usePanelEnv(): Record<string, string>
usePanelPartition(): string | null
usePanelRpcGlobalEvent<T>(event: string, handler: (from: string, payload: T) => void): void
usePanelParent<T, E>(): ParentHandle<T, E> | null
useChildPanels(): { children: ChildHandle[]; createChild(spec: ChildSpec): Promise<ChildHandle>; removeChild(handle: ChildHandle): Promise<void> }
usePanelFocus(): boolean
usePanelChild<T, E>(name: string): ChildHandle<T, E> | undefined
usePanelChildren(): ReadonlyMap<string, ChildHandle>
usePanelCreateChild<T, E>(spec: ChildSpec | null): ChildHandle<T, E> | null
```
