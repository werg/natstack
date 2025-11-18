# Natstack

A tree-based browser with hierarchical panel navigation built on Electron.

## Features

- **Tree Panel Navigation**: Organize browser sessions in a hierarchical tree structure
- **Breadcrumb UI**: Navigate through parent and child panels with intuitive breadcrumb navigation
- **Tab Siblings**: Multiple panels at the same level appear as tabs for easy switching
- **Embedded Browser**: Each panel contains a full webview with real web browsing capability
- **Dark Mode**: Automatic theme synchronization with your system preferences

## Requirements

- Node.js 20+
- pnpm

## Installation

```bash
pnpm install
```

## Scripts

- `pnpm dev` - Build and start in development mode with DevTools (sandbox disabled for compatibility)
- `pnpm dev:safe` - Same as dev but with sandbox enabled (may not work in all environments)
- `pnpm build` - Production build
- `pnpm start` - Start the app (requires prior build)
- `pnpm lint` - Run ESLint with strict rules
- `pnpm format` - Format code with Prettier
- `pnpm format:check` - Check formatting
- `pnpm type-check` - Type check without emitting

## How It Works

Each panel in Natstack is a browser session that can have child panels. This creates a tree structure where you can:

1. **Navigate down**: Click "Add Child Browser" to create a nested browser panel
2. **Navigate up**: Use ancestor breadcrumbs to go back to parent panels
3. **Navigate sideways**: Click sibling tabs to switch between panels at the same level
4. **Navigate down through descendants**: Click descendant breadcrumbs to jump to child panels

Every panel displays a random website from a curated list (Wikipedia, GitHub, Hacker News, Reddit, Stack Overflow).

## Project Structure

```
src/
  main/            - Main process (Electron)
  preload/         - Preload script (context bridge)
  renderer/        - Renderer process (UI)
    components/    - React components
      PanelStack.tsx - Main tree browser component
      PanelApp.tsx   - Root app component with theme
      TitleBar.tsx   - Custom window title bar
    state/         - Jotai state management
build.mjs          - esbuild configuration
```

## Type Safety

This project enforces strict TypeScript configuration:
- No implicit any
- Strict null checks
- Strict function types
- No unchecked indexed access
- Property initialization required
- Unused variables/labels disallowed

All ESLint rules are configured for maximum type safety and best practices.

## Development

Start the development server:

```bash
pnpm dev
```

The app will open with DevTools enabled for debugging.

### Sandbox Mode

By default, `pnpm dev` runs with `--no-sandbox` flag due to common Linux environment restrictions (WSL2, containers, etc.). This is **only for development**.

- **For development on systems with sandbox issues**: Use `pnpm dev` (sandbox disabled via `ELECTRON_NO_SANDBOX=1`)
- **For development on systems with working sandbox**: Use `pnpm dev:safe` (full security)
- **Production builds**: Always run with sandbox enabled (default)

If you need to disable sandbox in other scenarios, set the environment variable:
```bash
ELECTRON_NO_SANDBOX=1 pnpm start
```

⚠️ **Security Warning**: Only disable sandbox in trusted development environments. Never ship production builds with sandbox disabled.

## Building for Production

```bash
pnpm build
pnpm start
```

## Dark Mode

The application automatically respects your system's dark/light mode preference. The theme is:

- **Automatically synchronized** with your OS theme settings
- **Persistently stored** in localStorage for your preference
- **Live updated** when you change your system theme
- **Seamlessly integrated** with Electron's `nativeTheme` API

### How It Works

1. **System Preference Detection**: The app uses CSS media queries (`prefers-color-scheme`) and Electron's `nativeTheme` API to detect your system's theme preference
2. **State Management**: Theme state is managed using Jotai atoms in [src/renderer/state/themeAtoms.ts](src/renderer/state/themeAtoms.ts)
3. **IPC Communication**: The main process and renderer process communicate theme changes via IPC channels
4. **CSS Variables**: All colors are defined as CSS custom properties that automatically switch based on the theme

The implementation includes:
- Theme state management in [src/renderer/state/themeAtoms.ts](src/renderer/state/themeAtoms.ts)
- IPC handlers in [src/main/index.ts](src/main/index.ts#L91-L105)
- Theme synchronization hook in [src/renderer/components/PanelApp.tsx](src/renderer/components/PanelApp.tsx#L57-L119)
