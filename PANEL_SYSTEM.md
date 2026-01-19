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
├── api.ts              # Optional: Exported RPC types for parent panels
└── style.css           # Styles (optional)
```

## Manifest Format

Panel configuration is specified in `package.json` with a `natstack` field:

```json
{
  "name": "@natstack-panels/my-panel",
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
  setTitle,
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
  branch?: string;           // Git branch to track
  commit?: string;           // Specific commit hash
  tag?: string;              // Git tag to pin to
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
  branch?: string;               // Git branch to track
  commit?: string;               // Specific commit hash
  tag?: string;                  // Git tag to pin to
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
// Set panel title
await setTitle("My Custom Title");

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
// { serverUrl, token, sourceRepo, resolvedRepoArgs, branch?, commit?, tag? }
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
  "name": "@natstack-workers/compute",
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
4. Launch the panel from another panel using `createChild()`
5. The panel will be built automatically on first load

### Root Panel Path

NatStack picks the initial root panel path in this order:

1. Command-line flag `--root-panel=/path/to/panel`
2. Saved preference (`preferences.json` under the NatStack config directory)
3. A default panel cloned into `<config dir>/Default Root Panel` on first run

## Notes

- Panels are isolated in separate webviews
- Each panel has its own persistent context-based storage (see OPFS_PARTITIONS.md)
- Workers run in WebContentsView with a built-in console UI for logging
- Browser panels support full Playwright automation via CDP
