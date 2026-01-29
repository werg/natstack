# Panel Development Guide

This guide covers developing mini-apps (panels) for NatStack with the simplified hooks-based API and workspace package system.

## Table of Contents

- [Quick Start](#quick-start)
- [Panel Basics](#panel-basics)
- [Workspace Package System](#workspace-package-system)
- [TypeScript Configuration](#typescript-configuration)
- [Panel Types](#panel-types)
- [Child Links & Protocols](#child-links--protocols)
- [React Hooks API](#react-hooks-api)
- [Typed RPC Communication](#typed-rpc-communication)
- [Event System](#event-system)
- [Context Templates](#context-templates)
- [File System Access (OPFS)](#file-system-access-opfs)
- [FS + Git in Panels](#fs--git-in-panels)
- [GitHub Repository Cloning](#github-repository-cloning)
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
  "name": "@workspace-panels/my-app",
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
  "name": "@workspace-panels/my-app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "natstack": {
    "type": "app",
    "title": "My Panel",
    "entry": "index.tsx",
    "injectHostThemeVariables": true,
    "repoArgs": ["history", "components"],
    "exposeModules": ["@radix-ui/colors"]
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
| `type` | `"app"` \| `"worker"` | **Required** | What kind of child this manifest creates (used by `createChild` and `ns://` links) |
| `title` | string | **Required** | Display name shown in panel UI |
| `entry` | string | `index.tsx` | Entry point file |
| `runtime` | `"panel"` \| `"worker"` | `"panel"` | **Deprecated** legacy field (use `type` instead) |
| `injectHostThemeVariables` | boolean | `true` | Inherit NatStack theme CSS variables |
| `repoArgs` | string[] | `[]` | Named repo argument slots that callers must provide via `createChild` |
| `exposeModules` | string[] | `[]` | Extra module specifiers to expose via `__natstackRequire__` (bundled even if not directly imported) |

### File Structure

```
panels/my-app/
  ├── package.json        # Manifest with natstack field (required)
  ├── index.tsx           # Entry point (or specify in natstack.entry)
  ├── contract.ts         # Optional: RPC contract for typed parent-child communication
  └── style.css           # Optional: Custom styles
```

---

## Workspace Package System

NatStack uses an internal Verdaccio npm registry to enable sharing code between panels. This enables typed RPC contracts, shared utilities, and type sharing across panel boundaries.

### Package Scopes

| Scope | Location | Description |
|-------|----------|-------------|
| `@workspace-panels/*` | `workspace/panels/` | Panel packages (apps and workers) |
| `@workspace-workers/*` | `workspace/workers/` | Worker packages |
| `@workspace/*` | `workspace/packages/` | Shared utility packages |

### Sharing Code Between Panels

**1. Export modules from your panel:**

```json
// panels/my-panel/package.json
{
  "name": "@workspace-panels/my-panel",
  "exports": {
    ".": "./index.tsx",
    "./contract": "./contract.ts",
    "./types": "./types.ts",
    "./utils": "./utils.ts"
  }
}
```

**2. Depend on the panel from another panel:**

```json
// panels/other-panel/package.json
{
  "dependencies": {
    "@workspace-panels/my-panel": "workspace:*"
  }
}
```

**3. Import the exported modules:**

```typescript
// panels/other-panel/index.tsx
import { myContract } from "@workspace-panels/my-panel/contract";
import type { MyType } from "@workspace-panels/my-panel/types";
import { myUtil } from "@workspace-panels/my-panel/utils";
```

### Creating Shared Packages

For utilities shared across many panels, create a package in `workspace/packages/`:

```json
// workspace/packages/my-utils/package.json
{
  "name": "@workspace/my-utils",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./index.ts"
  }
}
```

Then depend on it from panels:

```json
// panels/my-panel/package.json
{
  "dependencies": {
    "@workspace/my-utils": "workspace:*"
  }
}
```

### How It Works

1. **Verdaccio Registry**: NatStack runs a local npm registry that serves workspace packages
2. **TypeCheckService**: Resolves workspace imports for TypeScript type checking
3. **esbuild**: Bundles workspace dependencies into the final panel build
4. **Build Cache**: Rebuilt when source files change (based on file hashes)

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

### App Panels (`natstack.type: "app"`)

Standard UI panels built from source code.

```typescript
import { createChild } from "@natstack/runtime";

// Panel type is determined by the target panel's manifest (natstack.type).
const editor = await createChild("panels/editor", {
  name: "editor",
  env: { FILE_PATH: "/foo.txt" },
});
```

### Worker Panels (`natstack.type: "worker"`)

Background processes running in WebContentsView with built-in console UI. Useful for long-running tasks.

```typescript
import { createChild } from "@natstack/runtime";

// Still uses createChild(); manifest chooses worker vs app.
const computeWorker = await createChild("workers/compute", {
  name: "compute-worker",
  env: { MODE: "production" },
});
```

Worker manifest uses `type: "worker"` (and may also include legacy `runtime: "worker"`):

```json
{
  "name": "@workspace-workers/compute",
  "natstack": {
    "title": "Compute Worker",
    "type": "worker",
    "runtime": "worker"
  }
}
```

### Browser Panels

External URLs with Playwright automation support.

```typescript
import { createBrowserChild } from "@natstack/runtime";

const browser = await createBrowserChild("https://example.com");
```

---

## Child Links & Protocols

NatStack supports both programmatic child creation and link-based child creation.

### Programmatic

- Use `createChild("panels/…", options?)` to create an app/worker child (type comes from the target manifest).
- Use `createBrowserChild("https://…")` to create a browser child.

### Link-based (`ns:///…`)

You can create children by navigating/clicking `ns:///…` URLs with `action=child`:

```
ns:///panels/editor?action=child
ns:///panels/editor?action=child&gitRef=HEAD
ns:///panels/editor?action=child&gitRef=master
```

- The path is the workspace-relative source (e.g. `panels/editor` or `workers/compute`).
- Use `action=child` to create a new child panel (default behavior for links is in-place navigation).
- Use `gitRef=…` parameter for provisioning a specific git ref (branch/tag/commit).
- Use `buildNsLink(source, options?)` from `@natstack/runtime` to generate these URLs safely.

### Internal protocol (`natstack-panel://`)

`natstack-panel://` is an internal, main-process-served scheme used to load built panel HTML/JS.
It is not intended as a user-facing API and requires a per-panel access token embedded in the URL.

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

  // Access panel info
  const info = await runtime.getInfo();
  console.log(`Panel ID: ${info.panelId}`);
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
  const { children, createChild, createBrowserChild, removeChild } = useChildPanels();

  const handleAddAppPanel = async () => {
    const child = await createChild("panels/example", {
      name: "example",
      env: { MESSAGE: "Hello from parent!" },
    });
    console.log("Created child:", child.id);
  };

  const handleAddWorker = async () => {
    const worker = await createChild("workers/compute", {
      name: "compute",
    });
    console.log("Created worker:", worker.id);
  };

  const handleAddBrowser = async () => {
    const browser = await createBrowserChild("https://example.com");
    console.log("Created browser:", browser.id);
  };

  return (
    <div>
      <button onClick={handleAddAppPanel}>Add App Panel</button>
      <button onClick={handleAddWorker}>Add Worker</button>
      <button onClick={handleAddBrowser}>Add Browser</button>
      <ul>
        {children.map((child) => (
          <li key={child.id}>
            {child.name} ({child.type})
            <button onClick={() => removeChild(child)}>Remove</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

---

## Typed RPC Communication

NatStack's recommended typed RPC pattern is contract-based:

1. Define a shared contract object with `defineContract(...)`
2. Parent creates the child with `createChildWithContract(contract, ...)`
3. Child gets a typed parent handle with `getParentWithContract(contract)`

### Cross-Panel Contract Imports

The key to typed RPC is that **both parent and child import the same contract**. NatStack's workspace package system makes this seamless:

**Step 1: Child panel exports its contract**

```json
// panels/editor/package.json
{
  "name": "@workspace-panels/editor",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./index.tsx",
    "./contract": "./contract.ts"
  },
  "natstack": {
    "type": "app",
    "title": "Editor"
  }
}
```

**Step 2: Parent panel declares dependency**

```json
// panels/ide/package.json
{
  "name": "@workspace-panels/ide",
  "dependencies": {
    "@workspace-panels/editor": "workspace:*"
  }
}
```

**Step 3: Parent imports the contract**

```typescript
// panels/ide/index.tsx
import { editorContract } from "@workspace-panels/editor/contract";
```

This enables full type safety across panel boundaries without code duplication.

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
    // TypeScript interface for RPC methods (phantom type at runtime)
    methods: {} as EditorApi,
    // Zod schemas for events (validated at runtime)
    emits: {
      "saved": z.object({ path: z.string(), timestamp: z.string() }),
      "content-changed": z.object({ content: z.string() }),
    },
  },
  // Optional: events/methods on parent side
  // parent: {
  //   emits: {
  //     "theme-changed": z.object({ theme: z.enum(["light", "dark"]) }),
  //   },
  // },
});
```

### Exposing Methods (Child Panel)

```tsx
// panels/editor/index.tsx
import { useEffect, useState } from "react";
import { rpc, getParentWithContract, noopParent } from "@natstack/runtime";
import { editorContract } from "./contract.js";

// noopParent provides a safe fallback when panel runs without parent
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
        // Typed event emission
        await parent.emit("saved", { path, timestamp: new Date().toISOString() });
      },
    });
  }, [content]);

  return <textarea value={content} onChange={(e) => setContent(e.target.value)} />;
}
```

### Calling Methods + Listening to Events (Parent Panel)

```tsx
// panels/ide/index.tsx
import { useState, useEffect } from "react";
import { createChildWithContract, type ChildHandleFromContract } from "@natstack/runtime";
// Import contract from child panel package
import { editorContract } from "@workspace-panels/editor/contract";

export default function IDE() {
  const [editor, setEditor] = useState<ChildHandleFromContract<typeof editorContract> | null>(null);

  useEffect(() => {
    if (!editor) return;
    // Typed event listener - payload type is inferred from contract
    return editor.onEvent("saved", (payload) => {
      console.log("Saved:", payload.path, payload.timestamp);
    });
  }, [editor]);

  const launchEditor = async () => {
    const child = await createChildWithContract(editorContract, { name: "editor" });
    setEditor(child);
  };

  const save = async () => {
    // Typed method call - arguments and return type are inferred
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

### noopParent Fallback

When a panel may run standalone (without a parent), use `noopParent` to avoid null checks:

```typescript
import { getParentWithContract, noopParent } from "@natstack/runtime";

// Without noopParent - requires null checks everywhere
const parent = getParentWithContract(contract);
if (parent) {
  parent.emit("event", payload);
}

// With noopParent - always safe to call
const parent = getParentWithContract(contract) ?? noopParent;
parent.emit("event", payload); // Silently does nothing if no parent
```

### Existing Cross-Panel Dependencies

Several workspace panels already use cross-panel imports:

```typescript
// project-launcher imports from project-panel
import { type ProjectConfig } from "@workspace-panels/project-panel/types";

// chat-launcher imports from agent-manager
import { loadGlobalSettings } from "@workspace-panels/agent-manager";
```

This pattern works for both typed contracts and shared utility functions
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

## Context Templates

NatStack provides a **Docker-like context template system** for efficiently creating pre-populated agentic sandboxes. Templates define git repositories to clone into specific paths within a panel's OPFS filesystem, enabling you to spin up new agent sessions instantly from a pre-built base environment.

### Why Context Templates?

For **agentic workloads**, you typically need multiple AI agent sessions with identical base environments:
- Tool repositories (search, code execution, file manipulation)
- Prompt libraries and system instructions
- Shared data and configurations

Without templates, every new agent session would:
- Clone the same repositories repeatedly
- Download the same dependencies
- Set up identical file structures

With templates, this setup happens **once**, and each new session gets an instant copy of the pre-built environment. This dramatically improves startup time for agent-heavy applications.

### Creating a Context Template

Add a `context-template.yml` file to your panel directory:

```yaml
# panels/my-agent/context-template.yml

# Optional: inherit from another template (like Docker's FROM)
extends: contexts/base-agent

# Git repositories to clone into the context
deps:
  /tools/search:
    repo: tools/web-search
    ref: main
  /tools/code:
    repo: tools/code-executor
    ref: v2.0.0
  /data/prompts:
    repo: shared/prompt-library
    ref: main
```

### Template Inheritance

Templates can extend other templates, creating a layered system:

```yaml
# contexts/base-agent/context-template.yml
deps:
  /tools/core:
    repo: tools/core-utils
    ref: main
  /config:
    repo: shared/agent-config
    ref: main

# panels/advanced-agent/context-template.yml
extends: contexts/base-agent
deps:
  /tools/advanced:
    repo: tools/advanced-reasoning
    ref: v3.0.0
  # Automatically inherits /tools/core and /config from base-agent
```

### Accessing Template Content

Once your panel loads, the template's repositories are available in OPFS:

```tsx
import { promises as fs } from "fs";
import { GitClient } from "@natstack/git";

export default function AgentPanel() {
  const initAgent = async () => {
    // These paths were pre-populated by the template!
    const tools = await fs.readdir("/tools");
    console.log("Available tools:", tools); // ["search", "code"]

    const prompts = await fs.readFile("/data/prompts/system.txt", "utf-8");
    console.log("System prompt loaded");

    // You can also use git operations on template repos
    const git = new GitClient(fs, gitConfig);
    await git.pull({ dir: "/tools/search" }); // Update to latest
  };

  return <button onClick={initAgent}>Initialize Agent</button>;
}
```

### How Template Building Works

When a panel with a template loads:

1. **Resolve**: Follow `extends` chains, merge all `deps`
2. **Hash**: Compute SHA256 of the final specification
3. **Check Cache**: Look for existing build with that hash
4. **Build** (if needed): A hidden worker clones all repos to OPFS
5. **Copy**: Copy the template partition to the panel's context partition

This ensures:
- Templates are built once per unique specification
- Multiple panels with the same template share the build
- Changes to templates (different refs) trigger rebuilds

### Context ID Formats

NatStack generates context IDs based on panel type:

```ts
// Safe panels (use templates, OPFS storage)
"safe_tpl_a1b2c3d4e5f6_panels~my-agent"
//       ^^^^^^^^^^^^^ template hash

// Unsafe panels (no templates, Node.js fs access)
"unsafe_noctx_panels~terminal"
```

**Note**: Only safe panels can use templates. Unsafe panels have direct Node.js filesystem access and don't use OPFS.

### Parsing Context IDs

```ts
import { parseContextId } from "@natstack/runtime";

const parsed = parseContextId("safe_tpl_a1b2c3d4e5f6_panels~editor");
// { mode: "safe", templateSpecHash: "a1b2c3d4e5f6", instanceId: "panels~editor" }

const unsafe = parseContextId("unsafe_noctx_panels~terminal");
// { mode: "unsafe", templateSpecHash: null, instanceId: "panels~terminal" }
```

### Best Practices for Agentic Contexts

1. **Use templates for shared tooling**: Put commonly-used agent tools in a base template
2. **Pin refs for stability**: Use commit SHAs or tags instead of branch names for production
3. **Layer templates**: Create a hierarchy (base-agent -> specialized-agent) for reuse
4. **Keep templates focused**: Each template should serve a specific use case

See [OPFS_PARTITIONS.md](OPFS_PARTITIONS.md) for complete documentation on context templates and storage partitions.

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

Each safe panel has its own OPFS partition based on its context and template:

- **Template-based contexts**: Safe panels use `safe_tpl_{hash}_{instanceId}` format, where the hash ensures consistent template content
- **Pre-populated content**: If a panel has a `context-template.yml`, its OPFS starts with the template's cloned repositories
- **Instance isolation**: Each panel instance gets its own copy of the template, allowing independent modifications

Unsafe panels use `unsafe_noctx_{instanceId}` format and have direct Node.js filesystem access instead of OPFS.

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

---

## GitHub Repository Cloning

NatStack's internal git server supports **transparent GitHub repository cloning**. When you clone a repository at a path like `github.com/<owner>/<repo>`, the server automatically fetches it from GitHub if it doesn't already exist locally.

### How It Works

The git server intercepts requests for paths starting with `github.com/` and:

1. Checks if the repository already exists in the workspace
2. If not, clones it from GitHub automatically
3. Serves the local clone transparently

This means consuming code doesn't need to know whether a repository is local or needs to be fetched—it just works.

### Usage

Clone GitHub repositories using the standard git URL format:

```bash
# From a terminal or git client
git clone http://localhost:63524/github.com/octocat/Hello-World

# The repository is now available at:
# <workspace>/github.com/octocat/Hello-World/
```

From panel code using `@natstack/git`:

```typescript
import { GitClient } from "@natstack/git";

const git = new GitClient();

// Clone a GitHub repo into OPFS
await git.clone({
  url: `http://localhost:${gitConfig.port}/github.com/owner/repo`,
  dir: "/projects/my-clone",
});
```

### Configuration

Configure GitHub cloning in `natstack.yml`:

```yaml
git:
  port: 63524
  github:
    enabled: true      # Enable transparent cloning (default: true)
    depth: 1           # Shallow clone depth (default: 1, use 0 for full history)
    # token: use secrets.yml for private repos
```

For private repositories, add a GitHub Personal Access Token to `secrets.yml`:

```yaml
# ~/.config/natstack/.secrets.yml
github: ghp_xxxxxxxxxxxxxxxxxxxx
```

### Path Format

GitHub repositories are stored at:

```
<workspace>/github.com/<owner>/<repo>/
```

For example:
- `github.com/facebook/react` → `<workspace>/github.com/facebook/react/`
- `github.com/anthropics/claude-code` → `<workspace>/github.com/anthropics/claude-code/`

### Use Cases

**Context Templates**: Reference GitHub repositories directly in context templates:

```yaml
# context-template.yml
name: my-agent
structure:
  deps:
    search-tool: github.com/owner/search-tool#main
    utils: github.com/owner/utils@v1.0.0
```

The template resolver will auto-clone the repositories when resolving refs.

**Dynamic Dependencies**: Pull in libraries or data repositories on-demand without pre-configuring them in templates.

**Code Analysis**: Clone repositories for analysis, diffing, or code review workflows.

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

## Browser Automation

Control browser panels programmatically with Playwright:

```typescript
import { chromium } from 'playwright-core';
import { createBrowserChild } from "@natstack/runtime";

// Create browser panel
const browserPanel = await createBrowserChild("https://example.com");

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

Prefer `defineContract(...)` + `createChildWithContract(...)` + `getParentWithContract(...)` (see "Typed RPC Communication").

```tsx
// panels/my-panel/contract.ts
import { z, defineContract } from "@natstack/runtime";

export const myContract = defineContract({
  source: "panels/my-panel",
  child: {
    emits: { "event1": z.object({ data: z.string() }) },
  },
});
```

### 3. Export Contracts for Parent Panels

When building panels that will be launched by other panels, export the contract:

```json
// panels/my-panel/package.json
{
  "exports": {
    ".": "./index.tsx",
    "./contract": "./contract.ts"
  }
}
```

Parents can then import and use it:

```tsx
// panels/parent/index.tsx
import { myContract } from "@workspace-panels/my-panel/contract";
const child = await createChildWithContract(myContract);
```

### 4. Use Shared Packages for Common Code

Put shared utilities in `workspace/packages/` to avoid duplication:

```
workspace/packages/my-utils/
  ├── package.json    # name: "@workspace/my-utils"
  └── index.ts        # Exports shared utilities
```

### 5. Clean Up Resources

Hooks handle cleanup automatically, but for manual subscriptions:

```tsx
useEffect(() => {
  const unsubscribe = runtime.rpc.onEvent("my-event", handler);
  return unsubscribe; // Clean up on unmount
}, []);
```

### 6. Handle Loading States

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
- [panels/typed-rpc-child/](panels/typed-rpc-child/) - **Contract-based typed RPC**: Demonstrates `defineContract`, typed events, and `noopParent`
- [panels/agentic-chat/](panels/agentic-chat/) - AI integration with Vercel AI SDK streaming
- [panels/agentic-notebook/](panels/agentic-notebook/) - Jupyter-style notebook with AI agent
- [panels/shared-opfs-demo/](panels/shared-opfs-demo/) - Demonstrates shared file storage across panel instances

---

## API Reference

### Child Creation API

```typescript
// App/worker child (type comes from the target manifest's natstack.type)
await createChild("panels/editor", {
  name?: string;
  env?: Record<string, string>;
  gitRef?: string; // encoded in ns:// URLs via ?gitRef= parameter
  repoArgs?: Record<string, RepoArgSpec>;
  sourcemap?: boolean; // app only
  unsafe?: boolean | string; // worker only
});

// Browser child
await createBrowserChild("https://example.com");

// Link helper for <a href="...">
buildNsLink("panels/editor", { action: "child", gitRef: "HEAD" }); // -> ns:///panels/editor?action=child&gitRef=HEAD
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
runtime.createChild(source: string, options?): Promise<ChildHandle>
runtime.createBrowserChild(url: string): Promise<ChildHandle>
runtime.buildNsLink(source: string, options?): string
runtime.buildAboutLink(page: AboutPage): string
runtime.buildFocusLink(panelId: string): string
runtime.onChildCreationError(cb: ({ url: string; error: string }) => void): () => void
runtime.createChildWithContract(contract, options?): Promise<ChildHandleFromContract>
runtime.children: ReadonlyMap<string, ChildHandle>
runtime.getChild(name: string): ChildHandle | undefined
runtime.onChildAdded(cb): () => void
runtime.onChildRemoved(cb): () => void

// Lifecycle
runtime.removeChild(childId: string): Promise<void>
runtime.close(): Promise<void>
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
usePanelPartition(): string | null
usePanelRpcGlobalEvent<T>(event: string, handler: (from: string, payload: T) => void): void
usePanelParent<T, E>(): ParentHandle<T, E> | null
useChildPanels(): { children: ChildHandle[]; createChild(source: string, options?): Promise<ChildHandle>; createBrowserChild(url: string): Promise<ChildHandle>; removeChild(handle: ChildHandle): Promise<void> }
usePanelFocus(): boolean
usePanelChild<T, E>(name: string): ChildHandle<T, E> | undefined
usePanelChildren(): ReadonlyMap<string, ChildHandle>
usePanelCreateChild<T, E>(spec: null | { kind: "browser"; url: string } | { kind?: "appOrWorker"; source: string; options?: CreateChildOptions }): ChildHandle<T, E> | null
```
