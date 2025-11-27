/**
 * Browser-specific exports for @natstack/build
 *
 * This entry point includes OPFS filesystem and browser panel builder,
 * which are only available in browser environments.
 *
 * Note: esbuild-wasm is NOT statically imported. Instead, panels should:
 * 1. Dynamically import esbuild-wasm from CDN
 * 2. Call setEsbuildInstance() with the imported module
 * 3. Then use BrowserPanelBuilder
 *
 * This allows panels to control when and how esbuild is loaded.
 */

// Re-export everything from main index
export * from "./index.js";

// Browser-specific exports
export {
  BrowserPanelBuilder,
  setEsbuildInstance,
  getEsbuildInstance,
  isEsbuildInitialized,
  setDevMode,
  isDevMode,
} from "./browser-builder.js";
export type {
  EsbuildAPI,
  EsbuildPlugin,
  EsbuildPluginBuild,
  EsbuildInitializer,
} from "./browser-builder.js";
export { OpfsFileSystem, createOpfsFileSystem } from "./opfs-fs.js";

// Cache exports
export {
  getUnifiedCache,
  clearCache,
  type CacheMetrics,
  type CacheStats,
  type CacheEntry,
  type CacheOptions,
} from "./cache-manager.js";
