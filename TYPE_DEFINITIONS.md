# Type Definitions for Panels

This document explains how TypeScript types are provided to NatStack panels without requiring `@types/node`.

## The Problem

Panels need access to `process.env` to read environment variables passed from parent panels. However, adding `@types/node` to panels would:
- Include thousands of Node.js-specific types that don't apply to browser contexts
- Create confusion about what APIs are actually available
- Increase TypeScript compilation time
- Pollute the global namespace with Node.js APIs

## The Solution

NatStack provides minimal, browser-safe type definitions through the panel runtime system:

### 1. Global Type Definitions

**File**: `src/panelRuntime/globals.d.ts`

This file contains ambient type declarations for browser-safe globals:

```typescript
declare const process: {
  readonly env: Readonly<Record<string, string | undefined>>;
};
```

### 2. Build-Time Distribution

During the main app build (`build.mjs`):
- `globals.d.ts` is copied to `dist/panelRuntimeGlobals.d.ts`

When a panel is built (`panelBuilder.ts`):
- The type definition is copied from `dist/panelRuntimeGlobals.d.ts` to the panel's `.natstack/globals.d.ts`
- TypeScript automatically picks up `.d.ts` files in the same directory tree

### 3. No File Pollution

Unlike the previous approach that wrote `natstack.d.ts` to panel root directories:
- Type definitions now live in `.natstack/` (the build artifacts directory)
- Panel source directories remain clean
- `.natstack/` is already gitignored and considered disposable

## How It Works

### For Panel Developers

Panels can directly use `process.env` without any imports:

```typescript
// panels/example/index.tsx
const parentId = process.env.PARENT_ID;  // TypeScript knows this is string | undefined
const message = process.env.MESSAGE;
```

TypeScript will:
- Provide autocomplete for `process.env`
- Type it as `Record<string, string | undefined>`
- Not show any Node.js-specific APIs (like `process.exit`, `process.cwd`, etc.)

### For Runtime

At runtime, `process.env` is provided by the preload script (`src/preload/panelPreload.ts`):

```typescript
contextBridge.exposeInMainWorld("process", { env: syntheticEnv });
```

The environment variables are:
- Extracted from command-line arguments
- Base64 encoded for security
- Scoped to each panel

## Implementation Details

### Build Process Flow

```
1. Main app builds:
   src/panelRuntime/globals.d.ts
   → dist/panelRuntimeGlobals.d.ts

2. Panel builds (on-demand):
   dist/panelRuntimeGlobals.d.ts
   → panels/example/.natstack/globals.d.ts

3. TypeScript in panel:
   Finds .natstack/globals.d.ts
   → Provides process.env types
```

### File Locations

```
src/panelRuntime/globals.d.ts           # Source (version controlled)
dist/panelRuntimeGlobals.d.ts           # Build output (gitignored)
panels/*/.natstack/globals.d.ts         # Panel-specific copy (gitignored)
```

### Why This Approach?

**Advantages**:
- ✅ No pollution of panel source directories
- ✅ Types automatically available when importing `natstack/panel`
- ✅ Minimal type surface (only what panels actually need)
- ✅ Consistent with build artifact philosophy (everything generated goes in `.natstack/`)
- ✅ Easy to extend with more browser-safe globals in the future

**Alternatives Considered**:

1. **@types/node**: Too heavyweight, includes Node.js-specific APIs
2. **Writing to panel root**: Pollutes source directories
3. **Requiring explicit import**: Extra boilerplate for every panel
4. **Triple-slash directives**: Would still require files in panel directories

## Adding New Global Types

To add new browser-safe globals (like `navigator`, `window`, etc.):

1. Edit `src/panelRuntime/globals.d.ts`:
   ```typescript
   declare const myGlobal: {
     someMethod(): void;
   };
   ```

2. Rebuild the app: `npm run build`

3. Types automatically available in all panels!

## Troubleshooting

**"Cannot find name 'process'"**
- The panel hasn't been built yet. Run the app or trigger a panel build.
- Check that `.natstack/globals.d.ts` exists in the panel directory.

**Types not updating**
- Clear the panel cache: `rm -rf panels/your-panel/.natstack/`
- Rebuild the main app: `npm run build`
- Restart your TypeScript language server

**Conflicts with @types/node**
- Don't add `@types/node` to panel dependencies
- If you need Node.js types for tooling, use `tsconfig.json` with `types: []` to exclude them from panel compilation
