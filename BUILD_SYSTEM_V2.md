# Build System V2: Design & Implementation Plan

## Guiding Principles

1. **A build is a pure function of git state.** Same git state = same output. Always.
2. **No cache invalidation.** Content-addressed storage keyed by effective versions. Old entries aren't invalidated — they're just unreferenced.
3. **Simplicity over cleverness.** Two concepts replace five cache layers: effective versions + a content-addressed build store.
4. **Speed through precision.** Only rebuild what actually changed. Never nuke everything.

---

## Part 1: Architecture

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
│               Effective Version Computer                     │
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
│                    Build Orchestrator                         │
│                                                              │
│  For each changed unit:                                      │
│    key = ev(unit)                                            │
│    if store.has(key) → serve from store                      │
│    else → build with esbuild, write to store                 │
│                                                              │
│  Concurrency: semaphore (4 parallel)                         │
│  Coalescing: dedup concurrent builds of same EV              │
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
│  ~/.config/natstack/builds/{ev_hash}/                        │
│    ├── bundle.js                                             │
│    ├── bundle.css  (if any)                                  │
│    ├── index.html  (panels only)                             │
│    ├── assets/     (images, fonts, etc.)                     │
│    └── metadata.json                                         │
│                                                              │
│  Immutable. Same EV = same content. Forever.                 │
│  GC: prune entries unreferenced by any active panel/agent.   │
└──────────────────────────────────────────────────────────────┘
```

### Internal Package Resolution (No Verdaccio)

Internal packages (`@workspace/*`) resolve at build time via esbuild aliases pointing to source:

```typescript
// Generated from the package DAG
alias: {
  "@workspace/core":              "workspace/packages/core/src/index.ts",
  "@workspace/runtime":           "workspace/packages/runtime/src/index.ts",
  "@workspace/agentic-messaging": "workspace/packages/agentic-messaging/src/index.ts",
  // ... all workspace packages
}
```

No registry. No tarballs. No install step for internal packages.

### External Package Resolution

External npm dependencies (react, zod, radix-ui, etc.) are installed into a shared cache keyed by the hash of external deps:

```
key = hash(sorted external dependencies from package.json)
~/.config/natstack/external-deps/{key}/node_modules/
```

External deps change rarely. This cache is extremely stable. Use Arborist or pnpm pointed at the real npm registry.

### Build Triggers

**Proactive (watcher):**
1. File change detected in workspace/
2. Recompute effective versions for affected subgraph (milliseconds)
3. Diff against previous EVs
4. Trigger builds for anything that changed

**On demand (panel/agent request):**
1. Look up `ev(unit)` in build store
2. Already built → serve immediately
3. Build in progress → await it
4. Not started → trigger build (fallback; watcher should have caught it)

**Cold start:**
1. Compute all effective versions
2. Check store for each
3. Build only what's missing

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
├── about/                 ← shell panels (7), formerly src/about-pages/
│   ├── about/
│   ├── adblock/
│   ├── agents/
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

## Part 3: Implementation Steps

### Phase 0: Preparation

**Step 0.1: Create the v2 build system module**

Create a new directory `src/main/buildV2/` to build in parallel without contaminating v1:

```
src/main/buildV2/
├── effectiveVersion.ts    ← EV computation (topo sort + bottom-up hash)
├── packageGraph.ts        ← DAG discovery from package.json files
├── buildStore.ts          ← Content-addressed build store (~/.config/natstack/builds/)
├── externalDeps.ts        ← External dependency installation + caching
├── builder.ts             ← esbuild orchestration (panels + agents)
├── watcher.ts             ← File watcher → EV recomputation → rebuild triggers
└── index.ts               ← Public API: initialize, build, getBuildResult
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
  // Topological order guarantees deps computed before dependents
  for (const node of graph.topologicalOrder()) {
    const depsEvs = node.internalDeps
      .map(dep => evMap[dep.path])
      .sort();  // deterministic ordering
    evMap[node.path] = hash(node.contentHash, ...depsEvs);
  }
  return evMap;
}
```

**Step 1.4: Diff computation**

Compare new EV map against previous EV map (loaded from disk on startup). Emit changeset of paths whose EV changed.

Previous EV map persisted to `~/.config/natstack/ev-map.json`. This file is derived state — if lost, recompute everything and rebuild what's missing from the store.

### Phase 2: Content-Addressed Build Store

**Step 2.1: Store layout** (`buildStore.ts`)

```
~/.config/natstack/builds/
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
- Internal: anything matching `@workspace*` prefixes → resolved via esbuild aliases
- External: everything else → installed via Arborist/pnpm

**Step 3.2: Shared external dep cache**

```typescript
function getExternalDepsDir(packageJson: object): string {
  const externalDeps = extractExternalDeps(packageJson);
  const key = hash(JSON.stringify(sortedEntries(externalDeps)));
  return path.join(configDir, "external-deps", key);
}
```

Install into `~/.config/natstack/external-deps/{hash}/node_modules/` using Arborist pointed at the public npm registry. Skip install if directory already exists.

### Phase 4: Builder

**Step 4.1: esbuild orchestration** (`builder.ts`)

Two build strategies, selected by manifest type:

**Panel/About build** (browser target):
- Platform: `browser` (or `node` if `unsafe: true`)
- Format: `esm` (or `cjs` if `unsafe: true`)
- Target: `es2022`
- Code splitting: enabled (unless unsafe)
- Plugins: fs/path shims (safe mode), React dedupe
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

**Step 4.3: Build alias generation**

Before each build, generate the esbuild `alias` map from the package graph:

```typescript
function generateAliases(graph: PackageGraph): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const pkg of graph.allPackages()) {
    aliases[pkg.name] = pkg.entryPoint;  // e.g. "workspace/packages/core/src/index.ts"
    // Also register sub-path exports if declared
    for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
      aliases[`${pkg.name}/${subpath}`] = target;
    }
  }
  return aliases;
}
```

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
6. Update persisted EV map

### Phase 6: Public API & Integration

**Step 6.1: Public API** (`index.ts`)

```typescript
interface BuildSystemV2 {
  // Initialize: discover packages, compute EVs, start watcher
  initialize(workspacePath: string): Promise<void>;

  // Get build result for a panel/agent (by workspace-relative path)
  getBuild(unitPath: string): Promise<BuildResult>;

  // Get effective version for a unit
  getEffectiveVersion(unitPath: string): string;

  // Get all effective versions
  getAllEffectiveVersions(): EffectiveVersionMap;

  // Force recompute (after git checkout, branch switch, etc.)
  recompute(): Promise<ChangeSet>;

  // Garbage collect unreferenced builds
  gc(activeUnits: string[]): Promise<{ freed: number }>;

  // Shutdown watcher
  shutdown(): void;
}
```

**Step 6.2: Integration points**

Wire into existing code:
- `panelManager.ts`: replace `buildPanelAsync()` to call `buildSystem.getBuild()`
- `agentBuilder.ts`: replace build logic to call `buildSystem.getBuild()`
- `src/main/index.ts`: replace Verdaccio startup with `buildSystem.initialize()`
- `shellServices.ts`: replace `clearBuildCache()` with `buildSystem.gc()`

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
4. **Build config aliases** (vitest.config.ts, packages/*/build.mjs): update path mappings
5. **String patterns** (isInternalPackage, etc.): remove `@natstack/` from prefix list
6. **Documentation** (BUILD_SYSTEM.md, PANEL_SYSTEM.md, PANEL_DEVELOPMENT.md, OPFS_PARTITIONS.md, workspace/skills/): update examples

### Migration 3: Move about pages → workspace/about/

**What moves:**

| From | To |
|------|----|
| `src/about-pages/about/` | `workspace/about/about/` |
| `src/about-pages/adblock/` | `workspace/about/adblock/` |
| `src/about-pages/agents/` | `workspace/about/agents/` |
| `src/about-pages/help/` | `workspace/about/help/` |
| `src/about-pages/keyboard-shortcuts/` | `workspace/about/keyboard-shortcuts/` |
| `src/about-pages/model-provider-config/` | `workspace/about/model-provider-config/` |
| `src/about-pages/new/` | `workspace/about/new/` |

Each gets a new `package.json` with `@workspace-about/*` scope and `"unsafe": true, "shell": true` in the natstack manifest.

**After move:** Delete `src/about-pages/` directory entirely.

### Migration 4: Eliminate workers

Move the `template-builder` logic into the main process or an agent. The git-clone-to-OPFS operation doesn't need a sandboxed worker — the main process already has full git access.

**After migration:** Delete `src/builtin-workers/` directory entirely.

---

## Part 5: Dead Code Removal

Everything listed below is deleted or gutted after V2 is operational and migrations are complete.

### Files to Delete Entirely

#### Build System V1 Core
| File | Lines | Purpose (now dead) |
|------|-------|--------------------|
| `src/main/verdaccioServer.ts` | ~1000 | Embedded npm registry |
| `src/main/cacheManager.ts` | ~254 | LRU build cache |
| `src/main/diskCache.ts` | ~120 | JSON persistence for build cache |
| `src/main/cacheUtils.ts` | ~312 | Multi-layer cache clearing |
| `src/main/dependencyGraph.ts` | ~290 | Consumer→package registry |
| `src/main/natstackPackageWatcher.ts` | ~141 | Chokidar watcher for packages/ |
| `src/main/aboutBuilder.ts` | ~200 | About page build pipeline |
| `src/main/builtinWorkerBuilder.ts` | ~150 | Worker build pipeline |

#### Build Pipeline V1
| File | Lines | Purpose (now dead) |
|------|-------|--------------------|
| `src/main/build/orchestrator.ts` | ~400 | V1 build coordinator |
| `src/main/build/sharedBuild.ts` | ~700 | Provisioning, Arborist install, dep hashing |
| `src/main/build/artifacts.ts` | ~250 | V1 artifact path computation |
| `src/main/build/bundleAnalysis.ts` | - | Bundle analysis utilities |
| `src/main/build/types.ts` | - | V1 build type definitions |
| `src/main/build/strategies/panelStrategy.ts` | - | Panel esbuild config |
| `src/main/build/strategies/agentStrategy.ts` | - | Agent esbuild config |
| `src/main/build/strategies/index.ts` | - | Strategy re-exports |

#### Package Store (Verdaccio Integration)
| File | Lines | Purpose (now dead) |
|------|-------|--------------------|
| `src/main/package-store/index.ts` | - | Store public API |
| `src/main/package-store/store.ts` | - | Content-addressable package storage |
| `src/main/package-store/fetcher.ts` | - | Package fetching from Verdaccio |
| `src/main/package-store/linker.ts` | ~350 | Arborist tree serialization + linking |
| `src/main/package-store/gc.ts` | - | Package store garbage collection |
| `src/main/package-store/schema.ts` | - | Store schema definitions |

#### Build Scripts & Config
| File | Lines | Purpose (now dead) |
|------|-------|--------------------|
| `build-dist.mjs` | ~1014 | Production pre-compilation of panels/about/workers |
| `BUILD_SYSTEM.md` | ~364 | V1 build system documentation (replaced by this doc) |

#### Directories to Delete
| Directory | Contents | Reason |
|-----------|----------|--------|
| `packages/` | 18 @natstack/* packages | Moved to workspace/packages/ |
| `src/about-pages/` | 7 about page directories | Moved to workspace/about/ |
| `src/builtin-workers/` | 1 worker (template-builder) | Eliminated |
| `src/main/build/` | Entire V1 build pipeline | Replaced by src/main/buildV2/ |
| `src/main/package-store/` | Entire package store | Replaced by external-deps cache |

### Files to Modify

#### Startup & Lifecycle (`src/main/index.ts`)

**Remove:**
- Verdaccio server creation, startup, publishing (~40 lines)
- NatstackPackageWatcher creation and initialization (~10 lines)
- Verdaccio subscription to GitWatcher (~5 lines)
- Verdaccio shutdown in cleanup (~5 lines)
- `import { createVerdaccioServer }` and related imports

**Add:**
- `buildSystemV2.initialize(workspacePath)` call
- `buildSystemV2.shutdown()` in cleanup

#### Panel Builder (`src/main/panelBuilder.ts`)

**Remove:**
- Shipped panel loading (tryLoadShippedPanel and related) (~100 lines)
- Direct dependency on V1 orchestrator, sharedBuild, artifacts
- V1 cache manager usage

**Replace:**
- `buildPanel()` → delegate to `buildSystemV2.getBuild()`
- `buildWorker()` → delete entirely (no workers)

#### Agent Builder (`src/main/agentBuilder.ts`)

**Remove:**
- Direct dependency on V1 orchestrator
- V1 cache manager usage

**Replace:**
- Build logic → delegate to `buildSystemV2.getBuild()`

#### Panel Manager (`src/main/panelManager.ts`)

**Remove:**
- `buildWorkerAsync()` method (~50 lines)
- `rebuildWorkerPanel()` method (~30 lines)
- Worker-related state tracking
- References to Verdaccio server

#### Shell Services (`src/main/ipc/shellServices.ts`)

**Remove:**
- `clearBuildCache()` implementation that calls `clearAllCaches()`
- Verdaccio cache invalidation calls

**Replace:**
- Simple `buildSystemV2.gc()` call + optional full recompute

#### App Build Script (`build.mjs`)

**Remove:**
- `buildWorkspacePackages()` function and STEP 1 (~50 lines)
- References to `packages/` directory for compilation

**Keep:**
- Protocol generation (STEP 0)
- Playwright core build (STEP 0.5) — evaluate if this can move to V2
- Main/preload/renderer bundle (STEP 2)
- Static asset copying (STEP 3)

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

#### Per-Package Build Scripts

**Update or delete:**
- `packages/git-ui/build.mjs` → moves to `workspace/packages/git-ui/build.mjs`, update refs
- `packages/playwright-core/build.mjs` → same
- `packages/react/build.mjs` → same

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
6. **`builder.ts`** — esbuild orchestration with alias generation, both strategies
7. **`watcher.ts`** — File watcher → EV recompute → build trigger
8. **`index.ts`** — Public API wiring everything together
9. **Integration tests**: build a test panel end-to-end through V2

### Sprint 3: Migrations

10. **Move `packages/` → `workspace/packages/`** (git mv)
11. **Rename `@natstack/*` → `@workspace/*`** (find-and-replace)
12. **Move `src/about-pages/` → `workspace/about/`** (git mv + add package.json manifests)
13. **Eliminate template-builder worker** (move logic to main process)
14. **Update pnpm-workspace.yaml, tsconfig paths, vitest aliases**
15. **Verify**: `pnpm install`, `pnpm type-check`, `pnpm test` all pass

### Sprint 4: Integration & Switchover

16. **Wire V2 into `src/main/index.ts`** — replace Verdaccio startup with `buildSystemV2.initialize()`
17. **Wire V2 into `panelBuilder.ts`** — replace build logic
18. **Wire V2 into `agentBuilder.ts`** — replace build logic
19. **Wire V2 into `panelManager.ts`** — remove worker methods
20. **Wire V2 into `shellServices.ts`** — replace cache clearing
21. **End-to-end test**: app starts, panels build, agents build, file changes trigger rebuilds

### Sprint 5: Dead Code Removal

22. **Delete V1 build system** (all files listed in Part 5)
23. **Delete `build-dist.mjs`**
24. **Clean up `build.mjs`** — remove package compilation step
25. **Clean up `electron-builder.yml`** — remove extraResources
26. **Clean up `package.json`** — remove Verdaccio/Arborist deps
27. **Delete `packages/` directory** (already moved)
28. **Delete `src/about-pages/`** (already moved)
29. **Delete `src/builtin-workers/`** (already eliminated)
30. **Replace `BUILD_SYSTEM.md`** with updated documentation

---

## Part 7: Key Design Decisions

### Why not keep Verdaccio for external deps?

Verdaccio is 1000 lines of embedded server code with version computation, change detection, publishing, caching, and file watching — all for serving our own packages to ourselves. External deps can use Arborist directly against the real npm registry. The complexity isn't justified.

### Why esbuild aliases instead of pre-compiled dist/?

Pre-compiling packages into `dist/` creates a build ordering problem: packages must be compiled in topological order before any panel can build. With aliases, esbuild resolves directly from TypeScript source. The topological ordering is implicit in the dependency graph — esbuild handles it naturally during bundling. One fewer build step, one fewer thing to go wrong.

### Why content-addressed storage instead of LRU cache?

LRU caches require invalidation logic. Content-addressed stores don't — entries are immutable, keyed by their content. You never ask "is this entry still valid?" You ask "does an entry exist for this EV?" The answer is always correct by construction. GC is trivial: delete entries not referenced by any active panel.

### Why per-package debouncing instead of global debouncing?

Global debouncing (current system: 500ms) means editing package A delays the rebuild of unrelated package B. Per-package debouncing (200ms per package) means each package rebuilds independently as soon as its own edits stabilize.

### What about TypeScript type checking?

Type checking remains a separate concern. The V2 build system compiles and bundles; it does not type-check. The existing `TypeDefinitionService` and `runTypeCheck()` flow can be invoked separately after builds complete, or in parallel. This keeps builds fast (esbuild is fast; tsc is slow).

### What about sub-path exports?

Several packages (notably `@workspace/agentic-messaging`) have sub-path exports like `@workspace/agentic-messaging/config`. The alias map in the builder must register these explicitly:

```typescript
aliases["@workspace/agentic-messaging"] = ".../agentic-messaging/src/index.ts";
aliases["@workspace/agentic-messaging/config"] = ".../agentic-messaging/src/config.ts";
aliases["@workspace/agentic-messaging/session"] = ".../agentic-messaging/src/session.ts";
// etc.
```

These are discovered from the `exports` field in each package's `package.json`.
