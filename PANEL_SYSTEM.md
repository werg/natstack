# Panel System Documentation

## Overview

The NatStack panel system allows you to create dynamically loaded, hierarchical panels that can spawn child panels, workers, and browser panels. Each panel is an independent TypeScript/JavaScript project that gets compiled on-the-fly using esbuild.

## Panel Types

NatStack supports three types of panels:

| Type | Description | Use Case |
|------|-------------|----------|
| `app` | Built webview from source code | UI components, editors, dashboards |
| `worker` | Isolated-vm background process | CPU-intensive tasks, long-running computations |
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
    "singletonState": false,
    "repoArgs": ["history", "components"]
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
| `runtime` | `"panel"` \| `"worker"` | `"panel"` | Determines if built as UI panel or background worker |
| `injectHostThemeVariables` | boolean | `true` | Inherit NatStack theme CSS variables |
| `singletonState` | boolean | `false` | Share storage across all instances |
| `repoArgs` | string[] | `[]` | Named repo argument slots that callers must provide via `createChild` |

## Panel API

Import the panel API from `@natstack/core`:

```ts
import { panel } from "@natstack/core";
```

### Creating Child Panels

Use the spec-based `createChild()` API:

```typescript
// Create an app panel
const editorId = await panel.createChild({
  type: 'app',
  name: 'editor',
  path: 'panels/editor',
  env: { FILE_PATH: '/foo.txt' },
});

// Create a worker
const computeId = await panel.createChild({
  type: 'worker',
  name: 'compute-worker',
  path: 'workers/compute',
  memoryLimitMB: 512,
});

// Create a browser panel
const browserId = await panel.createChild({
  type: 'browser',
  name: 'web-scraper',
  url: 'https://example.com',
});
```

### Child Spec Types

#### App Panel Spec
```typescript
interface AppChildSpec {
  type: 'app';
  name: string;              // Unique name (becomes part of panel ID)
  path: string;              // Workspace-relative path to source
  env?: Record<string, string>;  // Environment variables
  branch?: string;           // Git branch to track
  commit?: string;           // Specific commit hash
  tag?: string;              // Git tag to pin to
}
```

#### Worker Spec
```typescript
interface WorkerChildSpec {
  type: 'worker';
  name: string;              // Unique name (becomes part of worker ID)
  path: string;              // Workspace-relative path to source
  env?: Record<string, string>;  // Environment variables
  memoryLimitMB?: number;    // Memory limit (default: 1024)
  branch?: string;           // Git branch to track
  commit?: string;           // Specific commit hash
  tag?: string;              // Git tag to pin to
}
```

#### Browser Panel Spec
```typescript
interface BrowserChildSpec {
  type: 'browser';
  name: string;              // Unique name (becomes part of panel ID)
  url: string;               // Initial URL to load
  title?: string;            // Optional title (defaults to URL hostname)
  env?: Record<string, string>;  // Environment variables
}
```

### Other Panel Methods

```typescript
// Set panel title
await panel.setTitle("My Custom Title");

// Remove a child panel
await panel.removeChild(childId);

// Close current panel
await panel.close();

// Get panel info
const info = await panel.getInfo();
console.log(info.panelId, info.partition);

// Get environment variables
const env = await panel.getEnv();
console.log(env.PARENT_ID);

// Theme
const theme = panel.getTheme(); // { appearance: "light" | "dark" }
const unsubscribe = panel.onThemeChange((theme) => {
  console.log("Theme changed:", theme.appearance);
});
```

### Browser Automation API

Control browser panels programmatically with Playwright:

```typescript
import { chromium } from 'playwright-core';

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

#### Browser Methods

```typescript
panel.browser.getCdpEndpoint(browserId): Promise<string>  // Get CDP WebSocket URL
panel.browser.navigate(browserId, url): Promise<void>     // Navigate to URL
panel.browser.goBack(browserId): Promise<void>            // Go back in history
panel.browser.goForward(browserId): Promise<void>         // Go forward in history
panel.browser.reload(browserId): Promise<void>            // Reload page
panel.browser.stop(browserId): Promise<void>              // Stop loading
```

### Git Configuration API

Access git configuration:

```typescript
const gitConfig = await panel.git.getConfig();
// Returns: { serverUrl, token, sourceRepo, resolvedRepoArgs }
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
await panel.createChild({
  type: "app",
  name: "my-panel",
  source: "panels/my-panel",
  repoArgs: {
    history: "state/my-history",   // cloned to /args/history
    config: "config/my-settings",  // cloned to /args/config
  },
});
```

**3. Access cloned repos via panel.bootstrap:**

```typescript
// Bootstrap runs automatically before panel loads!
// Just access the result:
const bootstrap = panel.bootstrap;

if (bootstrap) {
  const historyPath = bootstrap.argPaths.history;  // "/args/history"
  const configPath = bootstrap.argPaths.config;    // "/args/config"

  // Use with GitClient for git operations
  const git = new GitClient(fs, {
    serverUrl: gitConfig.serverUrl,
    token: gitConfig.token,
  });

  await git.pull({ dir: historyPath });
}

// Check for errors
if (panel.bootstrapError) {
  console.error("Bootstrap failed:", panel.bootstrapError);
}
```

### Event Listeners

```typescript
// Listen for child removal
const unsubscribe = panel.onChildRemoved((childId) => {
  console.log(`Child ${childId} was removed`);
});

// Listen for focus events
const unsubscribe = panel.onFocus(() => {
  console.log("Panel received focus");
});
```

## Workers

Workers are background processes that run in isolated-vm. They're useful for CPU-intensive tasks that shouldn't block the UI.

### Creating a Worker

```typescript
const workerId = await panel.createChild({
  type: 'worker',
  name: 'my-worker',
  path: 'workers/compute',
  memoryLimitMB: 512,
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
const handle = panel.rpc.getHandle<WorkerAPI>(workerId);
const result = await handle.call.compute(data);

// In worker (workers/compute/index.ts)
import { panel } from "@natstack/core";

panel.rpc.expose({
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

For Radix UI panels, use the theme provider helper:

```tsx
import React from "react";
import { Theme } from "@radix-ui/themes";
import { panel, createRadixThemeProvider } from "@natstack/core";

const NatstackThemeProvider = createRadixThemeProvider(React, Theme);

export default function App() {
  return (
    <NatstackThemeProvider>
      {/* panel UI */}
    </NatstackThemeProvider>
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
4. Launch the panel from another panel using `panel.createChild()`
5. The panel will be built automatically on first load

### Root Panel Path

NatStack picks the initial root panel path in this order:

1. Command-line flag `--root-panel=/path/to/panel`
2. Saved preference (`preferences.json` under the NatStack config directory)
3. A default panel cloned into `<config dir>/Default Root Panel` on first run

## Notes

- Panels are isolated in separate webviews
- Each panel has its own persistent session storage (unless `singletonState: true`)
- Workers run in isolated-vm with configurable memory limits
- Browser panels support full Playwright automation via CDP
