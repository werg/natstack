/**
 * Package Store - Content-addressable storage for npm packages.
 *
 * This module provides pnpm-style package deduplication:
 * - Files stored once by SHA256 hash in a central store
 * - Hard-linked into node_modules for space efficiency
 * - SQLite for metadata, access tracking, and resolution caching
 *
 * Usage:
 * ```typescript
 * import {
 *   getPackageStore,
 *   createPackageFetcher,
 *   createPackageLinker,
 *   collectPackagesFromTree,
 * } from "./package-store/index.js";
 *
 * // Initialize
 * const store = await getPackageStore();
 * const fetcher = await createPackageFetcher(registryUrl);
 * const linker = await createPackageLinker(fetcher);
 *
 * // Use with Arborist
 * const arborist = new Arborist({ path: depsDir, registry: registryUrl });
 * const tree = await arborist.buildIdealTree();
 *
 * // Fetch all packages to store
 * const packages = collectPackagesFromTree(tree);
 * await fetcher.fetchAll(packages);
 *
 * // Link to node_modules
 * await linker.link(depsDir, tree);
 * ```
 */

// Schema and types
export {
  SCHEMA_SQL,
  type StoredFile,
  type PackageManifest,
  type GCOptions,
  type GCResult,
  type ResolutionCacheEntry,
  type PackageRow,
  type FileRow,
  type PackageFileRow,
  type ResolutionCacheRow,
} from "./schema.js";

// Store
export {
  PackageStore,
  getPackageStore,
  shutdownPackageStore,
  getDefaultStoreDir,
} from "./store.js";

// Fetcher
export {
  PackageFetcher,
  createPackageFetcher,
  type PackageSpec,
  type FetchOptions,
} from "./fetcher.js";

// Linker
export {
  PackageLinker,
  createPackageLinker,
  collectPackagesFromTree,
  serializeTree,
  hashDependencies,
  type SerializedTree,
  type SerializedTreeEntry,
} from "./linker.js";

// Garbage Collection
export { gc, gcDryRun, gcAsync, scheduleGC } from "./gc.js";
