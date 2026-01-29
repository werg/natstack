# Panel System Documentation

## Overview

The NatStack panel system allows you to create dynamically loaded, hierarchical panels that can spawn child panels, workers, and browser panels. Each panel is an independent TypeScript/JavaScript project that gets compiled on-the-fly using esbuild.

## Panel Types

NatStack supports three types of panels:

| Type | Description | Use Case |
|------|-------------|----------|
| `app` | Built webview from source code | UI components, editors, dashboards |
| `worker` | Background process with console UI | Long-running tasks, background computations |
| `browser` | External URL with Playwright automation | Web scraping, testing, automation |

## Panel Structure

A panel is a directory containing:

```
my-panel/
├── package.json        # Manifest with natstack field (required)
├── index.tsx           # Default entry (index.ts / index.jsx also detected)
├── index.html          # HTML template (optional, auto-generated if missing)
├── contract.ts         # Optional: RPC contract for typed parent-child communication
└── style.css           # Styles (optional)
```

## Manifest Format

Panel configuration is specified in `package.json` with a `natstack` field:

```json
{
  "name": "@workspace-panels/my-panel",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "natstack": {
    "title": "My Panel",
    "entry": "index.tsx",
    "runtime": "panel",
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
| `title` | string | **Required** | Display name shown in panel UI |
| `entry` | string | `index.tsx` | Entry point file |
| `runtime` | `"panel"` \| `"worker"` | `"panel"` | Determines if built as UI panel or background worker |
| `injectHostThemeVariables` | boolean | `true` | Inherit NatStack theme CSS variables |
| `repoArgs` | string[] | `[]` | Named repo argument slots that callers must provide via `createChild` |
| `exposeModules` | string[] | `[]` | Extra module specifiers to expose via `__natstackRequire__` (bundled even if not directly imported) |

## Panel API

NatStack panels and workers share the same `@natstack/runtime` API surface (selected via build conditions).

```ts
import {
  // Identity
  id,
  parentId,

  // Core services
  rpc,
  db,
  fs,
  fetch,
  parent,

  // Parent handles
  getParent,
  getParentWithContract,

  // Child management
  createChild,
  createChildWithContract,
  children,
  getChild,
  onChildAdded,
  onChildRemoved,

  // Lifecycle
  removeChild,
  close,
  getEnv,
  getInfo,

  // Theme/focus
  getTheme,
  onThemeChange,
  onFocus,

  // Startup data
  gitConfig,
  bootstrap,
  bootstrapError,
} from "@natstack/runtime";
```

### Creating Child Panels

Use the spec-based `createChild()` API (returns a `ChildHandle`, not just an ID):

```typescript
// Create an app panel
const editor = await createChild({
  type: 'app',
  name: 'editor',
  source: 'panels/editor',
  env: { FILE_PATH: '/foo.txt' },
});

// Create a worker
const computeWorker = await createChild({
  type: 'worker',
  name: 'compute-worker',
  source: 'workers/compute',
});

// Create a browser panel
const browser = await createChild({
  type: 'browser',
  name: 'web-scraper',
  source: 'https://example.com',
  title: 'Web Scraper',
});
```

### Child Spec Types

#### App Panel Spec
```typescript
interface AppChildSpec {
  type: 'app';
  name?: string;                 // Optional name (stable ID within parent if provided)
  source: string;                // Workspace-relative path to source
  env?: Record<string, string>;  // Environment variables
  sourcemap?: boolean;           // Emit inline sourcemaps (default: true)
  gitRef?: string;               // Git ref (branch, tag, or commit SHA)
  repoArgs?: Record<string, RepoArgSpec>; // Must match child's manifest repoArgs
}
```

#### Worker Spec
```typescript
interface WorkerChildSpec {
  type: 'worker';
  name?: string;                 // Optional name (stable ID within parent if provided)
  source: string;                // Workspace-relative path to source
  env?: Record<string, string>;  // Environment variables
  unsafe?: boolean | string;     // Run with Node.js APIs; string = custom fs root path
  gitRef?: string;               // Git ref (branch, tag, or commit SHA)
  repoArgs?: Record<string, RepoArgSpec>; // Must match child's manifest repoArgs
}
```

#### Browser Panel Spec
```typescript
interface BrowserChildSpec {
  type: 'browser';
  name?: string;                 // Optional name
  source: string;                // Initial URL to load
  title?: string;                // Optional title (defaults to URL hostname in UI)
  env?: Record<string, string>;  // Environment variables
}
```

### Other Panel Methods

```typescript
// Remove a child panel
await editor.close();          // Preferred when you have a handle
await removeChild(editor.id);  // Also available if you only have the id

// Close current panel
await close();

// Get panel info
const info = await getInfo();
console.log(info.panelId, info.partition);

// Get environment variables
const env = await getEnv();
console.log(env.PARENT_ID);

// Theme
const theme = getTheme(); // "light" | "dark"
const unsubscribe = onThemeChange((appearance) => {
  console.log("Theme changed:", appearance);
});
```

### Browser Automation API

Control browser panels programmatically with Playwright:

```typescript
import { chromium } from 'playwright-core';

// Create browser panel
const browser = await createChild({
  type: 'browser',
  name: 'automation-target',
  source: 'https://example.com',
});

// Get CDP endpoint for Playwright
const cdpUrl = await browser.getCdpEndpoint();

// Connect Playwright
const browserConn = await chromium.connectOverCDP(cdpUrl);
const page = browserConn.contexts()[0].pages()[0];

// Automate!
await page.click('.button');
await page.fill('input[name="search"]', 'query');
const content = await page.textContent('.result');
```

Browser navigation methods live on the returned `ChildHandle`:

```typescript
await browser.navigate("https://example.com");
await browser.goBack();
await browser.reload();
await browser.stop();
```

### Git Configuration API

Access git configuration:

```typescript
if (!gitConfig) throw new Error("Git config not available");
// { serverUrl, token, sourceRepo, resolvedRepoArgs, gitRef? }
```

### Auto-Bootstrap for repoArgs

Panels that declare `repoArgs` in their manifest get **automatic bootstrapping**. The framework clones the specified repos into OPFS **before** the panel code loads.

**1. Declare repoArgs in package.json:**

```json
{
  "natstack": {
    "title": "My Panel",
    "entry": "index.tsx",
    "repoArgs": ["history", "config"]
  }
}
```

**2. Parent passes repo paths when creating child:**

```typescript
await createChild({
  type: "app",
  name: "my-panel",
  source: "panels/my-panel",
  repoArgs: {
    history: "state/my-history",   // cloned to /args/history
    config: "config/my-settings",  // cloned to /args/config
  },
});
```

**3. Access cloned repos via `bootstrap`:**

```typescript
// Bootstrap runs automatically before panel loads!
// Just access the result:
const bootstrapResult = bootstrap;

if (bootstrapResult && gitConfig) {
  const historyPath = bootstrapResult.argPaths.history;  // "/args/history"
  const configPath = bootstrapResult.argPaths.config;    // "/args/config"

  // Use with GitClient for git operations
  const git = new GitClient(fs, {
    serverUrl: gitConfig.serverUrl,
    token: gitConfig.token,
  });

  await git.pull({ dir: historyPath });
}

// Check for errors
if (bootstrapError) {
  console.error("Bootstrap failed:", bootstrapError);
}
```

### Event Listeners

```typescript
// Listen for child removal
const unsubscribe = onChildRemoved((childId) => {
  console.log(`Child ${childId} was removed`);
});

// Listen for focus events
const unsubscribe = onFocus(() => {
  console.log("Panel received focus");
});
```

## Workers

Workers are background processes that run in a WebContentsView with a built-in console UI. They're useful for long-running tasks that shouldn't block the main panel UI.

### Creating a Worker

```typescript
const worker = await createChild({
  type: 'worker',
  name: 'my-worker',
  source: 'workers/compute',
  env: { MODE: 'production' },
});
```

### Worker Manifest

Workers use the same `package.json` format but with `runtime: "worker"`:

```json
{
  "name": "@workspace-workers/compute",
  "natstack": {
    "title": "Compute Worker",
    "runtime": "worker"
  }
}
```

### Communicating with Workers

Use RPC to communicate with workers:

```typescript
// In parent panel
const worker = await createChild<WorkerAPI>({ type: "worker", source: "workers/compute" });
const result = await worker.call.compute(data);

// In worker (workers/compute/index.ts)
import { rpc } from "@natstack/runtime";

rpc.expose({
  async compute(data: number[]) {
    return data.reduce((a, b) => a + b, 0);
  }
});
```

## Host Theme Variables

By default, NatStack injects the host application's CSS variables into each panel. Panels can opt out by setting `injectHostThemeVariables: false` in the manifest.

```css
body {
  background: var(--color-surface);
  color: var(--color-text);
}
```

### Radix Theme Provider

For Radix UI panels, wire host theme appearance into Radix `Theme`:

```tsx
import React from "react";
import { Theme } from "@radix-ui/themes";
import { usePanelTheme } from "@natstack/react";

export default function App() {
  const appearance = usePanelTheme(); // "light" | "dark"
  return (
    <Theme appearance={appearance}>
      {/* panel UI */}
    </Theme>
  );
}
```

## Build System

### Caching
- Panels are built on-demand when first loaded
- Build results are cached based on source file hashes
- Cache is stored in the platform-specific state directory

### State Directory

| Platform | Path |
|----------|------|
| Linux | `~/.config/natstack/` |
| macOS | `~/Library/Application Support/natstack/` |
| Windows | `%APPDATA%/natstack/` |

## Loading States

The UI automatically shows:
- **Loading spinner** - While the panel is being built
- **Error message** - If the build fails
- **Panel content** - Once successfully built

## Example Panels

See these example panels in the repository:

- `panels/example/` - Root panel with child management, OPFS, typed RPC
- `panels/agentic-chat/` - AI integration with Vercel AI SDK
- `panels/agentic-notebook/` - Jupyter-style notebook with AI
- `panels/shared-opfs-demo/` - Shared file storage demo

## Development Workflow

1. Create a new panel directory in `panels/`
2. Add a `package.json` with a `natstack` field
3. Write your panel code in TypeScript
4. Launch the panel from the launcher or from another panel using `createChild()`
5. The panel will be built automatically on first load

## Context Templates

NatStack provides a **context template system** for efficiently creating pre-populated panel sandboxes. This is similar to Docker - you define a template once, build it, and then quickly spin up new instances from that template.

### Why Context Templates?

For **agentic workloads**, you often need multiple AI agent sessions with the same base environment:
- Same tool repositories
- Same prompt libraries
- Same data files

Without templates, each new agent would need to clone and set up everything from scratch. With templates, the setup happens **once** and each new session gets an instant copy.

### Template Definition

Create a `context-template.yml` in your panel or context directory:

```yaml
# Optional: inherit from another template
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
    repo: shared/prompts
    ref: main
```

### How It Works

1. **Resolve**: NatStack follows `extends` chains and merges all dependencies
2. **Hash**: Computes a SHA256 hash of the final specification
3. **Build** (if needed): A background worker clones all repos to OPFS
4. **Copy**: The pre-built template is copied to the panel's context partition

This ensures templates are built once and reused across many panel instances.

### Context ID Formats

- **Safe panels**: `safe_tpl_{hash}_{instanceId}` - uses templates
- **Unsafe panels**: `unsafe_noctx_{instanceId}` - no templates (Node.js fs access)

See [OPFS_PARTITIONS.md](OPFS_PARTITIONS.md) for full documentation on context templates.

## Workspace Package System

NatStack uses a workspace package system that enables panels to share code, types, and RPC contracts with each other. Panels and packages are published to an internal Verdaccio npm registry that runs locally.

### Package Scopes

| Scope | Location | Description |
|-------|----------|-------------|
| `@workspace-panels/*` | `workspace/panels/` | Panel packages (apps and workers) |
| `@workspace-workers/*` | `workspace/workers/` | Worker packages |
| `@workspace/*` | `workspace/packages/` | Shared utility packages |

### Cross-Panel Imports

Panels can depend on other panels to share types, utilities, and RPC contracts. This enables **typed communication** between parent and child panels.

**1. Child panel exports its contract:**

```json
// panels/editor/package.json
{
  "name": "@workspace-panels/editor",
  "exports": {
    ".": "./index.tsx",
    "./contract": "./contract.ts"
  }
}
```

**2. Parent panel declares dependency:**

```json
// panels/ide/package.json
{
  "dependencies": {
    "@workspace-panels/editor": "workspace:*"
  }
}
```

**3. Parent imports and uses the contract:**

```typescript
// panels/ide/index.tsx
import { editorContract } from "@workspace-panels/editor/contract";
import { createChildWithContract } from "@natstack/runtime";

const editor = await createChildWithContract(editorContract);
await editor.call.setContent("Hello!"); // Fully typed!
```

### Existing Cross-Panel Dependencies

Several panels already use this pattern:

- `project-launcher` imports types from `@workspace-panels/project-panel/types`
- `chat-launcher` imports utilities from `@workspace-panels/agent-manager`

### TypeScript Resolution

The build system resolves workspace imports at both type-check time and bundle time:

- TypeCheckService resolves `@workspace-panels/*`, `@workspace-workers/*`, and `@workspace/*` imports
- esbuild bundles the dependencies into the final panel build
- The Verdaccio registry serves packages for dependency resolution

## Typed RPC Contracts

For type-safe parent-child communication, use the contract-based RPC pattern:

### Defining a Contract

```typescript
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
      "content-changed": z.object({ content: z.string() }),
    },
  },
  // Optional: events parent sends to child
  // parent: {
  //   emits: {
  //     "theme-changed": z.object({ theme: z.enum(["light", "dark"]) }),
  //   },
  // },
});
```

### Child Panel Implementation

```typescript
// panels/editor/index.tsx
import { useEffect, useState } from "react";
import { rpc, getParentWithContract, noopParent } from "@natstack/runtime";
import { editorContract } from "./contract.js";

// Get typed parent handle (noop fallback avoids null checks)
const parent = getParentWithContract(editorContract) ?? noopParent;

export default function Editor() {
  const [content, setContent] = useState("");

  useEffect(() => {
    rpc.expose({
      async getContent() { return content; },
      async setContent(text: string) { setContent(text); },
      async save(path: string) {
        // Emit typed event to parent
        parent.emit("saved", { path, timestamp: new Date().toISOString() });
      },
    });
  }, [content]);

  return <textarea value={content} onChange={(e) => setContent(e.target.value)} />;
}
```

### Parent Panel Implementation

```typescript
// panels/ide/index.tsx
import { useState, useEffect } from "react";
import { createChildWithContract } from "@natstack/runtime";
import { editorContract } from "@workspace-panels/editor/contract";

export default function IDE() {
  const [editor, setEditor] = useState<Awaited<ReturnType<typeof createChildWithContract<typeof editorContract>>> | null>(null);

  const launchEditor = async () => {
    const child = await createChildWithContract(editorContract, { name: "editor" });
    setEditor(child);
  };

  useEffect(() => {
    if (!editor) return;
    // Typed event listener
    return editor.onEvent("saved", ({ path, timestamp }) => {
      console.log(`File saved: ${path} at ${timestamp}`);
    });
  }, [editor]);

  return (
    <div>
      <button onClick={launchEditor}>Launch Editor</button>
      <button onClick={() => editor?.call.save("/file.txt")}>Save</button>
    </div>
  );
}
```

### Contract API Reference

```typescript
// Define a contract
defineContract({
  source: string;                    // Panel source path
  child?: {
    methods?: InterfaceType;         // TypeScript interface (phantom type)
    emits?: Record<string, ZodSchema>; // Events child emits (validated)
  };
  parent?: {
    methods?: InterfaceType;         // Methods parent exposes
    emits?: Record<string, ZodSchema>; // Events parent emits
  };
});

// Parent side
const child = await createChildWithContract(contract, options?);
child.call.methodName(...args);      // Typed RPC calls
child.onEvent("event", (payload) => {}); // Typed event listeners
child.emit("parent-event", payload); // Emit to child (if parent.emits defined)

// Child side
const parent = getParentWithContract(contract) ?? noopParent;
parent.emit("event", payload);       // Typed event emission
parent.call.methodName(...args);     // Call parent methods (if parent.methods defined)
parent.onEvent("event", (payload) => {}); // Listen for parent events
```

### noopParent

Use `noopParent` as a fallback when the panel may run without a parent:

```typescript
import { getParentWithContract, noopParent } from "@natstack/runtime";

const parent = getParentWithContract(contract) ?? noopParent;

// Safe to call even if no parent exists
parent.emit("event", payload); // Silently does nothing
```

## Notes

- Panels are isolated in separate webviews
- Each panel has its own persistent context-based storage (see OPFS_PARTITIONS.md)
- Safe panels can use context templates for pre-populated OPFS sandboxes
- Workers run in WebContentsView with a built-in console UI for logging
- Browser panels support full Playwright automation via CDP
- Panels can import from other panels using workspace package dependencies
