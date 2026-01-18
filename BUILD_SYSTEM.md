# Build System Architecture

This document describes the NatStack build system's caching and storage mechanisms, including how workspace packages are published, how caches are invalidated, and how panel builds work.

## Overview

The build system uses **5 cache/storage layers** that work together to enable fast, reliable panel and worker builds:

```
┌─────────────────────────────────────────────────────────────────┐
│                    SOURCE OF TRUTH                              │
│  packages/*/dist/  (compiled workspace packages)                │
└─────────────────────────────────┬───────────────────────────────┘
                                  │ hashed & published
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                    VERDACCIO REGISTRY                           │
│  ~/.config/natstack/verdaccio-storage/                         │
│  - Local npm registry serving @natstack/* packages              │
│  - Versions: 0.1.0-{contentHash} (12 char SHA256)              │
│  - "latest" tag points to current version                       │
└─────────────────────────────────┬───────────────────────────────┘
                                  │ installed via Arborist
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                    BUILD ARTIFACTS                              │
│  ~/.config/natstack/build-artifacts/                           │
│  - panel/{pathId}/{commit}/deps/node_modules/                  │
│  - worker/{pathId}/{commit}/deps/node_modules/                 │
└─────────────────────────────────┬───────────────────────────────┘
                                  │ builds cached
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│              BUILD CACHE (Memory + Disk)                        │
│  MainCacheManager + ~/.config/natstack/build-cache.json        │
│  - panel:{path}:{commit} → build result                        │
│  - deps:{path}:{commit} → dependency hash                      │
└─────────────────────────────────┬───────────────────────────────┘
                                  │ state tracked
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PANEL STATE DB                               │
│  {workspace}/.databases/panels.db (SQLite)                     │
│  - Panel tree (id, type, title, parent)                        │
│  - Build state in artifacts JSON column                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Verdaccio: The Single Source of Truth

### Why Verdaccio?

NatStack uses an embedded [Verdaccio](https://verdaccio.org/) npm registry to serve workspace packages. This provides:

- **Native npm semantics** - No need for `workspace:*` protocol translation
- **Shared package cache** - All panel builds share the same installed packages
- **Proper transitive dependencies** - npm resolver handles dependency trees correctly
- **Content-addressed versioning** - Package versions include content hashes

### Package Version Format

```
@natstack/runtime@0.1.0-a1b2c3d4e5f6
                  ^^^^^  ^^^^^^^^^^^^
                  base   content hash (12 chars)
```

The content hash is computed from:
1. `package.json` (excluding version field)
2. `dist/` directory contents
3. `src/` directory contents

### Change Detection

On startup, `checkWorkspaceChanges()` compares each package's expected version (computed from content hash) against the actual version published to Verdaccio:

```typescript
// For each workspace package:
const expectedVersion = `${baseVersion}-${contentHash}`;
const actualVersion = await getPackageVersion(pkgName);  // Query Verdaccio
const changed = actualVersion !== expectedVersion;
```

**Verdaccio is the source of truth** - no separate hash file is needed.

### Key Files

| File | Purpose |
|------|---------|
| [verdaccioServer.ts](src/main/verdaccioServer.ts) | Embedded Verdaccio server, package publishing |
| `~/.config/natstack/verdaccio-storage/` | Package tarballs and metadata |

---

## Build Cache (MainCacheManager + DiskCache)

### Cache Keys

| Key Pattern | Value | Purpose |
|-------------|-------|---------|
| `panel:{path}:{commit}` | Build result JSON | Skip rebuilding unchanged panels |
| `worker:{path}:{commit}` | Build result JSON | Skip rebuilding unchanged workers |
| `deps:{path}:{commit}` | Dependency hash | Skip reinstalling if deps unchanged |

### Cache Properties

- **In-memory**: LRU cache, 100K entries max, 5GB total
- **Disk persisted**: `~/.config/natstack/build-cache.json` (5-second debounce)
- **Version controlled**: Schema version "4" (bumped on breaking changes)

### Dependency Hash Computation

The dependency hash determines whether `npm install` can be skipped:

```typescript
const hashInput = JSON.stringify(packageJson) +
                  JSON.stringify(verdaccioVersions);
const depsHash = sha256(hashInput);
```

Includes:
- Panel's `package.json` dependencies
- **Actual Verdaccio versions** (not just content hashes)

This ensures reinstalls when Verdaccio packages change, even if version specifiers like `*` remain the same.

### Key Files

| File | Purpose |
|------|---------|
| [cacheManager.ts](src/main/cacheManager.ts) | In-memory LRU cache singleton |
| [diskCache.ts](src/main/diskCache.ts) | Atomic persistence to JSON file |
| [panelBuilder.ts](src/main/panelBuilder.ts) | Uses cache for build results |

---

## Build Artifacts

Compiled outputs are stored outside the workspace to avoid polluting source trees:

```
~/.config/natstack/build-artifacts/
├── panel/
│   └── {sha256(path)[0:16]}/
│       └── {gitCommit}/
│           ├── deps/
│           │   ├── package.json
│           │   └── node_modules/   # Installed via Arborist
│           └── builds/
│               └── build-{timestamp}-{nonce}/  # Ephemeral
├── worker/
│   └── ...
└── git/
    └── {repoId}/
        └── temp-builds/           # Git checkouts
```

### Key Files

| File | Purpose |
|------|---------|
| [build/artifacts.ts](src/main/build/artifacts.ts) | Path computation, workspace creation |

---

## TypeDefinitionService

Provides TypeScript type definitions for panels via RPC. Handles both:
- **npm packages** - Installed via Arborist into `~/.config/natstack/types-cache/`
- **@natstack/* packages** - Loaded dynamically from `packages/*/dist/`

### @natstack Types Cache

Types for workspace packages are loaded lazily and cached in memory:

```typescript
private natstackTypes: Record<string, NatstackPackageTypes> | null = null;
```

**Important**: This cache is invalidated when workspace packages change via `invalidateNatstackTypes()`.

### Key Files

| File | Purpose |
|------|---------|
| [typecheck/service.ts](src/main/typecheck/service.ts) | TypeDefinitionService singleton |
| `~/.config/natstack/types-cache/` | npm package type definitions |

---

## Panel State Database

Panel tree and build state are persisted in SQLite, separate from build caches:

```
{workspace}/.databases/panels.db
```

### Tables

| Table | Purpose |
|-------|---------|
| `panels` | Panel tree (id, type, title, parentId, artifacts JSON) |
| `panel_events` | Audit log (created, focused events) |
| `panel_search_metadata` | FTS5 full-text search index |

### Build State

The `artifacts` JSON column tracks build progress:

```typescript
interface PanelArtifacts {
  buildState?: "pending" | "cloning" | "building" | "ready" | "error" | "dirty";
  buildProgress?: string;
  buildOutput?: string;
}
```

**Note**: Panel state is never cleared by cache operations. When caches are cleared, error states are reset to `pending` via `resetErrorPanels()`.

### Key Files

| File | Purpose |
|------|---------|
| [db/panelPersistence.ts](src/main/db/panelPersistence.ts) | CRUD operations |
| [db/panelSchema.ts](src/main/db/panelSchema.ts) | SQLite schema |

---

## Cache Invalidation

### When Workspace Packages Change

On app startup, if `publishChangedPackages()` detects changes (including fresh starts):

```typescript
if (changesDetected.changed.length > 0) {
  // Invalidate @natstack types FIRST to prevent stale reads during cache clearing
  getTypeDefinitionService().invalidateNatstackTypes();

  // Then clear all other caches
  await clearAllCaches({
    buildCache: true,      // In-memory + disk cache
    buildArtifacts: true,  // node_modules directories
    typesCache: true,      // npm type definitions
    verdaccioStorage: false, // Keep - we just updated it
  });
}
```

### Manual Cache Clearing

The UI menu "Clear Build Cache" uses the same `clearAllCaches()` function for consistent behavior.

### What Gets Cleared

| Cache Layer | Cleared on Package Change | Cleared Manually |
|-------------|---------------------------|------------------|
| MainCacheManager (memory) | Yes | Yes |
| DiskCache (build-cache.json) | Yes | Yes |
| BuildArtifacts (node_modules) | Yes | Yes |
| TypesCache (npm types) | Yes | Yes |
| @natstack types (memory) | Yes | Yes |
| Verdaccio storage | No | Optional |
| Panel state DB | Reset errors only | Reset errors only |

### Key Files

| File | Purpose |
|------|---------|
| [cacheUtils.ts](src/main/cacheUtils.ts) | `clearAllCaches()` implementation |
| [index.ts](src/main/index.ts) | Startup cache invalidation |

---

## Optimizations

### Verdaccio Versions Cache

`getVerdaccioVersions()` queries each workspace package's version from Verdaccio. Results are cached for 30 seconds to avoid repeated HTTP requests during rapid builds:

```typescript
private verdaccioVersionsCache: {
  versions: Record<string, string>;
  timestamp: number
} | null = null;

private readonly VERDACCIO_VERSIONS_TTL_MS = 30_000;
```

Cache is invalidated after publishing via `invalidateVerdaccioVersionsCache()`.

### Parallel Change Detection

`checkWorkspaceChanges()` queries all packages in parallel:

```typescript
const checks = packages.map(async (entry) => {
  const expectedVersion = this.getExpectedVersion(pkgPath);
  const actualVersion = await this.getPackageVersion(pkgJson.name);
  return { name, changed: actualVersion !== expectedVersion };
});
const results = await Promise.all(checks);
```

---

## Startup Flow

```
1. Create VerdaccioServer singleton
2. Start Verdaccio (auto port detection)
3. publishChangedPackages()
   ├─ checkWorkspaceChanges() - compare hashes vs Verdaccio
   ├─ If changed: publish packages, invalidate caches
   └─ invalidateVerdaccioVersionsCache()
4. If changes detected and not fresh start:
   ├─ clearAllCaches() - clear build cache, artifacts, types
   └─ invalidateNatstackTypes() - clear @natstack types
5. Start other servers (Git, CDP, PubSub)
6. Initialize RPC handlers
7. Ready for panel builds
```

---

## Build Flow (Panel)

```
1. Check MainCacheManager for panel:{path}:{commit}
   ├─ HIT: Return cached result
   └─ MISS: Continue to build

2. Check deps:{path}:{commit} for dependency hash
   ├─ MATCH + node_modules exists: Skip npm install
   └─ MISS: Install dependencies

3. Compute dependency hash:
   - Query getVerdaccioVersions() (cached 30s)
   - Hash = sha256(package.json + verdaccioVersions)

4. Install via Arborist (from Verdaccio registry)

5. Build with esbuild

6. Cache result in MainCacheManager
   - Auto-persists to DiskCache (5s debounce)

7. Update panel artifacts in SQLite
```

---

## Configuration Paths

| Path | Platform | Contents |
|------|----------|----------|
| `~/.config/natstack/` | Linux | Central config directory |
| `~/Library/Application Support/natstack/` | macOS | Central config directory |
| `%APPDATA%/natstack/` | Windows | Central config directory |
| `{workspace}/.databases/` | All | Panel state database |
| `{workspace}/.cache/` | All | Workspace-specific cache |
