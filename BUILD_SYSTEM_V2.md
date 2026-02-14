# Build System V2: Design & Implementation Plan

> Based on the `separate-server` architecture: Electron is a thin GUI shell;
> backend services (Verdaccio, Git, PubSub, AI, builds) run in a spawned
> server process communicating via WebSocket RPC.

## Guiding Principles

1. **A build is a pure function of git state.** Same git state = same output. Always.
2. **No cache invalidation.** Content-addressed storage keyed by effective versions. Old entries aren't invalidated — they're just unreferenced.
3. **Simplicity over cleverness.** Two concepts replace five cache layers: effective versions + a content-addressed build store.
4. **Speed through precision.** Only rebuild what actually changed. Never nuke everything.
5. **Server-first.** The build system lives in the server process. Electron never touches builds directly.

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
│    key = ev(unit)                                            │
│    if store.has(key) → serve from store                      │
│    else → build with esbuild, write to store                 │
│                                                              │
│  Concurrency: semaphore (4 parallel)                         │
│  Coalescing: dedup concurrent builds of same EV              │
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
│  {userData}/builds/{ev_hash}/                                │
│    ├── bundle.js                                             │
│    ├── bundle.css  (if any)                                  │
│    ├── index.html  (panels only)                             │
│    ├── assets/     (images, fonts, etc.)                     │
│    └── metadata.json                                         │
│                                                              │
│  Immutable. Same EV = same content. Forever.                 │
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

Internal packages (`@workspace/*`) resolve at build time via the existing `createNatstackResolvePlugin()` pattern — an esbuild plugin that reads each package's `package.json` exports field and resolves the correct entry point. V2 generalizes this across the whole workspace:

```typescript
// Plugin resolves @workspace/* imports using package.json exports
build.onResolve({ filter: /^@workspace\// }, (args) => {
  const parsed = parseImport(args.path);
  const pkgDir = path.join(workspacePackagesDir, parsed.packageName);
  const pkgJson = readPackageJson(pkgDir);
  const target = resolveExportSubpath(pkgJson.exports, parsed.subpath, conditions);
  return { path: path.resolve(pkgDir, target) };
});
```

No registry. No tarballs. No install step for internal packages. This replaces Verdaccio's entire role for internal packages.

### External Package Resolution

External npm dependencies (react, zod, radix-ui, etc.) are installed into a shared cache keyed by the hash of external deps:

```
key = hash(sorted external dependencies from package.json)
{userData}/external-deps/{key}/node_modules/
```

External deps change rarely. This cache is extremely stable. Use Arborist or pnpm pointed at the real npm registry.

### Build Triggers

**Proactive (watcher, server-side):**
1. File change detected in workspace/
2. Recompute effective versions for affected subgraph (milliseconds)
3. Diff against previous EVs
4. Trigger builds for anything that changed
5. Notify Electron via `ws:event` so PanelManager can hot-reload

**On demand (panel/agent request via RPC):**
1. Electron calls `serverClient.call("build", "getBuild", [unitPath])`
2. Server looks up `ev(unit)` in build store
3. Already built → return immediately
4. Build in progress → await it
5. Not started → trigger build (fallback; watcher should have caught it)

**Cold start:**
1. `coreServices.ts` calls `buildSystem.initialize()` during server startup
2. Compute all effective versions
3. Check store for each
4. Build only what's missing

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
│   ├── dirty-repo/           ← new on separate-server
│   ├── git-init/             ← new on separate-server
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

**Scale:** ~335 import statements across ~207 source files, ~31 package.json files, ~6 build/config files, ~4 documentation files.

The existing `createNatstackResolvePlugin()` in `src/main/natstackResolvePlugin.ts` and its consumer in `@natstack/typecheck` (`parseNatstackImport`, `resolveExportSubpath`) rename to `@workspace` equivalents.

**About panels** get a `package.json` with natstack manifest:

```json
{
  "name": "@workspace-about/model-provider-config",
  "version": "0.1.0",
  "natstack": {
    "type": "app",
    "title": "Model Provider Config",
    "unsafe": true,
    "shell": true
  },
  "dependencies": {
    "@workspace/react": "*",
    "@workspace/runtime": "*"
  }
}
```

The `unsafe: true` flag gives node integration. The `shell: true` flag grants shell service access and routes through `natstack-about://` protocol.

---

## Part 3: Implementation

### New Files

Create `src/server/buildV2/` inside the server process codebase:

```
src/server/buildV2/
├── effectiveVersion.ts    ← EV computation (topo sort + bottom-up hash)
├── packageGraph.ts        ← DAG discovery from package.json files
├── buildStore.ts          ← Content-addressed build store ({userData}/builds/)
├── externalDeps.ts        ← External dependency installation + caching
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
- Hash includes: all source files (`.ts`, `.tsx`, `.js`, `.jsx`, `.json`, `.css`) + `package.json`
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
├── {ev_hash_1}/
│   ├── bundle.js
│   ├── bundle.css
│   ├── index.html
│   ├── assets/
│   └── metadata.json    ← { kind, name, ev, builtAt, esbuildMeta }
├── {ev_hash_2}/
│   └── ...
└── ...
```

Uses `getUserDataPath()` from `src/main/envPaths.ts` — works in both Electron (`app.getPath("userData")`) and headless server (`NATSTACK_USER_DATA_PATH` env var) modes.

**Step 2.2: Store API**

```typescript
interface BuildStore {
  has(ev: string): boolean;
  get(ev: string): BuildResult | null;
  put(ev: string, artifacts: BuildArtifacts): void;
  gc(activeEvs: Set<string>): { freed: number };
}
```

Trivially simple. No LRU, no TTL, no size limits (GC handles cleanup). `has()` is a directory existence check.

### Phase 3: External Dependency Cache

**Step 3.1: External dep extraction** (`externalDeps.ts`)

For a given panel/agent, partition its dependencies:
- Internal: anything matching `@workspace*` prefixes → resolved via resolve plugin
- External: everything else → installed via Arborist/pnpm

**Step 3.2: Shared external dep cache**

```typescript
function getExternalDepsDir(packageJson: object): string {
  const externalDeps = extractExternalDeps(packageJson);
  const key = hash(JSON.stringify(sortedEntries(externalDeps)));
  return path.join(getUserDataPath(), "external-deps", key);
}
```

Install into `{userData}/external-deps/{hash}/node_modules/` using Arborist pointed at the public npm registry. Skip install if directory already exists.

### Phase 4: Builder

**Step 4.1: esbuild orchestration** (`builder.ts`)

Two build strategies, selected by manifest type:

**Panel/About build** (browser target):
- Platform: `browser` (or `node` if `unsafe: true`)
- Format: `esm` (or `cjs` if `unsafe: true`)
- Target: `es2022`
- Code splitting: enabled (unless unsafe)
- Plugins: resolve plugin (generalized from `createNatstackResolvePlugin`), fs/path shims (safe mode), React dedupe
- Module resolution: uses `resolveExportSubpath()` and `BUNDLE_CONDITIONS` from `@natstack/typecheck` resolution module
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
- Build coalescing: if build for same EV is already in flight, return its promise

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
3. **Source imports** (~335 statements, ~207 files): `from "@natstack/core"` → `from "@workspace/core"`
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

Each gets a new `package.json` with `@workspace-about/*` scope and `"unsafe": true, "shell": true` in the natstack manifest.

**After move:** Delete `src/about-pages/` directory entirely.

### Migration 4: Eliminate workers

Move the `template-builder` logic into the server process or an agent. The server already has full git access and file system capabilities.

**After migration:** Delete `src/builtin-workers/` directory entirely.

---

## Part 5: Dead Code Removal

Everything listed below is deleted or gutted after V2 is operational and migrations are complete.

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
| `src/main/aboutBuilder.ts` | About page build pipeline with esbuild + resolve plugin — replaced by V2 builder |
| `src/main/builtinWorkerBuilder.ts` | Worker build pipeline — workers eliminated |

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
- `buildWorker()` function entirely

**Replace:**
- `buildPanel()` → delegate to server RPC `build.getBuild()`

#### About Builder (`src/main/aboutBuilder.ts`) — DELETE ENTIRELY

Currently builds about pages with its own esbuild pipeline + `createNatstackResolvePlugin`. V2 handles about pages as regular buildable units in workspace/about/.

#### Panel Manager (`src/main/panelManager.ts`)

**Remove:**
- `buildWorkerAsync()` method (~50 lines)
- `rebuildWorkerPanel()` method (~30 lines)
- Worker-related state tracking
- References to Verdaccio server/config

#### Agent Builder (`src/main/agentBuilder.ts`)

**Remove:**
- Direct dependency on V1 orchestrator
- V1 cache manager usage

**Replace:**
- Build logic → delegate to server RPC `build.getBuild()`

#### Shell Services (`src/main/ipc/shellServices.ts`)

**Remove:**
- `clearBuildCache()` implementation that calls `clearAllCaches()`
- Verdaccio cache invalidation calls

**Replace:**
- Simple `serverClient.call("build", "gc", [...])` + optional full recompute

#### App Build Script (`build.mjs`)

**Remove:**
- `buildWorkspacePackages()` function and STEP 1 (~50 lines)
- References to `packages/` directory for compilation

**Keep:**
- Protocol generation (STEP 0)
- Playwright core build (STEP 0.5) — evaluate if this can move to V2
- Main/preload/renderer/server bundle (STEP 2) — now builds 4 bundles: main, preload, renderer, server
- Static asset copying (STEP 3)

#### Resolve Plugin (`src/main/natstackResolvePlugin.ts`) — DELETE OR MOVE

This file currently provides `createNatstackResolvePlugin()` for the V1 about builder and worker builder. V2 subsumes this functionality inside `src/server/buildV2/builder.ts`. After V1 removal, this file has no consumers.

The resolution logic in `packages/typecheck/src/resolution.ts` (`parseNatstackImport`, `resolveExportSubpath`, `BUNDLE_CONDITIONS`) is **kept** — V2 uses it directly.

#### Electron Builder Config (`electron-builder.yml`)

**Remove:**
- `extraResources` entries for `dist/shipped-panels`, `dist/about-pages`, `dist/builtin-workers`

#### Root Package Config (`package.json`)

**Remove from dependencies:**
- `verdaccio`
- `@npmcli/arborist` (unless kept for external deps)
- `pacote`

**Remove from devDependencies:**
- `@types/npmcli__arborist`
- `@types/pacote`

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

Build the V2 system in parallel with V1. No V1 code is modified until V2 is proven working.

### Sprint 1: Foundation (no V1 changes)

1. **`packageGraph.ts`** — DAG discovery, topo sort, cycle detection
2. **`effectiveVersion.ts`** — Content hashing, bottom-up EV computation
3. **`buildStore.ts`** — Content-addressed store (put/get/has/gc)
4. **Tests** for all three: unit tests with fixture packages

### Sprint 2: Building (no V1 changes)

5. **`externalDeps.ts`** — External dependency extraction, cached installation
6. **`builder.ts`** — esbuild orchestration with resolve plugin, both strategies
7. **`watcher.ts`** — File watcher → EV recompute → build trigger → ws:event notification
8. **`index.ts`** — Public API + RPC service registration
9. **Integration tests**: build a test panel end-to-end through V2

### Sprint 3: Migrations

10. **Move `packages/` → `workspace/packages/`** (git mv)
11. **Rename `@natstack/*` → `@workspace/*`** (find-and-replace)
12. **Move `src/about-pages/` → `workspace/about/`** (git mv + add package.json manifests)
13. **Eliminate template-builder worker** (move logic to server process)
14. **Update pnpm-workspace.yaml, tsconfig paths, vitest aliases**
15. **Verify**: `pnpm install`, `pnpm type-check`, `pnpm test` all pass

### Sprint 4: Integration & Switchover

16. **Register build service in `coreServices.ts`** — replace Verdaccio/watcher startup with `buildSystemV2.initialize()`
17. **Add "build" RPC service to `rpcServer.ts`** — route build requests to V2
18. **Wire Electron `panelBuilder.ts`** — replace direct builds with `serverClient.call("build", ...)`
19. **Wire Electron `panelManager.ts`** — remove worker methods, update build calls
20. **Wire `agentBuilder.ts`** — replace build logic with RPC calls
21. **Wire `shellServices.ts`** — replace cache clearing with RPC gc call
22. **End-to-end test**: app starts, panels build, agents build, file changes trigger rebuilds, headless server builds work

### Sprint 5: Dead Code Removal

23. **Delete V1 build system** (all files listed in Part 5)
24. **Delete `build-dist.mjs`**
25. **Delete `src/main/natstackResolvePlugin.ts`** (subsumed by V2)
26. **Delete `src/main/verdaccioConfig.ts`** (no longer needed)
27. **Clean up `build.mjs`** — remove package compilation step
28. **Clean up `electron-builder.yml`** — remove extraResources
29. **Clean up `package.json`** — remove Verdaccio/Arborist deps
30. **Delete `packages/` directory** (already moved)
31. **Delete `src/about-pages/`** (already moved)
32. **Delete `src/builtin-workers/`** (already eliminated)
33. **Replace `BUILD_SYSTEM.md`** with updated documentation

---

## Part 7: Key Design Decisions

### Why run builds in the server process?

The `separate-server` architecture already moved all backend services (Verdaccio, Git, PubSub, AI) into a spawned server process. Builds are backend — they read the filesystem, run esbuild, write artifacts. Keeping them in the server means:
- Headless deployments get builds for free
- Electron crash/restart doesn't lose build state
- Build progress streams over the existing WebSocket event channel
- Single source of truth for build artifacts across multiple Electron windows (future)

### Why not keep Verdaccio for external deps?

Verdaccio is ~1000 lines of embedded server code with version computation, change detection, publishing, caching, and file watching — all for serving our own packages to ourselves. The `separate-server` branch already decoupled it (URL-based access via `verdaccioConfig.ts`, RPC for version queries), but it's still a massive accidental complexity tax. External deps can use Arborist directly against the real npm registry.

### Why generalize the existing resolve plugin rather than aliases?

The `separate-server` branch introduced `createNatstackResolvePlugin()` and the `resolution.ts` module in `@natstack/typecheck`. This plugin-based approach is better than raw aliases because:
- It reads `package.json` exports dynamically (handles all subpath patterns)
- It uses the same `resolveExportSubpath()` + `BUNDLE_CONDITIONS` as the type checker (resolution agreement = no false type errors)
- It handles conditional exports (browser/node/import/require) correctly
- V2 can reuse this logic directly instead of reinventing it

### Why content-addressed storage instead of LRU cache?

LRU caches require invalidation logic. Content-addressed stores don't — entries are immutable, keyed by their content. You never ask "is this entry still valid?" You ask "does an entry exist for this EV?" The answer is always correct by construction. GC is trivial: delete entries not referenced by any active panel.

### Why per-package debouncing instead of global debouncing?

Global debouncing (current system: 500ms) means editing package A delays the rebuild of unrelated package B. Per-package debouncing (200ms per package) means each package rebuilds independently as soon as its own edits stabilize.

### What about TypeScript type checking?

Type checking remains a separate concern. The V2 build system compiles and bundles; it does not type-check. The existing `TypeDefinitionService` and `runTypeCheck()` flow can be invoked separately after builds complete, or in parallel. This keeps builds fast (esbuild is fast; tsc is slow).

### What about the routing bridge?

The `separate-server` branch added `routingBridge.ts` in `@natstack/runtime` which routes RPC calls by service name — server services (ai, db, typecheck) go via WebSocket, everything else via Electron IPC. V2 adds `"build"` to the server-routed services. Panels that need to trigger rebuilds (e.g., a dev tools panel) can call `bridge.call("build", "recompute")` and it routes automatically to the server.

### What about the dual server bundles?

`build.mjs` now produces two server bundles:
- `dist/server-electron.cjs` — spawned by Electron, uses Electron's better-sqlite3
- `dist/server.mjs` — standalone headless, uses system better-sqlite3 from `server-native/`

V2 code lives in `src/server/buildV2/` and gets bundled into both. No special handling needed.
