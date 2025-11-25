# Panel Development Guide

This guide covers developing mini-apps (panels) for NatStack with the simplified hooks-based API and workspace package system.

## Table of Contents

- [Quick Start](#quick-start)
- [Panel Basics](#panel-basics)
- [React Hooks API](#react-hooks-api)
- [Typed RPC Communication](#typed-rpc-communication)
- [Event System](#event-system)
- [File System Access (OPFS)](#file-system-access-opfs)
- [AI Integration](#ai-integration)

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
    "title": "My Panel",              // Required: Display name
    "entry": "index.tsx",              // Optional: Entry file (default: index.tsx)
    "injectHostThemeVariables": true,  // Optional: Inherit theme CSS (default: true)
    "singletonState": false            // Optional: Singleton storage (default: false)
  },
  "dependencies": {
    "@natstack/core": "workspace:*",
    "@natstack/react": "workspace:*"
  }
}
```

### File Structure

```
panels/my-app/
  ├── package.json        # Manifest with natstack field (required)
  ├── index.tsx           # Entry point (or specify in natstack.entry)
  ├── api.ts              # Optional: Exported RPC types for parent panels
  └── style.css           # Optional: Custom styles
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

  const handleAddChild = async () => {
    const childId = await createChild("panels/example", {
      env: { MESSAGE: "Hello from parent!" }
    });
    console.log("Created child:", childId);
  };

  return (
    <div>
      <button onClick={handleAddChild}>Add Child</button>
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

NatStack provides fully type-safe RPC communication between panels.

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
    const id = await panel.createChild("panels/editor");
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

Get a typed RPC handle to another panel:

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
- **Shared storage**: Use `panelId` option to share between instances
- **Singleton mode**: Set `singletonState: true` in `natstack` field

```tsx
// Create child with shared storage
await panel.createChild("panels/editor", {
  panelId: "shared-editor" // All instances share storage
});
```

---

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
- [panels/typed-rpc-child/](panels/typed-rpc-child/) - Child panel that exposes typed RPC API and emits events
- [panels/agentic-chat/](panels/agentic-chat/) - AI integration with Vercel AI SDK streaming
- [panels/shared-opfs-demo/](panels/shared-opfs-demo/) - Demonstrates shared file storage across panel instances

---

## API Reference

### Panel API (`panel`)

```tsx
import { panel } from "@natstack/react";

panel.getId(): string
panel.createChild(path: string, options?: CreateChildOptions): Promise<string>
panel.removeChild(childId: string): Promise<void>
panel.setTitle(title: string): Promise<void>
panel.close(): Promise<void>
panel.getTheme(): PanelTheme
panel.onThemeChange(callback: (theme: PanelTheme) => void): () => void
panel.getEnv(): Promise<Record<string, string>>
panel.getPartition(): Promise<string>
panel.getInfo(): Promise<{ panelId: string; partition: string }>
panel.rpc.expose<T>(methods: T): void
panel.rpc.getHandle<T, E>(panelId: string): PanelRpcHandle<T, E>
panel.rpc.emit(panelId: string, event: string, payload: unknown): Promise<void>
panel.rpc.onEvent(event: string, handler: (from: string, payload: unknown) => void): () => void
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
useChildPanels(): { children: string[]; createChild: Function; removeChild: Function }
usePanelFocus(): boolean
```
