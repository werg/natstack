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

### 2. Distribution

NatStack ships a single ambient `.d.ts` alongside the app build:
- `dist/panelRuntimeGlobals.d.ts`

Panel repos can opt in by referencing this file from `tsconfig.json` (for example via `include` or `files`), or by consuming an equivalent published types package.

### 3. No Repo Artifacts

NatStack does not write generated `.d.ts` files into panel/worker repositories (no per-repo `.natstack/` build directories).

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
1. Main app build emits:
   dist/panelRuntimeGlobals.d.ts

2. Panel repo TypeScript:
   Includes dist/panelRuntimeGlobals.d.ts
   → Provides process.env + runtime shims types
```

### File Locations

```
dist/panelRuntimeGlobals.d.ts           # App build output (gitignored)
```

### Why This Approach?

**Advantages**:
- ✅ No pollution of panel source directories
- ✅ Single shared ambient definition file
- ✅ Minimal type surface (only what panels actually need)
- ✅ Consistent with centralized build artifacts philosophy
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
- Ensure `dist/panelRuntimeGlobals.d.ts` exists (rebuild the app if needed).
- Ensure your panel `tsconfig.json` includes `dist/panelRuntimeGlobals.d.ts` (directly or via a shared base config).

**Types not updating**
- Rebuild the main app: `npm run build`
- Restart your TypeScript language server

**Conflicts with @types/node**
- Don't add `@types/node` to panel dependencies
- If you need Node.js types for tooling, use `tsconfig.json` with `types: []` to exclude them from panel compilation
