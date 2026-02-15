# Build System V2

> All builds run in the server process (`src/server/buildV2/`).
> Electron requests builds via RPC. The headless server gets builds for free.

## Core Concepts

### Effective Versions

Every buildable unit — package, panel, about page, agent — gets an **effective version** (EV): a single hash capturing its own content and all its transitive internal dependencies.

```
ev(leaf)    = hash(treeHash(leaf))
ev(package) = hash(treeHash(package), ev(dep_1), ev(dep_2), ...)
```

Content is hashed via `git rev-parse <ref>^{tree}` — the git tree hash at the main branch. Each workspace unit is its own git repo, so the tree hash captures all tracked content in one command.

Computed bottom-up via topological sort. If `ev(X)` hasn't changed, X's build is still valid.

### Build Keys

The build key is the full cache identity:

```
build_key = hash(BUILD_CACHE_VERSION, unitName, ev, sourcemap)
```

`BUILD_CACHE_VERSION` (currently `"2"`) is incremented when build logic changes (plugins, esbuild options, shims) to invalidate all cached builds. Unit name is included to prevent different units with identical EVs from sharing builds.

### Content-Addressed Build Store

Builds are stored immutably at `{userData}/builds/{build_key}/`:

```
{build_key}/
  ├── bundle.js
  ├── bundle.css      (panels/about only)
  ├── index.html      (panels/about only)
  ├── package.json    (agents only — {"type":"module"})
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
├── effectiveVersion.ts   ← Git tree hashing, EV computation, ref-state persistence
├── buildStore.ts         ← Content-addressed artifact storage
├── externalDeps.ts       ← Transitive external dep collection + cached npm install
├── sourceExtractor.ts    ← Git archive extraction for reproducible builds
├── builder.ts            ← esbuild orchestration (panels + agents)
├── pushTrigger.ts        ← Git push event → EV recompute → rebuild
└── index.ts              ← Public API + RPC service handler
```

### Package Graph (`packageGraph.ts`)

Scans four workspace directories:

| Directory | Kind | Scope |
|-----------|------|-------|
| `workspace/packages/` | `package` | `@workspace/*` |
| `workspace/panels/` | `panel` | `@workspace-panels/*` |
| `workspace/about/` | `about` | `@workspace-about/*` |
| `workspace/agents/` | `agent` | `@workspace-agents/*` |

Each unit's `package.json` is read. Dependencies matching any workspace scope (`@workspace/`, `@workspace-panels/`, `@workspace-about/`, `@workspace-agents/`) become internal edges in the DAG. Both `dependencies` and `peerDependencies` are included (peers first, so regular deps override on conflict).

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

Ref specs affect EV computation: the dep's tree hash is resolved at the specified ref, not necessarily the main branch.

### Effective Version Computation (`effectiveVersion.ts`)

**Full computation** (`computeEffectiveVersions`): Walks nodes in topological order. For each node, computes `git rev-parse <main>^{tree}` for the content hash, then combines with dependency edge signatures (dep name + ref spec + commit + dep EV).

**Incremental recomputation** (`recomputeFromNode`): When a single node changes (push event), only recomputes EVs for that node and its reverse dependencies. Accepts an optional `commitSha` to pin the changed node at the exact push commit.

**Cold-start optimization** (`computeEffectiveVersionsWithCache`): Compares current ref state (main-branch commit SHA per repo) against persisted ref state. If a unit's commit hasn't changed and no dependency was recomputed, the previous EV is reused. Makes cold start O(changed repos) not O(all repos).

**Persisted state** (in `{userData}/`):
- `ev-map.json` — derived state, safe to delete (triggers full recompute)
- `ref-state.json` — per-unit commit SHAs for cold-start diff

### Source Extraction (`sourceExtractor.ts`)

Before building, source is extracted from git at the correct commit into a temp directory. This ensures builds match the EV regardless of working tree state.

**Two-phase extraction:**
1. **Resolve commits** — For each node in the transitive dependency closure, resolve the commit SHA. Prefers pre-captured commits from `commitMap` (built by push trigger from persisted ref state), falls back to resolving from git (cold-start/on-demand paths). All SHAs captured atomically before any extraction.
2. **Extract** — `git archive --format=tar <sha>` piped to `tar -x -C <dir>` for each node. Preserves workspace-relative paths.

The extracted tree is cleaned up after the build completes.

### External Dependencies (`externalDeps.ts`)

For panels and agents, external npm dependencies (react, zod, radix-ui, etc.) must include **transitive externals from all internal packages** — not just the top-level unit's own `package.json`.

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

**Agent build** (node target):
- `platform: "node"`, `target: "node20"`, `format: "esm"`
- Code splitting disabled
- No fs/path shims
- Native addons externalized (`*.node`, `fsevents`, `bufferutil`, etc.)
- Output: `bundle.mjs` (stored as `bundle.js` in build store with `package.json` `{"type":"module"}`)

**Concurrency:** Semaphore with `MAX_CONCURRENT_BUILDS = 4`. Build coalescing deduplicates concurrent builds of the same key.

**Workspace resolve plugin:** Resolves `@workspace/*` imports from the git-extracted source tree. Reads `package.json` exports fields with condition-based resolution (panel: `natstack-panel`, `import`, `default`; agent: `import`, `default`). Since extracted source lacks `dist/` (gitignored), the plugin maps `dist/` paths to their TypeScript source equivalents.

### Push Trigger (`pushTrigger.ts`)

Subscribes to git push events from the git server. Only processes pushes to `main`/`master` branches, plus non-main pushes that match a branch/ref-pinned dependency edge.

**On main-branch push:**
1. Check if `package.json` deps or natstack manifest changed (sorted JSON comparison to avoid key-order false positives). If changed → full rediscovery.
2. Otherwise: incremental path. Build a `commitMap` (pushed node at push commit, all other nodes at their persisted ref state commits). Recompute EVs from the pushed node upward. Build changed units using the `commitMap`.

**Full rediscovery** (triggered by dep/manifest changes or non-main ref pushes):
1. Re-scan workspace (`discoverPackageGraph`)
2. Snapshot all commit SHAs, pre-set content hashes
3. Compute EVs using pre-set hashes
4. Persist state, emit `"graph-updated"` event
5. Build changed units using the snapshot `commitMap`

Concurrent pushes are serialized via a promise queue.

### RPC Service (`index.ts`)

The build system is registered as the `"build"` RPC service:

| Method | Description |
|--------|-------------|
| `getBuild(unitPath)` | Get build result (from cache or build on demand) |
| `getEffectiveVersion(name)` | Get current EV for a unit |
| `recompute()` | Force full EV recomputation |
| `gc(activeUnits)` | Garbage collect unreferenced builds |
| `getAboutPages()` | List about pages with metadata (for launcher UI) |
| `hasUnit(name)` | Check if a unit exists in the graph |

`unitPath` resolution tries: package name → workspace-relative path → basename match.

---

## Workspace Layout

Each workspace unit is its own git repo. The build system requires this — source extraction uses `git archive` from each unit's directory.

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
│   ├── dirty-repo/
│   ├── model-provider-config/
│   └── ...
└── agents/                ← AI agents (node target)
    ├── claude-code-responder/
    ├── test-echo/
    └── ...
```

### Package Manifest

Unit metadata lives in `package.json` under the `natstack` key:

```json
{
  "name": "@workspace-about/model-provider-config",
  "natstack": {
    "type": "app",
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

| Field | Default | Description |
|-------|---------|-------------|
| `type` | — | Unit type (`"app"` for panels/about) |
| `title` | package name | Display title (used in HTML `<title>` and launcher) |
| `shell` | `false` | Grants shell service access (about pages) |
| `hiddenInLauncher` | `false` | Hide from launcher UI |
| `sourcemap` | `true` | Include inline source maps |
| `entry` | auto-detected | Explicit entry point path |
| `externals` | `{}` | Import map entries (externalized from bundle) |
| `exposeModules` | `[]` | Modules registered on `__natstackModuleMap__` |
| `dedupeModules` | `[]` | Additional packages to deduplicate (react/react-dom always deduped) |

---

## Build Triggers

**Git push (proactive):** Push to a unit's main branch → push trigger recomputes EVs → builds changed units. This is the primary trigger.

**On demand (fallback):** `getBuild(unitPath)` checks the store. If missing, builds on the spot. The push trigger should have already built it, but this covers cold-start and first-launch scenarios.

**Cold start:** At server startup, compares persisted ref state against current refs. Recomputes EVs for changed units. Builds anything missing from the store.

**Force recompute:** `recompute()` re-discovers the full graph and recomputes all EVs from scratch.

---

## Initialization Flow

`initBuildSystemV2(workspaceRoot, gitServer)`:

1. Discover package graph from workspace
2. Snapshot current ref state (main-branch commit per repo)
3. Compute EVs with cold-start optimization (diff against persisted refs)
4. Persist ref state + EV map
5. Build any missing buildable units (panels, about pages, agents — not packages)
6. Start push trigger (subscribes to git server push events)
7. Return public API handle
