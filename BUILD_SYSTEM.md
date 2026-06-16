# Build System V2

> All builds run in the server process (`src/server/buildV2/`).
> Electron requests builds via RPC. The headless server gets builds for free.

## Core Concepts

### Effective Versions

Every buildable unit — package, panel, about page, worker, extension — gets an **effective version** (EV): a single hash capturing its own content and all its transitive internal dependencies.

```
ev(leaf)    = hash(treeHash(leaf))
ev(package) = hash(treeHash(package), ev(dep_1), ev(dep_2), ...)
```

Content is hashed from the GAD workspace state. Each unit contributes the
content-addressed subtree hash for its workspace-relative path at the selected
source state.

Computed bottom-up via topological sort. If `ev(X)` hasn't changed, X's build is still valid.

### Build Keys

The build key is the full cache identity:

```
build_key = hash(BUILD_CACHE_VERSION, unitName, ev, sourcemap)
```

`BUILD_CACHE_VERSION` (currently `"15"`) is incremented when build logic changes (plugins, esbuild options, shims) to invalidate all cached builds. Unit name is included to prevent different units with identical EVs from sharing builds.

### Runtime Provenance

Running panels, workers, skills, packages, extensions, and apps should report
the exact build identity they are using. Runtime-facing provenance is the
unit's effective version plus the artifact build key/revision when available.

For panels, `PanelHandle.getInfo()` includes `effectiveVersion` and build
metadata, and lifecycle calls such as `rebuildPanel()`, `reload()`, and
`rebuildAndReload()` return a `PanelLifecycleResult` with `operation`, `status`,
`loaded`, `rebuilt`, `reloaded`, `buildRevision`, and `effectiveVersion`.
`reload()` is a renderer reload only. After committed panel code changes, use
`rebuildAndReload()` so the target panel invalidates/rebuilds its bundle and
then reloads that same target renderer.

### Content-Addressed Build Store

Builds are stored immutably at `{userData}/builds/{build_key}/`:

```
{build_key}/
  ├── bundle.js
  ├── bundle.css      (panels/about only)
  ├── index.html      (panels/about only)
  ├── package.json    (workers/extensions only — {"type":"module"})
  ├── assets/         (chunks, images, fonts)
  └── metadata.json   (sentinel — kind, name, ev, sourcemap, builtAt)
```

No LRU, no TTL. GC prunes entries not referenced by any active unit. Race-safe writes use atomic rename with temp directories.

---

## Architecture

### File Layout

```
src/server/buildV2/
├── packageGraph.ts       ← DAG discovery from workspace package.json files
├── effectiveVersion.ts   ← State subtree hashing and EV computation
├── buildSource.ts        ← GAD-state materialization for reproducible builds
├── refs.ts               ← Source-ref helpers for pinned workspace inputs
├── stateTrigger.ts       ← VCS state advance → EV recompute → rebuild
├── buildStore.ts         ← Content-addressed artifact storage
├── externalDeps.ts       ← Transitive external dep collection + cached npm install
├── builder.ts            ← esbuild orchestration (panels + workers + extensions)
└── index.ts              ← Public API + RPC service handler
```

### Package Graph (`packageGraph.ts`)

Scans seven workspace directories:

| Directory               | Kind        | Scope                     |
| ----------------------- | ----------- | ------------------------- |
| `workspace/packages/`   | `package`   | `@workspace/*`            |
| `workspace/panels/`     | `panel`     | `@workspace-panels/*`     |
| `workspace/about/`      | `panel`     | `@workspace-about/*`      |
| `workspace/workers/`    | `worker`    | `@workspace-workers/*`    |
| `workspace/extensions/` | `extension` | `@workspace-extensions/*` |
| `workspace/skills/`     | `package`   | `@workspace-skills/*`     |
| `workspace/templates/`  | `template`  | —                         |

Each unit's `package.json` is read. Dependencies matching any workspace scope (`@workspace/`, `@workspace-panels/`, `@workspace-about/`, `@workspace-workers/`, `@workspace-extensions/`, `@workspace-skills/`) become internal edges in the DAG. Both `dependencies` and `peerDependencies` are included (peers first, so regular deps override on conflict).

The graph supports **dependency ref specs** — internal deps can pin to specific branches, refs, or commits:

```json
{
  "dependencies": {
    "@workspace/core": "workspace:*",
    "@workspace/ai": "workspace:branch:experimental",
    "@workspace/runtime": "workspace:commit:abc1234"
  }
}
```

Ref specs affect EV computation: the dependency source state is resolved at the specified ref, not necessarily the main branch.

### Effective Version Computation (`effectiveVersion.ts`)

**Full computation** (`computeEffectiveVersions`): Walks nodes in topological order. For each node, reads the unit subtree hash from the workspace state, then combines it with dependency edge signatures (dep name + ref spec + dep EV).

**Incremental recomputation** (`recomputeFromNodes`): When a state advance changes one or more units, only recomputes EVs for those units and their reverse dependencies.

**Cold-start optimization** (`computeEffectiveVersionsWithCache`): Compares current source-state hashes against persisted ref state. If a unit's content state hasn't changed and no dependency was recomputed, the previous EV is reused. Makes cold start O(changed units) not O(all units).

**Persisted state** (in `{userData}/`):

- `ev-map.json` — derived state, safe to delete (triggers full recompute)
- `ref-state.json` — per-unit source-state hashes for cold-start diff

### Build Source Materialization (`buildSource.ts`)

Before building, source is materialized from the immutable GAD state into a temp directory. This ensures builds match the EV regardless of later working tree edits.

The materialized tree is cleaned up after the build completes.

### External Dependencies (`externalDeps.ts`)

For panels, workers, and extensions, external npm dependencies (react, zod, radix-ui, etc.) must include **transitive externals from all internal packages** — not just the top-level unit's own `package.json`.

`collectTransitiveExternalDeps` walks the package graph, collecting all non-workspace dependencies. Dependencies with `workspace:` protocol are skipped (resolvable via root `node_modules`). When versions conflict, the higher version wins.

The union is hashed and installed to `{userData}/external-deps/{hash}/node_modules/` via `npm install`. Race-safe: installs to a temp directory first, writes a `.ready` sentinel, then atomically renames. Concurrent installs for the same deps hash are deduplicated by sentinel check.

### Builder (`builder.ts`)

Two build strategies, selected by unit kind:

**Panel/About build** (browser target):

- `platform: "browser"`, `format: "esm"`, `target: "es2022"`
- `jsx: "automatic"` (React 17+ transform)
- Code splitting enabled
- Plugins: workspace resolve, `.js` → `.ts` rewrite, `fs` shim, `path` shim, React/react-dom dedupe
- `fs` shim imports `{ fs as _fs }` from `@workspace/runtime` and re-exports individual methods as wrapper functions
- `path` shim delegates to `pathe` (browser-compatible)
- Forced split points for known heavy modules (`@mdx-js/mdx`, `typescript`, `monaco-editor`, etc.)
- Manifest `externals` produce an import map in the generated HTML
- Manifest `exposeModules` register modules on `globalThis.__natstackModuleMap__`
- Output: `bundle.js` + `bundle.css` + `index.html` + `assets/`

**Extension build** (node target):

- `platform: "node"`, `target: "node20"`, `format: "esm"`
- Code splitting disabled
- No fs/path shims
- Native addons externalized (`*.node`, `fsevents`, `bufferutil`, etc.)
- Output: `bundle.js` in the build store with `package.json` `{"type":"module"}`

**Library build** (CJS, for sandbox eval):

- `platform: "browser"`, `format: "cjs"`
- Code splitting disabled (single `bundle.js`)
- Caller supplies `externals[]` — specifiers already in the module map
- Used by `imports` parameter of the eval tool to load workspace packages on-demand

**Npm library build** (CJS, for sandbox eval):

- Validates specifier against npm naming rules (rejects paths, URLs, git refs)
- Installs an arbitrary npm package via `ensureExternalDeps` (cached, `--ignore-scripts`)
- Bundles with esbuild as CJS using a virtual entry file (`module.exports = require("pkg")`)
- Results cached in buildStore + in-flight coalescing (same as workspace library builds)
- Caller supplies `externals[]` to avoid re-bundling already-loaded modules
- Used by `imports` parameter of the eval tool with `"npm:<version>"` values
- Native addons are not supported (esbuild will fail to bundle `.node` files)

**Concurrency:** Semaphore with `MAX_CONCURRENT_BUILDS = 8` by default (override via `NATSTACK_MAX_CONCURRENT_BUILDS`). Build coalescing deduplicates concurrent builds of the same key.

**Workspace resolve plugin:** Resolves `@workspace/*` imports from the materialized source tree. Reads `package.json` exports fields with condition-based resolution (panel: `natstack-panel`, `import`, `default`; extension: `import`, `default`). Since build sources do not include generated `dist/` output, the plugin maps `dist/` paths to their TypeScript source equivalents.

### State Trigger (`stateTrigger.ts`)

Subscribes to GAD VCS state-advance events. Only the advanced head's changed paths and dependency graph decide what needs recomputation.

**On main-head advance:**

1. Check if `package.json` deps or natstack manifest changed (sorted JSON comparison to avoid key-order false positives). If changed → full rediscovery.
2. Otherwise: incremental path. Recompute EVs from changed units upward. Build changed units from the immutable state that triggered the advance.

**Full rediscovery** (triggered by dep/manifest changes or pinned source-ref advances):

1. Re-scan workspace (`discoverPackageGraph`)
2. Snapshot the relevant source-state hashes
3. Compute EVs using pre-set hashes
4. Persist state, emit `"graph-updated"` event
5. Build changed units from the triggering state snapshot

Concurrent state advances are serialized via a promise queue.

### RPC Service (`index.ts`)

The build system is registered as the `"build"` RPC service:

| Method                                        | Description                                            |
| --------------------------------------------- | ------------------------------------------------------ |
| `getBuild(unitPath)`                          | Get build result (from cache or build on demand)       |
| `getBuildNpm(specifier, version, externals?)` | Install + bundle an npm package as CJS for sandbox use |
| `getEffectiveVersion(name)`                   | Get current EV for a unit                              |
| `recompute()`                                 | Force full EV recomputation                            |
| `gc(activeUnits)`                             | Garbage collect unreferenced builds                    |
| `getAboutPages()`                             | List about pages with metadata (for launcher UI)       |
| `hasUnit(name)`                               | Check if a unit exists in the graph                    |

`unitPath` resolution tries: package name → workspace-relative path → basename match.

---

## Workspace Layout

Workspace units are directories in the shared GAD-backed source tree. Builds use
state materialization rather than per-unit repositories.

```
workspace/
├── packages/              ← internal libraries (not directly buildable)
│   ├── core/
│   ├── runtime/
│   ├── ai/
│   ├── react/
│   ├── about-shared/
│   └── ...
├── panels/                ← user-facing panels (browser target)
│   ├── chat/
│   ├── chat-launcher/
│   └── ...
├── about/                 ← shell panels (browser target, shell service access)
│   ├── about/
│   ├── model-provider-config/
│   └── ...
└── extensions/            ← trusted Node extensions
    ├── @workspace-extensions/
    ├── test-echo/
    └── ...
```

### Package Manifest

Unit metadata lives in `package.json` under the `natstack` key:

```json
{
  "name": "@workspace-about/model-provider-config",
  "natstack": {
    "title": "Model Provider Config",
    "shell": true,
    "hiddenInLauncher": false,
    "sourcemap": true,
    "entry": "index.tsx",
    "externals": { "some-lib": "https://cdn.example.com/lib.js" },
    "exposeModules": ["react", "react-dom"],
    "dedupeModules": ["jotai"]
  }
}
```

| Field              | Default       | Description                                                         |
| ------------------ | ------------- | ------------------------------------------------------------------- |
| `title`            | package name  | Display title (used in HTML `<title>` and launcher)                 |
| `shell`            | `false`       | Grants shell service access (about pages)                           |
| `hiddenInLauncher` | `false`       | Hide from launcher UI                                               |
| `sourcemap`        | `true`        | Include inline source maps                                          |
| `entry`            | auto-detected | Explicit entry point path                                           |
| `externals`        | `{}`          | Import map entries (externalized from bundle)                       |
| `exposeModules`    | `[]`          | Modules registered on `__natstackModuleMap__`                       |
| `dedupeModules`    | `[]`          | Additional packages to deduplicate (react/react-dom always deduped) |

---

## Build Triggers

**VCS state advance (proactive):** A committed workspace state advance recomputes EVs and builds changed units. This is the primary trigger.

**On demand (fallback):** `getBuild(unitPath)` checks the store. If missing, builds on the spot. The state trigger should have already built it, but this covers cold-start and first-launch scenarios.

**Cold start:** At server startup, compares persisted source state against current state. Recomputes EVs for changed units. Builds anything missing from the store.

**Force recompute:** `recompute()` re-discovers the full graph and recomputes all EVs from scratch.

---

## Initialization Flow

`initBuildSystemV2(workspaceRoot, workspaceVcs)`:

1. Discover package graph from workspace
2. Snapshot current source state
3. Compute EVs with cold-start optimization (diff against persisted refs)
4. Persist ref state + EV map
5. Build any missing buildable units (panels, about pages, workers, extensions — not packages)
6. Start state trigger (subscribes to VCS state advances)
7. Return public API handle
