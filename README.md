# Panel App

A horizontally stacked panel application built with Electron and TypeScript with strict type discipline.

## Features

- ⚡ Modern Electron with TypeScript
- 🔒 Strict type checking and ESLint configuration
- 🎨 Responsive two-panel layout with draggable divider
- 🛠️ esbuild for fast bundling
- 📦 pnpm for package management
- 🎯 Browser-like behavior with native context menus

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

## Project Structure

```
src/
  main/        - Main process (Electron)
  preload/     - Preload script (context bridge)
  renderer/    - Renderer process (UI)
build.mjs      - esbuild configuration
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
