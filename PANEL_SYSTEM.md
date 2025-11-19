# Panel System Documentation

## Overview

The NatStack panel system allows you to create dynamically loaded, hierarchical panels that can spawn child panels. Each panel is an independent TypeScript/JavaScript project that gets compiled on-the-fly using esbuild.

## Panel Structure

A panel is a directory containing:

```
my-panel/
├── panel.json          # Manifest file (required)
├── index.ts            # Default entry (index.tsx / index.jsx are also detected)
├── index.html          # HTML template (optional, auto-generated if missing)
└── .natstack/          # Generated build artifacts + node_modules (created on first build)
└── style.css           # Styles (optional)
```

## Manifest Format

`panel.json` is a simple JSON file with the following fields:

```json
{
  "title": "My Panel",           // Required: Default panel title
  "entry": "index.tsx",          // Optional: Entry point (defaults to index.tsx/index.ts/...)
  "dependencies": {               // Optional: npm dependencies
    "lodash": "^4.17.21"
  },
  "injectHostThemeVariables": true // Optional: inherit NatStack theme CSS variables (defaults to true)
}
```

## Panel API

Panels can import the NatStack runtime helper by referencing `natstack/panel` in their TypeScript entry point:

```ts
import panelAPI from "natstack/panel";
```

The helper exposes the following methods:

### `createChild(path: string): Promise<string>`
Creates a child panel at the specified path and returns its ID.

```typescript
const childId = await panelAPI.createChild("panels/my-child");
```

### `setTitle(title: string): Promise<void>`
Sets the title of the current panel.

```typescript
await panelAPI.setTitle("My Custom Title");
```

### `removeChild(childId: string): Promise<void>`
Removes a child panel by ID.

```typescript
await panelAPI.removeChild(childId);
```

### `close(): Promise<void>`
Closes the current panel (removes it from its parent).

```typescript
await panelAPI.close();
```

### `onChildRemoved(callback: (childId: string) => void): () => void`
Listen for child removal events. Returns a cleanup function.

```typescript
const unsubscribe = panelAPI.onChildRemoved((childId) => {
  console.log(`Child ${childId} was removed`);
});

// Later, to cleanup:
unsubscribe();
```

### `onFocus(callback: () => void): () => void`
Listen for focus events. Returns a cleanup function.

```typescript
const unsubscribe = panelAPI.onFocus(() => {
  console.log("Panel received focus");
});
```

### `getTheme(): { appearance: "light" | "dark" }`
Returns the current host theme so the panel can coordinates its UI (useful for Radix or custom theming systems).

### `onThemeChange(callback: (theme) => void): () => void`
Subscribe to host theme changes. The callback is immediately invoked with the current theme and again whenever the user toggles light/dark mode.

### `createRadixThemeProvider(React, ThemeComponent)`
Utility for Radix UI panels. Provide your panel's `React` instance and the `Theme` component from `@radix-ui/themes`, and the helper returns a provider component that keeps the Radix appearance in sync with NatStack:

```tsx
import React from "react";
import { Theme } from "@radix-ui/themes";
import panelAPI, { createRadixThemeProvider } from "natstack/panel";

const NatstackThemeProvider = createRadixThemeProvider(React, Theme);

export function App() {
  return (
    <NatstackThemeProvider>
      {/* panel UI */}
    </NatstackThemeProvider>
  );
}
```

### Host Theme Variables

By default, NatStack automatically injects the host application's CSS variables (including all Radix tokens) into each panel. Panels can opt out by setting `injectHostThemeVariables` to `false` in `panel.json`.

When enabled, you can use the same tokens that Radix exposes in your panel styles:

```css
body {
  background: var(--color-surface);
  color: var(--color-text);
}

.panel-card {
  background: var(--color-panel);
}
```

Combine CSS injection with the `getTheme`/`onThemeChange` API to keep any framework-level theming (Radix `<Theme>`, Tailwind data attributes, etc.) synchronized.

## Build System

### Caching
- Panels are built on-demand when first loaded
- Build results are cached based on source file hashes
- Cached builds are reused until source files change
- Cache is stored in the platform-specific state directory:
  - **Linux**: `~/.config/natstack/panel-cache/`
  - **macOS**: `~/Library/Application Support/natstack/panel-cache/`
  - **Windows**: `%APPDATA%/natstack/panel-cache/`
- To clear the cache, delete this directory or restart NatStack with fresh data

### Dependencies
If your panel specifies npm dependencies in `panel.json`, they will be resolved and installed with `@npmcli/arborist` inside the panel's `.natstack/node_modules` directory. These installs are scoped per panel path, so remember to add `.natstack/` to your `.gitignore` if you create new panels.

### Build Output
Build artifacts live alongside the panel source:
- `.natstack/bundle.js` - Compiled JavaScript bundle (reference it from your HTML via `./.natstack/bundle.js`)
- `.natstack/node_modules` - Dependencies installed for the bundle
- Optional `.natstack/index.html` - Generated only when the panel does not provide its own HTML

Because the renderer loads `index.html` (or the generated fallback) directly from the panel folder, every other static asset (CSS, images, etc.) continues to resolve normally.

### React/TypeScript Helpers

NatStack also ships a lightweight helper (available as `natstack/react`) for authoring panel UIs with React + TypeScript. Usage is entirely optional—plain HTML panels still work the same way.

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import { createReactPanelMount } from "natstack/react";

const mount = createReactPanelMount(React, createRoot, { ThemeComponent: Theme });

function Panel() {
  return <div>Hello from React!</div>;
}

mount(Panel);
```

The helper automatically mounts into the `#root` element provided by your `index.html` (or the generated fallback) and keeps Radix' `<Theme>` synchronized with NatStack’s appearance if you pass it in via `ThemeComponent`.

Entry detection now prefers `index.tsx` when `entry` isn’t specified, followed by `index.ts`, `index.jsx`, `index.js`, `main.tsx`, and `main.ts`—so you can drop an `index.tsx` alongside `index.html` and start building a modern TypeScript/React panel without extra wiring.

## Loading States

The UI automatically shows:
- **Loading spinner** - While the panel is being built
- **Error message** - If the build fails
- **Panel content** - Once successfully built

## Example Panel

See [panels/example/](panels/example/) for a working example that demonstrates:
- Creating child panels
- Setting panel title
- Listening to events
- Basic styling

## Development Workflow

1. Create a new panel directory in `panels/`
2. Add a `panel.json` manifest
3. Write your panel code in TypeScript
4. Launch the panel from another panel using `panelAPI.createChild()`
5. The panel will be built automatically on first load

### Root Panel Path

NatStack picks the initial root panel path in this order:

1. Command-line flag `--root-panel=/path/to/panel`
2. Saved preference (`preferences.json` under the NatStack config directory)
3. A default panel cloned into `<config dir>/Default Root Panel` on first run

During development we pass `--root-panel=panels/example` via `pnpm dev`. To switch panels at runtime you can relaunch with a new flag or update the preference file.

## State Directory

NatStack stores application state (panel build cache, etc.) in a platform-specific directory:

- **Linux**: `~/.config/natstack/`
- **macOS**: `~/Library/Application Support/natstack/`
- **Windows**: `%APPDATA%/natstack/`

This directory contains:
- `panel-cache/` - Cached panel builds and metadata
- Future: settings, logs, and other persistent data

## Notes

- Panels are isolated in separate webviews
- Each panel has its own persistent session storage
- Directory traversal is allowed for panel paths
- Paths are resolved relative to where the Electron app is invoked
- Panel source and builds (`.natstack/`) remain in the panel directory for quick iteration
- Build errors are displayed directly in the UI
