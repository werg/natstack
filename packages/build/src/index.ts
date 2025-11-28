/**
 * @natstack/build - Browser-compatible panel build library
 *
 * This package provides the ability to build NatStack panels entirely
 * within the browser using esbuild-wasm, OPFS for file storage, and
 * CDN-based dependency resolution.
 *
 * Usage in a panel:
 *
 * ```typescript
 * import { BrowserPanelBuilder, createOpfsFileSystem, initializeEsbuild } from "@natstack/build/browser";
 *
 * // Initialize esbuild-wasm
 * await initializeEsbuild();
 *
 * // Create OPFS-backed file system
 * const fs = await createOpfsFileSystem();
 *
 * // Create builder
 * const builder = new BrowserPanelBuilder({
 *   basePath: "/panels/my-child-panel",
 *   fs,
 *   dependencyResolver: { type: "cdn" },
 * });
 *
 * // Build the panel
 * const result = await builder.build("/panels/my-child-panel");
 *
 * if (result.success) {
 *   // Pass artifacts to parent to launch
 *   await panelBridge.launchChild(result.artifacts);
 * }
 * ```
 */

// Types
export type {
  PanelManifest,
  PanelBuildArtifacts,
  PanelBuildResult,
  BuildFileSystem,
  BuildOptions,
  DependencyResolver,
  FrameworkPreset,
} from "./types.js";

// Version and CDN configuration
export {
  VERSIONS,
  CDN_BASE_URLS,
  CDN_URLS,
  CDN_DEFAULTS,
} from "./types.js";

// Framework presets
export {
  REACT_PRESET,
  createImportMap,
  getImportMapPackages,
} from "./types.js";

// Prebundled registry
export {
  registerPrebundled,
  registerPrebundledBatch,
  getPrebundledRegistry,
  isPrebundled,
  getPrebundled,
  clearPrebundledRegistry,
  DEFAULT_PREBUNDLED_PACKAGES,
  RUNTIME_MODULE_MAP,
} from "./prebundled.js";
export type { PrebundledRegistry } from "./prebundled.js";

// CDN resolver
export { createCdnResolverPlugin, getCdnUrl } from "./cdn-resolver.js";

// Browser builder (for panels that want to build children)
export {
  BrowserPanelBuilder,
  setEsbuildInstance,
  getEsbuildInstance,
  isEsbuildInitialized,
  setDevMode,
  isDevMode,
  clearBuildCache,
} from "./browser-builder.js";

// Unified cache manager
export {
  UnifiedCache,
  getUnifiedCache,
  initializeCache,
  clearCache,
  getCacheStats,
  computeHash,
} from "./cache-manager.js";
export type {
  CacheEntry,
  CacheStats,
  CacheOptions,
} from "./cache-manager.js";

// ESM module caching
export {
  fetchEsmModule,
  prefetchEsmModules,
  isEsmModuleCached,
  clearEsmCache,
} from "./esm-cache.js";
export type {
  FetchOptions,
} from "./esm-cache.js";
export type {
  BrowserBuildOptions,
  EsbuildAPI,
  EsbuildPlugin,
  EsbuildPluginBuild,
  EsbuildInitializer,
} from "./browser-builder.js";

// Type checker (for panels that want standalone type checking)
export {
  typeCheckPanel,
  isTypeScriptLoaded,
  preloadTypeScript,
} from "./type-checker.js";
export type {
  TypeCheckResult,
} from "./type-checker.js";
