# Build System V2: Design & Implementation Plan

> Based on the `separate-server` architecture: Electron is a thin GUI shell;
> backend services (Verdaccio, Git, PubSub, AI, builds) run in a spawned
> server process communicating via WebSocket RPC.

## Completed Preliminaries

The following preparatory work has been completed on the `claude/redesign-build-system-bbwn4` branch:

### Unsafe mode removal (commit `7f3ab4a`)

The `unsafe` option (nodeIntegration, no sandbox) has been partially removed. The primary unsafe code paths — preload, view creation, build strategies, and about-page Node.js usage — are eliminated. Remaining cleanup (ns:// URL parsing, `panelBuilder` option signatures, `ContextMode` type, `contextId` unsafe helpers) is tracked in Migration 6 and Migration 7 below. Changes so far:

- **New:** `src/main/ipc/gitServiceHandler.ts` — Main process RPC handler for git operations + scoped filesystem access
- **New:** `src/about-pages/shared/serviceAdapters.ts` — Client-side RPC adapters (`FsPromisesLike`, `GitClient`) that route through the service dispatcher
- **Deleted:** `src/preload/unsafePreload.ts`
- **Modified (21 files):** Removed `unsafe` from `PanelManifest`, `CreateChildOptions`, `WorkerChildSpec`, `PanelBuildOptions`, `WorkerBuildOptions`, `PanelSnapshot` options, `PANEL_SCOPED_OPTIONS`, `panelManager` (creation, navigation, build, worker HTML), `viewManager` (always safe webPreferences), `panelStrategy` (always browser/ESM/splitting), `aboutBuilder` (browser/ESM), `context.ts` (removed `ContextMode`, `isUnsafeContext`, unsafe no-context IDs), `preloadUtils` (removed `initUnsafePreload`, `setUnsafeGlobals`), `build.mjs` (removed unsafePreload config), runtime `fs.ts` (removed Node.js detection, always ZenFS)

This simplifies the build system to a single target (browser/ESM) and eliminates the `unsafe` branching that previously existed in build strategies, HTML generation, preload selection, and WebContentsView configuration.

---

## Guiding Principles

1. **A build is a pure function of source + options.** Same content + same build options = same output. Always.
2. **No cache invalidation.** Content-addressed storage keyed by build keys. Old entries aren't invalidated — they're just unreferenced.
3. **Simplicity over cleverness.** Two concepts replace five cache layers: effective versions + a content-addressed build store.
4. **Speed through precision.** Only rebuild what actually changed. Never nuke everything.
5. **Server-first.** The build system lives in the server process. Electron never touches builds directly.
6. **Workspace-agnostic app.** The production app ships zero workspace content. It opens any workspace path and builds everything from source into its content-addressed store. First launch can be slow; subsequent launches are instant cache hits.

---

## Part 1: Architecture

### Where Builds Run

In `separate-server`, all backend services run in a child process (`src/server/index.ts`). The Electron shell connects as an admin client via WebSocket (`src/main/serverClient.ts`). Panels connect directly to the server via WebSocket RPC (`src/server/rpcServer.ts`).

The V2 build system lives **entirely in the server process**. This means:
- Build orchestration, caching, and file watching all run server-side
- Electron requests builds via RPC (`serverClient.call("build", "getBuild", [...])`)
- Build progress events stream to Electron via the existing `ws:event` mechanism
- The headless server (`src/server/index.ts --standalone`) gets builds for free — no Electron needed

### Effective Versions (The Core Idea)

Every buildable unit — package, panel, agent — gets an **effective version**: a single hash capturing its own content AND all its transitive internal dependencies.

```
ev(leaf)    = hash(content(leaf))
ev(package) = hash(content(package), ev(dep_1), ev(dep_2), ...)
```

Computed bottom-up via topological sort on the package DAG. O(V+E), takes milliseconds for ~30 packages.

**The one invariant:** if `ev(X)` hasn't changed, X's build is still valid. If it has, X must rebuild. No exceptions, no edge cases, no heuristics.

### Build Keys (EV + Options)

The effective version alone is not a sufficient cache key. The same source code produces different output depending on build options:

| Option | Effect on output |
|--------|-----------------|
| `sourcemap: false` | Strips inline source maps from bundle |

The **build key** is the full cache identity:

```
build_key = hash(ev, sourcemap)
```

The store is keyed by build key, not EV alone. Two builds of the same source with different options produce different entries. The `sourcemap` flag is determined from the unit's `package.json` manifest at build time — it is not a caller-supplied knob.

> **Note:** The primary `unsafe` code paths have been removed — safe preload is now the only preload, all panels build with `platform: "browser"` / `format: "esm"`, and the about pages that previously required Node.js access use RPC service calls. Residual `unsafe` references remain in ns:// URL parsing (`nsProtocol.ts`), worker build options (`panelBuilder.ts`), context template types (`ContextMode`, `contextId.ts`), and `preloadUtils.ts` (`ARG_SCOPE_PATH`). These are cleaned up in Migrations 6 and 7.

**gitRef support is intentionally removed.** V1 used gitRef for Verdaccio version-pinning. V2 computes EVs from the working tree. Building arbitrary commits is not a V2 use case.

### System Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                     Git Working Tree                         │
│   workspace/packages/*   workspace/panels/*                  │
│   workspace/about/*      workspace/agents/*                  │
└────────────────────────────────┬─────────────────────────────┘
                                 │ content hashes
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│    SERVER PROCESS          Effective Version Computer         │
│                                                              │
│  1. Discover all packages/panels/agents                      │
│  2. Read dependency graph from package.json files            │
│  3. Topological sort                                         │
│  4. Bottom-up: ev = hash(content, ev(deps...))               │
│  5. Diff against previous EVs → changeset                    │
│                                                              │
│  Memoized: only recomputes from changed nodes upward         │
└────────────────────────────────┬─────────────────────────────┘
                                 │ changeset
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│    SERVER PROCESS          Build Orchestrator                 │
│                                                              │
│  For each changed unit:                                      │
│    key = hash(ev, sourcemap)                                 │
│    if store.has(key) → serve from store                      │
│    else → build with esbuild, write to store                 │
│                                                              │
│  Concurrency: semaphore (4 parallel)                         │
│  Coalescing: dedup concurrent builds of same key             │
│                                                              │
│  Exposes: RPC service "build" for Electron/panel requests    │
└────────────────────────────────┬─────────────────────────────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐
              │  esbuild │ │  esbuild │ │  esbuild │
              │ (panel)  │ │ (about)  │ │ (agent)  │
              └────┬─────┘ └────┬─────┘ └────┬─────┘
                   └────────────┼────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────┐
│             Content-Addressed Build Store                     │
│                                                              │
│  {userData}/builds/{build_key}/                              │
│    ├── bundle.js                                             │
│    ├── bundle.css  (if any)                                  │
│    ├── index.html  (panels only)                             │
│    ├── assets/     (images, fonts, etc.)                     │
│    └── metadata.json                                         │
│                                                              │
│  Immutable. Same key = same content. Forever.                │
│  GC: prune entries unreferenced by any active panel/agent.   │
└──────────────────────────────────────────────────────────────┘

     ┌─────────────────────────────────────────┐
     │         ELECTRON SHELL                   │
     │                                          │
     │  ServerClient ──ws:rpc──► Server:build   │
     │  PanelManager.buildPanel()               │
     │    → serverClient.call("build", ...)     │
     │                                          │
     │  About protocol                          │
     │    → serverClient.call("build", ...)     │
     └─────────────────────────────────────────┘
```

### Internal Package Resolution (No Verdaccio)

Internal packages (`@workspace/*`) resolve at build time via the existing `createNatstackResolvePlugin()` pattern — an esbuild plugin that reads each package's `package.json` exports field and resolves the correct entry point. V2 generalizes this across the whole workspace.

Exports fields use **condition objects**, not plain strings:

```json
{
  ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./config": { "types": "./dist/config-entry.d.ts", "default": "./dist/config-entry.js" }
}
```

The resolve plugin uses `resolveExportSubpath()` from `@natstack/typecheck` which recursively walks condition objects against `BUNDLE_CONDITIONS`:

```typescript
// Plugin resolves @workspace/* imports using package.json exports
build.onResolve({ filter: /^@workspace\// }, (args) => {
  const parsed = parseImport(args.path);
  const pkgDir = path.join(workspacePackagesDir, parsed.packageName);
  const pkgJson = readPackageJson(pkgDir);
  // resolveExportSubpath handles nested condition objects recursively
  const target = resolveExportSubpath(pkgJson.exports, parsed.subpath, conditions);
  return { path: path.resolve(pkgDir, target) };
});
```

No registry. No tarballs. No install step for internal packages. This replaces Verdaccio's entire role for internal packages.

### External Package Resolution

External npm dependencies (react, zod, radix-ui, etc.) are installed into a shared cache. **Critically, this must include transitive externals from all aliased internal packages**, not just the top-level panel's own `package.json`.

Example: `workspace/panels/chat` depends on `@workspace/agentic-chat`, which brings `@mdx-js/mdx`, `highlight.js`, `react-markdown`, `@tanstack/react-virtual`, etc. — none of which appear in the chat panel's own package.json. Since internal packages are aliased (built from source, not pre-compiled), their external deps must be collected transitively.

```
externals(panel) = panel.externalDeps ∪ ⋃ externals(internalDep) for each internalDep
```

The union of all transitive external deps is hashed and installed into:

```
key = hash(sorted transitive external dependencies)
{userData}/external-deps/{key}/node_modules/
```

External deps change rarely. This cache is extremely stable. Use Arborist or pnpm pointed at the real npm registry.

**Crash safety:** installations are written to a temp directory first, then atomically renamed. A `.ready` sentinel file marks completion. Existence check looks for the sentinel, not the directory.

### Build Triggers

**Proactive (watcher, server-side):**
1. File change detected in workspace/
2. Recompute effective versions for affected subgraph (milliseconds)
3. Diff against previous EVs
4. Trigger builds for anything that changed
5. Notify Electron via `ws:event` so PanelManager can hot-reload

**On demand (panel/agent request via RPC):**
1. Electron calls `serverClient.call("build", "getBuild", [unitPath])`
2. Server looks up build key in build store
3. Already built → return immediately
4. Build in progress → await it
5. Not started → trigger build (fallback; watcher should have caught it)

**Cold start (first launch or new workspace):**
1. `coreServices.ts` calls `buildSystem.initialize()` during server startup
2. Compute all effective versions
3. Check store for each
4. Build everything that's missing (first launch builds all; subsequent launches hit cache)

---

## Part 2: Workspace Layout

### New Structure

```
workspace/
├── packages/              ← ALL internal packages (22 total)
│   ├── core/
│   ├── rpc/
│   ├── runtime/
│   ├── ai/
│   ├── react/
│   ├── pubsub/
│   ├── git/
│   ├── git-ui/
│   ├── eval/
│   ├── typecheck/
│   ├── tool-ui/
│   ├── agentic-messaging/
│   ├── agent-runtime/
│   ├── agent-patterns/
│   ├── playwright-protocol/
│   ├── playwright-core/
│   ├── playwright-client/
│   ├── playwright-injected/
│   ├── agentic-chat/         ← already here
│   ├── agentic-tools/        ← already here
│   ├── agentic-components/   ← already here
│   └── context-template-editor/  ← already here
│
├── panels/                ← all user-facing panels (5)
│   ├── chat/
│   ├── chat-launcher/
│   ├── code-editor/
│   ├── project-panel/
│   └── project-launcher/
│
├── about/                 ← shell panels (9), formerly src/about-pages/
│   ├── about/
│   ├── adblock/
│   ├── agents/
│   ├── dirty-repo/
│   ├── git-init/
│   ├── help/
│   ├── keyboard-shortcuts/
│   ├── model-provider-config/
│   └── new/
│
└── agents/                ← all agents (4)
    ├── claude-code-responder/
    ├── codex-responder/
    ├── pubsub-chat-responder/
    └── test-echo/
```

### Scope Rename: `@natstack/*` → `@workspace/*`

Every import and package.json reference to `@natstack/*` becomes `@workspace/*`. This is a mechanical find-and-replace.

**Scale:** ~682 references across ~274 files total, including: source imports, package.json name/dependency fields, build config aliases, string patterns, and documentation.

The existing `createNatstackResolvePlugin()` in `src/main/natstackResolvePlugin.ts` and its consumer in `@natstack/typecheck` (`parseNatstackImport`, `resolveExportSubpath`) rename to `@workspace` equivalents.

### About Page Discovery (Dynamic, Not Hardcoded)

Currently, about pages are hardcoded in 6 locations:

| File | Hardcoded knowledge |
|------|-------------------|
| `src/shared/types.ts` | `ShellPage` union type — 9 literal strings |
| `src/main/aboutBuilder.ts` | `SHELL_PAGE_META` — titles, descriptions, `hiddenInLauncher` flags |
| `src/main/nsAboutProtocol.ts` | `isValidAboutPage()` validates against hardcoded list |
| `src/main/aboutProtocol.ts` | `isValidShellPage()` validates against hardcoded list |
| `src/main/panelManager.ts` | Shell panel creation/validation flows |
| `src/main/ipc/shellServices.ts` | `getShellPagesForLauncher()` for launcher UI |

V2 replaces all of this with **dynamic manifest discovery**. About pages get a `package.json` with all metadata:

```json
{
  "name": "@workspace-about/model-provider-config",
  "version": "0.1.0",
  "natstack": {
    "type": "app",
    "title": "Model Provider Config",
    "shell": true,
    "hiddenInLauncher": false
  },
  "dependencies": {
    "@workspace/react": "*",
    "@workspace/runtime": "*"
  }
}
```

The `shell: true` flag grants shell service access and routes through `natstack-about://` protocol. The `hiddenInLauncher` flag replaces the hardcoded flag in `SHELL_PAGE_META`. All about pages run in browser sandbox mode — those needing host-side operations (git, filesystem) use RPC service calls via the service dispatcher.

**Migration steps for about-page routing:**
1. Replace `ShellPage` union type in `src/shared/types.ts` with `string` (validated at runtime)
2. Delete `SHELL_PAGE_META` from `aboutBuilder.ts` (file deleted entirely)
3. Replace `isValidAboutPage()` / `isValidShellPage()` with build system query: "does this about page exist in the workspace?"
4. Replace `getShellPagesForLauncher()` with workspace scan of `workspace/about/*/package.json` manifests
5. Update `panelManager.ts` validation to use the build system's workspace graph

---

## Part 3: Implementation

### New Files

Create `src/server/buildV2/` inside the server process codebase:

```
src/server/buildV2/
├── effectiveVersion.ts    ← EV computation (topo sort + bottom-up hash)
├── packageGraph.ts        ← DAG discovery from package.json files
├── buildStore.ts          ← Content-addressed build store ({userData}/builds/)
├── externalDeps.ts        ← Transitive external dependency collection + cached installation
├── builder.ts             ← esbuild orchestration (panels + agents)
├── watcher.ts             ← File watcher → EV recomputation → rebuild triggers
└── index.ts               ← Public API + RPC service registration
```

### Phase 1: Effective Version Computer

**Step 1.1: Package graph discovery** (`packageGraph.ts`)

- Scan `workspace/packages/`, `workspace/panels/`, `workspace/about/`, `workspace/agents/`
- Read each `package.json`, extract internal dependencies (anything `@workspace/*`, `@workspace-panels/*`, `@workspace-about/*`, `@workspace-agents/*`)
- Build adjacency list representation of the DAG
- Detect cycles (error if found)
- Produce topological ordering

**Step 1.2: Content hashing**

For each package/panel/agent, compute a content hash:
- If git-tracked and clean: `git hash-object` on all source files (fast, uses git's own cache)
- If dirty or untracked files: SHA256 of file contents
- Hash includes: **all files in the unit directory** — code (`.ts`, `.tsx`, `.js`, `.jsx`), styles (`.css`), config (`.json`), and assets (`.png`, `.svg`, `.jpg`, `.ico`, `.woff`, `.woff2`, `.ttf`, `.mp3`, `.mp4`, etc.). esbuild's file loader processes binary assets into the output bundle, so asset changes must trigger rebuilds.
- Excludes: `node_modules/`, `dist/`, `.git/`, dotfiles

**Step 1.3: Effective version computation** (`effectiveVersion.ts`)

```typescript
interface EffectiveVersionMap {
  [packagePath: string]: string;  // path → ev hash
}

function computeEffectiveVersions(graph: PackageGraph): EffectiveVersionMap {
  const evMap: EffectiveVersionMap = {};
  for (const node of graph.topologicalOrder()) {
    const depsEvs = node.internalDeps
      .map(dep => evMap[dep.path])
      .sort();
    evMap[node.path] = hash(node.contentHash, ...depsEvs);
  }
  return evMap;
}
```

**Step 1.4: Diff computation**

Compare new EV map against previous EV map. Emit changeset of paths whose EV changed.

Previous EV map persisted to `{userData}/ev-map.json` (using `getUserDataPath()` from `envPaths.ts`). This file is derived state — if lost, recompute everything and rebuild what's missing from the store.

### Phase 2: Content-Addressed Build Store

**Step 2.1: Store layout** (`buildStore.ts`)

```
{userData}/builds/
├── {build_key_1}/
│   ├── bundle.js
│   ├── bundle.css
│   ├── index.html
│   ├── assets/
│   └── metadata.json    ← { kind, name, ev, buildOptions, builtAt, esbuildMeta }
├── {build_key_2}/
│   └── ...
└── ...
```

Uses `getUserDataPath()` from `src/main/envPaths.ts` — works in both Electron (`app.getPath("userData")`) and headless server (`NATSTACK_USER_DATA_PATH` env var) modes.

**Step 2.2: Store API**

```typescript
interface BuildStore {
  has(key: string): boolean;
  get(key: string): BuildResult | null;
  put(key: string, artifacts: BuildArtifacts): void;
  gc(activeKeys: Set<string>): { freed: number };
}
```

Trivially simple. No LRU, no TTL, no size limits (GC handles cleanup). `has()` is a directory existence check.

### Phase 3: Transitive External Dependency Cache

**Step 3.1: Transitive external dep collection** (`externalDeps.ts`)

For a given panel/agent, walk the package graph and collect **all** external dependencies from the unit itself and every internal package it transitively depends on:

```typescript
function collectTransitiveExternalDeps(
  unit: GraphNode,
  graph: PackageGraph
): Record<string, string> {
  const externals: Record<string, string> = {};
  const visited = new Set<string>();

  function walk(node: GraphNode) {
    if (visited.has(node.path)) return;
    visited.add(node.path);
    for (const [name, version] of Object.entries(node.dependencies)) {
      if (graph.isInternal(name)) {
        walk(graph.get(name));  // recurse into internal dep
      } else {
        // External: take highest version if conflict
        externals[name] = externals[name]
          ? maxSemver(externals[name], version)
          : version;
      }
    }
  }

  walk(unit);
  return externals;
}
```

**Step 3.2: Shared external dep cache**

```typescript
function getExternalDepsDir(transitiveExternals: Record<string, string>): string {
  const key = hash(JSON.stringify(sortedEntries(transitiveExternals)));
  return path.join(getUserDataPath(), "external-deps", key);
}
```

Install into `{userData}/external-deps/{hash}/node_modules/` using Arborist pointed at the public npm registry. Install to a temp directory first, then atomically rename and write `.ready` sentinel. Check for sentinel on lookup, not directory existence.

### Phase 4: Builder

**Step 4.1: esbuild orchestration** (`builder.ts`)

Build options are determined from the unit's `package.json` manifest, not from caller arguments:

```typescript
interface BuildOptions {
  sourcemap: boolean;        // from manifest natstack.sourcemap (default: true)
}
```

Two build strategies, selected by manifest type:

**Panel/About build** (browser target):
- Platform: `browser`
- Format: `esm`
- Target: `es2022`
- Code splitting: enabled
- Plugins: resolve plugin (using `resolveExportSubpath()` + `BUNDLE_CONDITIONS` from `@workspace/typecheck`), fs/path shims, React dedupe
- Output: `bundle.js` + `bundle.css` + `index.html` + `assets/`

**Agent build** (node target):
- Platform: `node`
- Target: `node20`
- Format: `esm` (.mjs)
- Code splitting: disabled
- No fs/path shims
- Native addons externalized
- Output: `bundle.mjs`

**Step 4.2: Concurrency**

- Semaphore with `MAX_CONCURRENT_BUILDS = 4`
- Build coalescing: if build for same build key is already in flight, return its promise

### Phase 5: File Watcher

**Step 5.1: Watcher setup** (`watcher.ts`)

Watch `workspace/` with chokidar:
- Ignore: `node_modules/`, `.git/`, `dist/`, `coverage/`
- Debounce: 200ms (per-package, not global)

**Step 5.2: On file change**

1. Identify which package/panel/agent was affected (from file path)
2. Recompute content hash for that unit only
3. Recompute effective versions bottom-up from the changed node
4. Diff against previous EV map
5. For each changed EV: trigger build if not already in store
6. Notify connected clients via `ws:event` (build-started, build-complete, build-error)
7. Update persisted EV map

### Phase 6: RPC Integration

**Step 6.1: RPC service** (`index.ts`)

Register a `"build"` service on the RPC server:

```typescript
interface BuildService {
  // Get build result for a panel/agent
  getBuild(unitPath: string): Promise<BuildResult>;

  // Get effective version for a unit
  getEffectiveVersion(unitPath: string): string;

  // Force recompute (after git checkout, branch switch, etc.)
  recompute(): Promise<ChangeSet>;

  // Garbage collect unreferenced builds
  gc(activeUnits: string[]): Promise<{ freed: number }>;

  // List available about pages (for launcher UI)
  getAboutPages(): Promise<AboutPageMeta[]>;
}
```

**Step 6.2: Server startup integration**

Wire into `src/main/coreServices.ts` (the shared service orchestrator):

```typescript
// In startCoreServices(), after git watcher setup:
const buildSystem = await initBuildSystemV2(workspacePath);
// Subscribe to git watcher for branch-switch recomputes
gitWatcher.on("branchChange", () => buildSystem.recompute());
```

**Step 6.3: Electron-side integration**

In Electron, `panelManager.ts` calls builds via the server client:

```typescript
// panelManager.ts
const buildResult = await serverClient.call("build", "getBuild", [panelPath]);
```

This replaces the direct `buildPanel()` / `aboutBuilder` / `builtinWorkerBuilder` calls.

---

## Part 4: Migration

### Migration 1: Move packages/ → workspace/packages/

**What moves:**

| From | To |
|------|----|
| `packages/core/` | `workspace/packages/core/` |
| `packages/rpc/` | `workspace/packages/rpc/` |
| `packages/runtime/` | `workspace/packages/runtime/` |
| `packages/ai/` | `workspace/packages/ai/` |
| `packages/react/` | `workspace/packages/react/` |
| `packages/pubsub/` | `workspace/packages/pubsub/` |
| `packages/git/` | `workspace/packages/git/` |
| `packages/git-ui/` | `workspace/packages/git-ui/` |
| `packages/eval/` | `workspace/packages/eval/` |
| `packages/typecheck/` | `workspace/packages/typecheck/` |
| `packages/tool-ui/` | `workspace/packages/tool-ui/` |
| `packages/agentic-messaging/` | `workspace/packages/agentic-messaging/` |
| `packages/agent-runtime/` | `workspace/packages/agent-runtime/` |
| `packages/agent-patterns/` | `workspace/packages/agent-patterns/` |
| `packages/playwright-protocol/` | `workspace/packages/playwright-protocol/` |
| `packages/playwright-core/` | `workspace/packages/playwright-core/` |
| `packages/playwright-client/` | `workspace/packages/playwright-client/` |
| `packages/playwright-injected/` | `workspace/packages/playwright-injected/` |

**After move:** Delete `packages/` directory entirely.

### Migration 2: Rename @natstack/* → @workspace/*

Mechanical find-and-replace across the entire codebase:

1. **package.json `name` fields** (18 packages): `"@natstack/core"` → `"@workspace/core"`
2. **package.json `dependencies`** (31 files): `"@natstack/runtime": "*"` → `"@workspace/runtime": "*"`
3. **Source imports** (~335 of the ~682 total references, across ~207 of the ~274 files): `from "@natstack/core"` → `from "@workspace/core"`
4. **Resolve plugin** (`src/main/natstackResolvePlugin.ts`): rename filter from `@natstack/` to `@workspace/`
5. **Typecheck resolution** (`packages/typecheck/src/resolution.ts`): update `parseNatstackImport` → `parseWorkspaceImport`
6. **Build config aliases** (vitest.config.ts, packages/*/build.mjs): update path mappings
7. **String patterns** (isInternalPackage, verdaccioConfig, etc.): update `@natstack/` prefixes
8. **Documentation** (BUILD_SYSTEM.md, PANEL_SYSTEM.md, PANEL_DEVELOPMENT.md, OPFS_PARTITIONS.md, workspace/skills/): update examples

### Migration 3: Move about pages → workspace/about/

**What moves:**

| From | To |
|------|----|
| `src/about-pages/about/` | `workspace/about/about/` |
| `src/about-pages/adblock/` | `workspace/about/adblock/` |
| `src/about-pages/agents/` | `workspace/about/agents/` |
| `src/about-pages/dirty-repo/` | `workspace/about/dirty-repo/` |
| `src/about-pages/git-init/` | `workspace/about/git-init/` |
| `src/about-pages/help/` | `workspace/about/help/` |
| `src/about-pages/keyboard-shortcuts/` | `workspace/about/keyboard-shortcuts/` |
| `src/about-pages/model-provider-config/` | `workspace/about/model-provider-config/` |
| `src/about-pages/new/` | `workspace/about/new/` |

Each gets a `package.json` with `@workspace-about/*` scope and metadata in the natstack manifest (title, description, shell, hiddenInLauncher).

**After move:** Delete `src/about-pages/` directory entirely.

### Migration 4: Eliminate workers entirely

The `template-builder` worker (clones git repos to OPFS) moves to the server process. The server already has full git access via `gitServer`.

**Specific rewrites:**
- `src/main/contextTemplate/partitionBuilder.ts`: currently calls `panelManager.createTemplateBuilderWorker()` to spawn a hidden WebContentsView worker. Rewrite to call a server RPC method instead.
- `src/main/panelManager.ts`: delete `createTemplateBuilderWorker()`, `closeTemplateBuilderWorker()`, `templateBuilderWorkers` Set, `buildWorkerAsync()`, `rebuildWorkerPanel()`, and all worker-related state tracking.

**After migration:** Delete `src/builtin-workers/` directory entirely.

### Migration 5: Dynamic about-page routing

Replace all hardcoded about-page knowledge with dynamic manifest discovery:

1. `src/shared/types.ts`: Replace `ShellPage` union type with `string` (runtime-validated)
2. `src/main/aboutBuilder.ts`: **Delete entirely** (including `SHELL_PAGE_META`, `getShellPageKeys()`, `getShellPageTitle()`, `getShellPagesForLauncher()`)
3. `src/main/nsAboutProtocol.ts`: Replace `isValidAboutPage()` with build system query
4. `src/main/aboutProtocol.ts`: Replace `isValidShellPage()` with build system query
5. `src/main/panelManager.ts`: Update shell panel creation to query workspace manifests; remove hardcoded `"dirty-repo"` and `"git-init"` page references in navigation logic (3 locations)
6. `src/main/ipc/shellServices.ts`: Replace `getShellPagesForLauncher()` with `serverClient.call("build", "getAboutPages")`
7. `packages/runtime/src/core/nsLinks.ts`: Delete `AboutPage` type alias and `VALID_ABOUT_PAGES` array (lines 93-95) — replace with runtime validation via build system query
8. `src/main/menu.ts`: Replace hardcoded `"model-provider-config"` and `"keyboard-shortcuts"` in menu click handlers with references resolved from workspace manifests

### Migration 6: Build option API cleanup

V1 exposes `gitRef` and `sourcemap` as **caller-supplied options** flowing through ns:// URLs, `CreateChildOptions`, `PanelSnapshot.options`, and `panelManager.buildPanelAsync()`. V2 makes these **manifest-derived** (read from `package.json` at build time). The caller API surface must be updated to match.

> **Partially completed:** The `unsafe` option has been removed from the main execution paths — `PanelManifest`, `PanelBuildOptions`, `WorkerBuildOptions`, panel/about build strategies, `viewManager`, `panelManager` panel creation, and the runtime `fs.ts`. The `unsafePreload.ts` file has been deleted. All panels now build with `platform: "browser"`, `format: "esm"`. **Remaining:** `unsafe` parameter in `nsProtocol.ts` (URL parsing/building), `panelBuilder.ts` (option signatures and platform/format/shim conditionals), `preloadUtils.ts` (`ARG_SCOPE_PATH`), `contextTemplate/types.ts` (`ContextMode`), and `contextTemplate/contextId.ts` (`createUnsafeContextId`, `isUnsafeNoContextId`, unsafe regex/parser). These are removed as part of the rewrites below and in Migration 7.

**What remains:**

| Option | V1 (caller-supplied) | V2 (manifest-derived) |
|--------|---------------------|----------------------|
| `gitRef` | Parsed from ns:// URL `?gitRef=`, stored in snapshot, passed to builder | **Removed entirely.** V2 builds from working tree only. |
| `sourcemap` | Passed via `CreateChildOptions`, stored in snapshot, read during build | **Removed from caller API.** Read from `package.json` manifest `natstack.sourcemap` field. |

**Specific rewrites:**

1. `packages/runtime/src/core/types.ts`: Remove `gitRef` from `CreateChildOptions` (line 67). Remove `sourcemap` from `CreateChildOptions` (line 73). Remove `WorkerChildSpec` interface entirely — workers eliminated (see Migration 7). Remove `sourcemap?: boolean` from `AppChildSpec` (line 147). Remove `gitRef?: string` from `GitConfig` (line 202).
2. `packages/runtime/src/core/nsLinks.ts`: Remove `gitRef?: string` from `BuildNsLinkOptions` (line 23). Remove `gitRef` URL param emission in `buildNsLink()` (line 66-67). Remove gitRef from JSDoc example (line 51).
3. `src/main/nsProtocol.ts`: Remove `gitRef` parsing from `parseNsUrl()`. Simplify URL to carry only source identity.
4. `src/shared/panel/accessors.ts`: Remove `"gitRef"` and `"sourcemap"` from `SOURCE_SCOPED_OPTIONS`. Delete `getPanelGitRef()` and `getPanelSourcemap()` accessors.
5. `src/main/panelManager.ts`: Remove `gitRef` and `sourcemap` from `buildPanelAsync()` options. Build options come from manifest only. Remove `gitRef?` from `buildPanelEnv()` gitInfo parameter (line 1160) and the `gitRef: gitInfo.gitRef` assignment in the bootstrap GitConfig payload (line 1173). Remove `gitRef: options?.gitRef` from the `buildPanelEnv()` call site (line 1314).
6. `src/preload/preloadUtils.ts`: Remove `gitRef?: string` from the preload-side `GitConfig` interface (line 90).
7. `src/shared/types.ts`: Remove `gitRef` and `sourcemap` from `PanelOptions` / snapshot option types.

### Migration 7: Eliminate worker concept from type system and policies

Migration 4 removes the template-builder worker and its build infrastructure. This migration completes the job by removing the **general worker concept** from shared types, runtime API, service dispatch, and access policies.

**Why remove entirely:** Template-builder is the only worker that has ever been *shipped*. However, worker infrastructure is deeply integrated — `CallerKind` includes `"worker"`, service policies authorize it for 8+ services, token management issues worker tokens, `panelManager.ts` has ~137 worker references, and `workspace/loader.ts` scaffolds a `workers/` directory. This migration must therefore address all of these integration points, not just the template-builder removal.

**Critical dependency: agent-host token replacement.** `src/main/coreServices.ts` (line 125) creates tokens with `callerKind: "worker"` for agent-host-issued operations. Before removing `"worker"` from `CallerKind`, this must be migrated to `"server"` (since the agent host runs in the server process). Verify no other code path creates worker tokens beyond template-builder and agent-host.

**Specific rewrites:**

1. `src/main/coreServices.ts`: Change `getTokenManager().createToken(instanceId, "worker")` → `getTokenManager().createToken(instanceId, "server")` for agent-host token creation. This must happen **before** step 3.
2. `src/shared/types.ts`: Remove `"worker"` from `PanelType` union (line 208) → becomes `"app" | "browser" | "shell"`. Remove `runtime?: "panel" | "worker"` from `PanelManifest` (line 64). Remove `type: "app" | "worker"` → just `type: "app"` (line 50).
3. `packages/runtime/src/core/types.ts`: Delete `WorkerChildSpec` interface entirely (line 169). Remove worker-related exports from the runtime API.
4. `src/main/serviceDispatcher.ts`: Remove `"worker"` from `CallerKind` type (line 10) → becomes `"panel" | "shell" | "server"`.
5. `src/main/servicePolicy.ts`: Remove `"worker"` from all `allowed` arrays in `SERVICE_POLICIES` (line 67+). Every service that lists `["panel", "worker", "shell", "server"]` becomes `["panel", "shell", "server"]`.
6. `src/main/panelManager.ts`: Remove all worker-specific panel creation/lifecycle code beyond what Migration 4 already covers. Remove worker type checks in panel routing logic. Remove `buildWorkerAsync()`, `generateWorkerHostHtml()`, worker type detection from source path prefix.
7. `src/main/workspace/loader.ts`: Remove `"workers"` from `mkdirSync` scaffold (line 264).
8. `src/main/contextTemplate/types.ts`: Remove `ContextMode` type (`"safe" | "unsafe"` → only safe exists).
9. `src/main/contextTemplate/contextId.ts`: Delete `createUnsafeContextId()`, `isUnsafeNoContextId()`, `UNSAFE_NOCTX_REGEX`, and unsafe parsing branch in `parseContextId()`. Then update `src/main/contextTemplate/index.ts`: remove re-exports of `createUnsafeContextId` and `isUnsafeNoContextId` (lines 71-72), remove `ContextMode` from type re-exports (line 38), and update the module JSDoc (lines 8-9 reference unsafe panels). Update `src/main/contextTemplate/__tests__/contextId.test.ts`: remove import of `createUnsafeContextId` and `isUnsafeNoContextId` (lines 10-11) and delete the `createUnsafeContextId` and `isUnsafeNoContextId` test suites (lines 60-90).
10. `src/preload/preloadUtils.ts`: Remove `ARG_SCOPE_PATH` constant (unsafe scope path argument). Change `NatstackKind` type (line 113) from `"panel" | "worker" | "shell"` to `"panel" | "shell"`. Remove `if (kind === "worker") return "worker"` branch in `parseKind()` (line 143).
11. `packages/runtime/src/shared/globals.ts`: Change `__natstackKind` type (line 18) from `"panel" | "worker" | "shell"` to `"panel" | "shell"`. Change `kind` in `InjectedConfig` (line 34) likewise.
12. `packages/runtime/src/core/nsLinks.ts`: Remove "workers" from comment on line 4 ("Navigate to app panels and workers" → "Navigate to app panels"). Remove `"workers/task"` from JSDoc example (line 39).
13. `src/main/gitServer.ts`: Remove `"workers/*"` from default `initPatterns` array (line 70).
14. `src/main/nsProtocol.ts`: Remove `unsafe` field from parsed result and URL builder. Remove `unsafe` parameter parsing.
15. `src/main/panelBuilder.ts`: Remove `unsafe` from `buildPanel()`/`buildWorker()` option signatures. Remove platform/format/shim conditionals. Remove `computeWorkerOptionsSuffix()`.

---

## Part 5: Dead Code Removal

Everything listed below is deleted or gutted after V2 is operational and migrations are complete.

> **Ordering constraint:** These deletions have hard prerequisites. Do NOT delete files until their V2 replacements are fully operational:
>
> - `cacheManager.ts` and `diskCache.ts` are imported in both `src/main/index.ts` (boot) and `src/server/index.ts` (boot + shutdown). Delete only after the V2 content-addressed store handles all cache operations and both entry points are updated.
> - `verdaccioServer.ts` and `verdaccioConfig.ts` are created/configured in `coreServices.ts` and used during workspace package publishing. Delete only after the V2 workspace watcher + esbuild resolve plugin replace Verdaccio entirely.
> - `natstackPackageWatcher.ts` is initialized in `coreServices.ts` and triggers Verdaccio republish on file changes. Delete only after V2 file watching is in place.
> - `serverProcessManager.ts` defines `ServerPorts` (including `verdaccioPort`) used throughout startup. Remove `verdaccioPort` from the interface before deleting Verdaccio files, but do not delete the file itself (it's still needed for RPC/git/pubsub ports).
> - `package-store/*` files are consumed by the V1 build pipeline. Delete only after no V1 build path remains.
>
> **Safe deletion order:** V2 builder operational → update entry points (`index.ts`, `coreServices.ts`) → delete V1 build pipeline (`src/main/build/`) → delete package store (`src/main/package-store/`) → delete Verdaccio (`verdaccioServer.ts`, `verdaccioConfig.ts`) → delete remaining V1 files (`cacheManager.ts`, `diskCache.ts`, `cacheUtils.ts`, `dependencyGraph.ts`, `natstackPackageWatcher.ts`, `aboutBuilder.ts`, `builtinWorkerBuilder.ts`, `natstackResolvePlugin.ts`).

### Files to Delete Entirely

#### Build System V1 Core
| File | Purpose (now dead) |
|------|--------------------|
| `src/main/verdaccioServer.ts` | Embedded npm registry — internal packages resolved by plugin, external by Arborist |
| `src/main/verdaccioConfig.ts` | Verdaccio URL/RPC config bridge for Electron — no longer needed |
| `src/main/cacheManager.ts` | LRU build cache with async init — replaced by content-addressed store |
| `src/main/diskCache.ts` | JSON persistence for build cache — replaced by content-addressed store |
| `src/main/cacheUtils.ts` | Multi-layer cache clearing (Verdaccio + dependency graph + disk cache) — all layers gone |
| `src/main/dependencyGraph.ts` | Consumer→package registry for invalidation — EVs eliminate the need |
| `src/main/natstackPackageWatcher.ts` | Chokidar watcher for `packages/` — replaced by V2 workspace watcher |
| `src/main/aboutBuilder.ts` | About page build pipeline + hardcoded `SHELL_PAGE_META` — replaced by V2 builder + dynamic discovery |
| `src/main/builtinWorkerBuilder.ts` | Worker build pipeline — workers eliminated |
| `src/main/natstackResolvePlugin.ts` | esbuild resolve plugin — subsumed by V2 builder |

#### Build Pipeline V1
| File | Purpose (now dead) |
|------|--------------------|
| `src/main/build/orchestrator.ts` | V1 build coordinator (provision→install→build→typecheck→cache) |
| `src/main/build/sharedBuild.ts` | Provisioning, Arborist install, dep hashing, Verdaccio ping |
| `src/main/build/artifacts.ts` | V1 artifact path computation (staging + stable promotion) |
| `src/main/build/bundleAnalysis.ts` | Bundle analysis utilities |
| `src/main/build/types.ts` | V1 build type definitions (BuildStrategy, BuildContext, etc.) |
| `src/main/build/strategies/panelStrategy.ts` | Panel-specific esbuild config |
| `src/main/build/strategies/agentStrategy.ts` | Agent-specific esbuild config |
| `src/main/build/strategies/index.ts` | Strategy re-exports |

#### Package Store (Verdaccio Integration)
| File | Purpose (now dead) |
|------|--------------------|
| `src/main/package-store/index.ts` | Store public API |
| `src/main/package-store/store.ts` | Content-addressable package storage |
| `src/main/package-store/fetcher.ts` | Package fetching from Verdaccio |
| `src/main/package-store/linker.ts` | Arborist tree serialization + linking |
| `src/main/package-store/gc.ts` | Package store garbage collection |
| `src/main/package-store/schema.ts` | Store schema definitions |

#### ESM Transformer (Verdaccio Integration)
| File | Purpose (now dead) |
|------|--------------------|
| `src/main/lazyBuild/esmTransformer.ts` | On-demand CJS→ESM transformer served via Verdaccio `/-/esm/` route — only imported by `verdaccioServer.ts` (line 34), `build/sharedBuild.ts` (line 41), and `build/strategies/panelStrategy.ts` (line 41) |

#### Build Scripts & Config
| File | Purpose (now dead) |
|------|--------------------|
| `build-dist.mjs` | Production pre-compilation of panels/about/workers |
| `BUILD_SYSTEM.md` | V1 build system documentation (replaced by this doc) |

#### Directories to Delete
| Directory | Contents | Reason |
|-----------|----------|--------|
| `packages/` | 18 @natstack/* packages | Moved to workspace/packages/ |
| `src/about-pages/` | 9 about page directories | Moved to workspace/about/ |
| `src/builtin-workers/` | 1 worker (template-builder) | Eliminated |
| `src/main/build/` | Entire V1 build pipeline | Replaced by src/server/buildV2/ |
| `src/main/package-store/` | Entire package store | Replaced by external-deps cache |
| `src/main/lazyBuild/` | ESM transformer (1 file) | Only used by Verdaccio + V1 build pipeline |

### Files to Modify

#### Core Services (`src/main/coreServices.ts`)

**Remove:**
- `import { createVerdaccioServer }` and VerdaccioServer creation (~30 lines)
- `import { getNatstackPackageWatcher }` and watcher init (~10 lines)
- Verdaccio publish-on-git-change subscription
- Verdaccio return in `CoreServicesHandle`
- Verdaccio shutdown

**Add:**
- `import { initBuildSystemV2 }` from `../server/buildV2/index.js`
- Build system initialization in service startup sequence
- Build system in `CoreServicesHandle` for RPC registration
- Build system shutdown

#### Server Entry (`src/server/index.ts`)

**Add:**
- Build system RPC service registration alongside existing services
- Build system port/status in "ready" IPC message (or piggyback on existing RPC)

#### Server RPC (`src/server/rpcServer.ts`)

**Add:**
- `"build"` service dispatcher routing to buildV2 API

#### Routing Bridge (`packages/runtime/src/shared/routingBridge.ts`)

**Update:**
- Add `"build"` to `SERVER_SERVICES` set (currently `["ai", "db", "typecheck", "agentSettings"]`). This ensures panels calling `bridge.call("build", ...)` route to the server process via WebSocket, not Electron IPC.

#### Service Policy (`src/main/servicePolicy.ts`)

**Add:**
- `"build"` entry to `SERVICE_POLICIES` record: `{ allowed: ["panel", "shell", "server"], description: "Build system (getBuild, recompute, gc, getAboutPages)" }`. Without this, the "build" service bypasses the policy check entirely (unknown services fall through at line 130), which is a security/consistency gap.

#### Workspace Loader (`src/main/workspace/loader.ts`)

**Update:**
- `createDefaultWorkspaceConfig()`: Remove assumption that shipped panels exist. Update `rootPanel` to reference `"panels/chat-launcher"` as a workspace-relative source path (built on demand by V2, not loaded from pre-built bundles). Remove `"workers"` from scaffold directories. See "Bootstrap Strategy" in Part 7 for the full first-run flow.

#### Electron Startup (`src/main/index.ts`)

**Remove:**
- `verdaccioConfig.setVerdaccioConfig()` call (no Verdaccio URL/RPC to configure)
- Verdaccio port forwarding from ServerPorts

**Simplify:**
- Panel build calls route through `serverClient.call("build", ...)`

#### Server Process Manager (`src/main/serverProcessManager.ts`)

**Remove:**
- `verdaccioPort` from `ServerPorts` interface

#### Panel Builder (`src/main/panelBuilder.ts`)

**Remove:**
- Shipped panel loading (tryLoadShippedPanel and related) (~100 lines)
- Direct dependency on V1 orchestrator, sharedBuild, artifacts
- V1 cache manager usage
- `createNatstackResolvePlugin` usage (V2 builder handles this)
- `buildWorker()` function entirely (workers eliminated)

**Replace:**
- `buildPanel()` → delegate to server RPC `build.getBuild()`

#### Panel Manager (`src/main/panelManager.ts`)

**Remove:**
- `buildWorkerAsync()` method (~50 lines)
- `rebuildWorkerPanel()` method (~30 lines)
- `createTemplateBuilderWorker()` / `closeTemplateBuilderWorker()` (~100 lines)
- `templateBuilderWorkers` Set and all worker-related state tracking
- References to Verdaccio server/config
- Hardcoded shell page validation (replaced by build system query)

#### Agent Builder (`src/main/agentBuilder.ts`)

**Remove:**
- Direct dependency on V1 orchestrator
- V1 cache manager usage

**Replace:**
- Build logic → delegate to server RPC `build.getBuild()`

#### Typecheck Service (`src/main/typecheck/service.ts`)

**Remove:**
- `import { isVerdaccioReady, getVerdaccioUrl }` from verdaccioConfig
- `import { getPackageStore, createPackageFetcher, createPackageLinker, serializeTree }` from package-store
- All Verdaccio-based package resolution logic

**Replace:**
- Internal package type resolution → read types directly from `workspace/packages/` source (already accessible; just remove the Verdaccio indirection)

#### Panel Protocol (`src/main/panelProtocol.ts`)

**Remove:**
- `import { getVerdaccioUrl, isVerdaccioReady }` from verdaccioConfig
- Verdaccio URL injection into panel protocol responses

#### Context Template Partition Builder (`src/main/contextTemplate/partitionBuilder.ts`)

**Remove:**
- Worker panel creation via `panelManager.createTemplateBuilderWorker()`
- Hidden WebContentsView lifecycle management

**Replace:**
- Git clone operations → server RPC call (server has full git access)

#### Shell Services (`src/main/ipc/shellServices.ts`)

**Remove:**
- `import { clearAllCaches }` from cacheUtils
- `import { getShellPagesForLauncher }` from aboutBuilder
- `clearBuildCache()` implementation that calls `clearAllCaches()`

**Replace:**
- Cache clearing → `serverClient.call("build", "gc", [...])`
- Shell page listing → `serverClient.call("build", "getAboutPages")`

#### About Protocol (`src/main/nsAboutProtocol.ts` and `src/main/aboutProtocol.ts`)

**Remove:**
- `import { getShellPageKeys }` from aboutBuilder
- Hardcoded `VALID_ABOUT_PAGES` list

**Replace:**
- `isValidAboutPage()` / `isValidShellPage()` → query build system for known about pages

#### Shared Types (`src/shared/types.ts`)

**Remove:**
- `ShellPage` union type (`"model-provider-config" | "about" | "keyboard-shortcuts" | ...`)

**Replace:**
- `type ShellPage = string` (runtime-validated against workspace manifests)

#### App Build Script (`build.mjs`)

**Remove:**
- `buildWorkspacePackages()` function and STEP 1 (~50 lines)
- References to `packages/` directory for compilation

**Keep:**
- Protocol generation (STEP 0)
- Playwright core build (STEP 0.5) — evaluate if this can move to V2
- Main/preload/renderer/server bundle (STEP 2) — now builds 4 bundles: main, preload, renderer, server
- Static asset copying (STEP 3)

#### Electron Builder Config (`electron-builder.yml`)

**Remove:**
- `extraResources` entries for `dist/shipped-panels`, `dist/about-pages`, `dist/builtin-workers`
- `packages/**/*` from `files` list (no workspace content shipped with app)
- `packages/**/*` from `asarUnpack` list

The production app ships only: compiled bundles (`dist/`), runtime dependencies (`node_modules/`), and `package.json`. No workspace source. Any workspace is loaded at runtime and built on demand.

#### Root Package Config (`package.json`)

**Remove from dependencies:**
- `verdaccio`
- `pacote`

**Remove from devDependencies:**
- `@types/npmcli__arborist` (if Arborist also removed)
- `@types/pacote`

**Keep:**
- `@npmcli/arborist` (still used for external dep installation in V2)

**Update scripts:**
- Remove `build:dist` script
- Simplify `prebuild` and `build` scripts

#### Vitest Config (`vitest.config.ts`)

**Update:**
- All `@natstack/*` aliases → `@workspace/*`
- Path prefixes `packages/` → `workspace/packages/`

#### Server-Native (`server-native/`)

**Keep as-is.** This directory provides system-compiled native modules (better-sqlite3) for the standalone server. Unrelated to the build system.

---

## Part 6: Implementation Order

All work happens on a feature branch. V1 can break freely — it's always recoverable from git history.

### Sprint 1: Build V2

Build the new system end-to-end.

1. **`packageGraph.ts`** — DAG discovery, topo sort, cycle detection
2. **`effectiveVersion.ts`** — Content hashing, bottom-up EV computation
3. **`buildStore.ts`** — Content-addressed store (put/get/has/gc), keyed by build key (ev + options)
4. **`externalDeps.ts`** — Transitive external dependency collection, cached installation with atomic writes
5. **`builder.ts`** — esbuild orchestration with resolve plugin, both strategies
6. **`watcher.ts`** — File watcher → EV recompute → build trigger → ws:event notification
7. **`index.ts`** — Public API + RPC service registration
8. **Tests** — unit tests with fixture packages, integration test building a panel end-to-end

### Sprint 2: Restructure + Wire

Rip out V1, move everything to the new layout, wire V2 into the app, clean APIs. One big pass.

9. **Move `packages/` → `workspace/packages/`** (git mv)
10. **Rename `@natstack/*` → `@workspace/*`** (find-and-replace across ~682 references in ~274 files)
11. **Move `src/about-pages/` → `workspace/about/`** (git mv + add package.json manifests)
12. **Wire V2 into `coreServices.ts`** — replace Verdaccio/NatstackPackageWatcher with V2 build system init
13. **Register `"build"` RPC service** on `rpcServer.ts`
14. **Add `"build"` to `routingBridge.ts` SERVER_SERVICES** — route panel build requests to server
15. **Add `"build"` entry to `servicePolicy.ts` SERVICE_POLICIES** — `allowed: ["panel", "shell", "server"]`
16. **Wire Electron `panelBuilder.ts`** — replace direct builds with `serverClient.call("build", ...)`
17. **Wire Electron `panelManager.ts`** — remove worker methods, update build calls
18. **Wire `agentBuilder.ts`** — replace build logic with RPC calls
19. **Wire `shellServices.ts`** — replace cache clearing with RPC gc call
20. **Wire about protocol handlers** — replace hardcoded validation with build system queries
21. **Dynamic about-page routing** (Migration 5: replace `ShellPage` type + `SHELL_PAGE_META` + nsLinks.ts + menu.ts)
22. **Build option API cleanup** (Migration 6: remove gitRef/sourcemap from caller APIs, ns:// URLs, CreateChildOptions)
23. **Eliminate template-builder worker** (Migration 4: rewrite `partitionBuilder.ts` to use server RPC)
24. **Eliminate worker concept** (Migration 7: remove `"worker"` from PanelType, CallerKind, service policies, runtime types)
25. **Workspace bootstrap** — update `workspace/loader.ts:createDefaultWorkspaceConfig()` (see Part 7: Bootstrap Strategy)
26. **Update pnpm-workspace.yaml, tsconfig paths, vitest aliases**

### Sprint 3: Delete + Verify

Delete all V1 dead code. Verify everything works.

27. **Delete V1 build system** (all files listed in Part 5)
28. **Delete `build-dist.mjs`**
29. **Clean up `build.mjs`** — remove package compilation step
30. **Clean up `electron-builder.yml`** — remove extraResources, remove `packages/**/*` from files/asarUnpack
31. **Clean up `package.json`** — remove Verdaccio/pacote deps
32. **Clean up `typecheck/service.ts`** — remove Verdaccio/package-store imports
33. **Clean up `panelProtocol.ts`** — remove Verdaccio URL injection
34. **Delete `packages/` directory** (already moved)
35. **Delete `src/about-pages/`** (already moved)
36. **Delete `src/builtin-workers/`** (already eliminated)
37. **Replace `BUILD_SYSTEM.md`** with updated documentation
38. **Verify**: `pnpm install`, `pnpm type-check`, `pnpm test` all pass
39. **End-to-end test**: app starts, panels build, agents build, about pages discovered dynamically, file changes trigger rebuilds, headless server works

---

## Part 7: Key Design Decisions

### Why run builds in the server process?

The `separate-server` architecture already moved all backend services (Verdaccio, Git, PubSub, AI) into a spawned server process. Builds are backend — they read the filesystem, run esbuild, write artifacts. Keeping them in the server means:
- Headless deployments get builds for free
- Electron crash/restart doesn't lose build state
- Build progress streams over the existing WebSocket event channel
- Single source of truth for build artifacts across multiple Electron windows (future)

### Why ship zero workspace content with the app?

The production app is a generic runtime. It opens a workspace path and builds everything on demand. This means:
- No coupling between app version and workspace content
- The test `workspace/` directory is just a development workspace, not part of the app
- First launch builds everything from source (one-time cost; cached forever after)
- Updates to workspace content never require an app update
- Multiple workspaces can share the same app installation

### Why not keep Verdaccio for external deps?

Verdaccio is ~1000 lines of embedded server code with version computation, change detection, publishing, caching, and file watching — all for serving our own packages to ourselves. The `separate-server` branch already decoupled it (URL-based access via `verdaccioConfig.ts`, RPC for version queries), but it's still a massive accidental complexity tax. External deps can use Arborist directly against the real npm registry.

### Why generalize the existing resolve plugin rather than aliases?

The `separate-server` branch introduced `createNatstackResolvePlugin()` and the `resolution.ts` module in `@natstack/typecheck`. This plugin-based approach is better than raw aliases because:
- It reads `package.json` exports dynamically (handles all subpath patterns)
- It uses the same `resolveExportSubpath()` + `BUNDLE_CONDITIONS` as the type checker (resolution agreement = no false type errors)
- It handles conditional exports (nested condition objects like `{ "types": "...", "default": "..." }`) correctly via recursive resolution
- V2 can reuse this logic directly instead of reinventing it

### Why include build options in the store key?

Sourcemaps change bundle content. The store key must capture everything that affects output: `build_key = hash(ev, sourcemap)`. The V1 system already tracked this via `computeOptionsSuffix()` — V2 makes it explicit in the store key. (The `unsafe` option has been removed — all panels use browser/ESM.)

### Why collect transitive external deps?

When internal packages are aliased (built from source), esbuild bundles their code directly. But their external deps still need to be installed — esbuild can't resolve `react-markdown` if it's not in node_modules. Since the top-level panel may not list these deps, V2 walks the package graph and unions all transitive externals.

### Why content-addressed storage instead of LRU cache?

LRU caches require invalidation logic. Content-addressed stores don't — entries are immutable, keyed by their content. You never ask "is this entry still valid?" You ask "does an entry exist for this key?" The answer is always correct by construction. GC is trivial: delete entries not referenced by any active panel.

### Why per-package debouncing instead of global debouncing?

Global debouncing (current system: 500ms) means editing package A delays the rebuild of unrelated package B. Per-package debouncing (200ms per package) means each package rebuilds independently as soon as its own edits stabilize.

### What about TypeScript type checking?

Type checking remains a separate concern. The V2 build system compiles and bundles; it does not type-check. The existing `TypeDefinitionService` and `runTypeCheck()` flow can be invoked separately after builds complete, or in parallel. This keeps builds fast (esbuild is fast; tsc is slow).

After migration, typecheck reads types from `workspace/packages/` source. The `TypeDefinitionService` uses a `packagesDir` variable — just point it to the new location.

### What about the routing bridge?

The `separate-server` branch added `routingBridge.ts` in `@natstack/runtime` which routes RPC calls by service name — server services (ai, db, typecheck) go via WebSocket, everything else via Electron IPC. V2 adds `"build"` to the server-routed services. Panels that need to trigger rebuilds (e.g., a dev tools panel) can call `bridge.call("build", "recompute")` and it routes automatically to the server.

### What about the dual server bundles?

`build.mjs` now produces two server bundles:
- `dist/server-electron.cjs` — spawned by Electron, uses Electron's better-sqlite3
- `dist/server.mjs` — standalone headless, uses system better-sqlite3 from `server-native/`

V2 code lives in `src/server/buildV2/` and gets bundled into both. No special handling needed.

### Why eliminate workers entirely?

Worker panels exist to run untrusted code in a sandboxed WebContentsView. The only current worker is `template-builder`, which clones git repos to OPFS. This doesn't need sandboxing — the server process already has full git access. Moving the logic to a server RPC method is simpler, faster (no WebContentsView startup overhead), and eliminates the entire worker build/lifecycle infrastructure (builtinWorkerBuilder, buildWorkerAsync, rebuildWorkerPanel, templateBuilderWorkers Set, worker panel state tracking).

The worker concept is deeply embedded: `PanelType` union, `PanelManifest.type`, `WorkerChildSpec` in the runtime API, `CallerKind` in service dispatch, and `"worker"` in every service policy `allowed` array. Since template-builder is the only worker that has ever existed, removing it means the entire abstraction is dead. Migration 7 removes `"worker"` from all type unions, policy tables, and runtime contracts. If background computation is needed in the future, it should use the server process (which already handles AI, Git, builds, etc.) rather than reinventing hidden WebContentsView workers.

### Bootstrap strategy (first-run with zero shipped content)

The workspace-agnostic principle means the production app ships no panels, no about pages, no workspace content. But the current `createDefaultWorkspaceConfig()` in `workspace/loader.ts` sets `rootPanel: "panels/chat-launcher"` and expects shipped panel bundles to exist.

V2 resolves this cleanly:

1. **The workspace IS the source.** The app opens a workspace directory path (configured at install time, stored in user preferences, or passed as CLI argument). That directory contains `workspace/panels/`, `workspace/about/`, etc. — all source code, not pre-built bundles.

2. **First run builds from source.** When the app opens a workspace for the first time, V2 computes effective versions for all units, finds no cache entries, and builds everything. This is a one-time cost (~10-15 seconds for all panels + about pages). Subsequent launches are instant cache hits.

3. **Default workspace scaffolding.** `createDefaultWorkspaceConfig()` creates the directory structure and writes `natstack.yml` with `rootPanel: "panels/chat-launcher"`. The chat-launcher source must exist in the workspace being opened — it's workspace content, not app content. For a fresh install with no workspace, the installer or first-run wizard clones/copies a template workspace (git repo or bundled archive).

4. **Development vs. production.** In development, the workspace is `./workspace/` in the repo. In production, the workspace is a user-specified directory. Both are built identically by V2 — the app doesn't distinguish them.

This eliminates the `build-dist.mjs` "pre-compile panels" step, the `dist/shipped-panels/` directory, the `tryLoadShippedPanel()` code path, and the coupling between app version and workspace content.
