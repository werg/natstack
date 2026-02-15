# React-to-Preact Migration Evaluation

## Executive Summary

**Recommendation: Do not migrate.** The primary benefit of Preact (bundle size) is
largely irrelevant in an Electron app serving assets from local disk. The migration
carries high risk from third-party library incompatibility (especially Radix UI) and
would require substantial rework of custom build infrastructure — for negligible
user-facing improvement.

---

## Architecture Context

NatStack uses React in two distinct contexts:

1. **Shell app** (`src/renderer/`) — pre-built Electron renderer with Jotai state,
   React.lazy/Suspense, and dnd-kit for panel tree drag-and-drop.

2. **Panel mini-apps** (`workspace/panels/`) — 5 panels built on-demand via esbuild,
   each running in an isolated Electron webview. Panels auto-mount via
   `@workspace/react`'s `createReactPanelMount()` / `autoMountReactPanel()` system,
   with a custom module deduplication plugin ensuring a single React instance per
   panel build.

Both contexts use React 19.2.0.

---

## What Would Be Gained

### Bundle size reduction
- react + react-dom: ~42 KB min+gzip
- preact + preact/compat: ~4 KB min+gzip
- **Theoretical savings: ~38 KB per bundle**

### Memory reduction
- Preact's VDOM is lighter. Each panel webview would use slightly less memory for
  its React tree.

### Startup time
- Smaller JS to parse/evaluate could shave a few ms off panel initialization.

---

## Why Those Gains Don't Matter Here

### 1. Local disk, not network
All bundles are served from Electron's local filesystem. The 38 KB difference is
read from an SSD in <1 ms. There is no CDN, no network waterfall, no mobile 3G
scenario. The entire value proposition of Preact's size advantage evaporates.

### 2. Electron dwarfs everything
Electron itself loads ~150 MB of Chromium + Node.js. The shell renderer and each
panel webview spin up a full Chromium process. In this context, 38 KB of JS is
noise — it's <0.03% of the runtime footprint.

### 3. Parse time is negligible
V8's streaming compilation in Chromium handles 42 KB of React in under 5 ms on
any modern machine. Panel startup is dominated by esbuild compilation from git
source, IPC handshake, and webview process creation — not JS parse time.

### 4. Memory savings are marginal
Each Chromium webview process consumes 30-80 MB baseline. Preact's lighter VDOM
might save 1-2 MB per panel. With typical usage of 3-5 open panels, that's
5-10 MB savings against 150-400 MB of webview overhead.

---

## Migration Risks (High to Low)

### CRITICAL: Radix UI Themes incompatibility
The entire UI is built on `@radix-ui/themes` (^3.2.1) plus individual Radix
primitives (`react-accordion`, `react-alert-dialog`, `react-collapsible`,
`react-context-menu`). Radix deeply uses React internals:
- React.createContext / useContext for component composition
- forwardRef extensively
- Portals for overlays/dialogs
- Fine-grained ref management

Radix UI **does not officially support Preact** and is not tested against
preact/compat. Users have reported breakage with Radix + Preact, particularly
around portal rendering, focus management, and context propagation. This alone
is likely a showstopper.

**Affected files:** Virtually every panel component, plus the shell's settings
dialogs and UI chrome.

### HIGH: React 19 compatibility gap
The app runs React 19.2.0. Preact's compat layer targets React 16-18. While
NatStack doesn't use React 19-specific APIs (`useTransition`, `use()`,
`useActionState`), React 19 changed reconciler behavior, automatic batching
semantics, and ref handling (refs as props). Preact/compat may exhibit subtle
behavioral differences.

### HIGH: dnd-kit integration
`@dnd-kit/core` (^6.3.1) and `@dnd-kit/sortable` (^10.0.0) power the panel
tree drag-and-drop system in `PanelDndContext.tsx`. dnd-kit uses React context
heavily and relies on React's synthetic event system for pointer tracking.
Preact's event normalization differs from React's — pointer event handling and
bubbling/capturing could break.

### MEDIUM: Custom build infrastructure rework
The panel build system has React deeply embedded:
- `builder.ts:806-807` — `hasReact` detection for `@workspace/react` dependency
- `builder.ts:672-689` — `generatePanelEntry()` conditionally generates React
  auto-mount wrapper code
- `builder.ts:799-802` — `DEFAULT_DEDUPE_PACKAGES` hardcodes `react`,
  `react-dom`, `react/jsx-runtime`, `react/jsx-dev-runtime`
- `builder.ts:411-450` — `createDedupePlugin()` ensures single React instance
- All panel `package.json` files declare `exposeModules` including `react`,
  `react/jsx-runtime`, `react/jsx-dev-runtime`
- `reactPanel.ts` — `createReactPanelMount()` takes React namespace as a
  parameter and calls `ReactLib.createElement`, `ReactLib.useState`,
  `ReactLib.useEffect`, `ReactLib.Fragment` directly
- `autoMount.ts` — imports `React` and `createRoot` from `react-dom/client`

All of this would need to be rewritten to resolve `preact/compat` instead, with
the alias configuration threaded through esbuild builds.

### MEDIUM: jotai compatibility
Jotai (^2.15.1) is used for shell state management. Jotai internally uses
`useSyncExternalStore` (React 18+). While jotai has basic Preact support, it's
not a first-class target, and edge cases around concurrent batching behavior
may differ.

### MEDIUM: Error boundaries (5 implementations)
- `ChunkErrorBoundary.tsx` — uses `getDerivedStateFromError` + `componentDidCatch`
- `ErrorBoundary.tsx` in tool-ui, git-ui, agentic-chat
- `InlineUiMessage.tsx` — uses `getDerivedStateFromError` with `prevResetKey`

Preact's native error boundary support differs from React's. The compat layer
adds `getDerivedStateFromError` but behavior under re-render cascades may differ.

### LOW: @tanstack/react-virtual
Used in `LazyPanelTreeSidebar.tsx` for virtualized panel tree. TanStack
libraries generally work with preact/compat, but this is not a tested
configuration.

### LOW: react-markdown
Used in agentic-chat for rendering LLM responses. Should work via compat, but
edge cases in markdown rendering (especially with rehype-highlight and
remark-gfm plugins) are possible.

---

## Effort Estimate

Even assuming all libraries work via preact/compat:

| Area | Scope |
|------|-------|
| Build system aliases | Modify esbuild configs, dedupe plugin, panel entry gen |
| @workspace/react package | Rewrite reactPanel.ts, autoMount.ts, all hooks |
| Shell app | Update imports, test all interactions |
| 5 panel mini-apps | Update entry points, verify rendering |
| 10+ about pages | Update createRoot calls |
| 5 error boundaries | Verify behavior |
| Type definitions | Alias or replace @types/react, @types/react-dom |
| Testing infrastructure | Verify vitest + Playwright continue to work |
| **Third-party lib verification** | **Manual testing of Radix, dnd-kit, jotai, tanstack** |

The third-party verification is the real cost. You'd need to build the full app,
exercise every Radix component variant, test drag-and-drop, test state management
under rapid updates, and verify markdown rendering — all looking for subtle
regressions.

---

## Partial Migration: Panels Only?

One might consider migrating only the panels (leaving the shell on React), since
panels are isolated webviews. But this doesn't help:

- Panels also use Radix UI Themes (the same incompatibility problem).
- The `@workspace/react` package and build infrastructure serve both contexts.
- You'd maintain two rendering stacks, doubling complexity.
- The size savings in panel webviews are still irrelevant (local disk).

---

## When Preact Would Make Sense

Preact would be a strong choice if NatStack were:
- A **web app** served over the network (especially targeting mobile)
- Using a **lightweight component library** (not Radix)
- On **React 18** (better compat layer support)
- Not relying on a custom module sharing/dedup system

---

## Conclusion

The migration cost is high, the risk is high (Radix UI alone may be a hard
blocker), and the benefits are negligible in an Electron context. The engineering
effort would be better spent on things that actually affect user experience:
panel build speed, startup time optimization in the Electron main process, or
reducing webview process count.
