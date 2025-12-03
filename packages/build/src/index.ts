/**
 * @natstack/build
 *
 * Shared foundation for browser-based code building with esbuild-wasm and ZenFS.
 */

// esbuild singleton management
export {
  getEsbuild,
  isEsbuildAvailable,
  getEsbuildSync,
  type EsbuildInitOptions,
} from "./esbuild-init.js";

// Filesystem utilities (uses ZenFS which is backed by OPFS)
export {
  // New names
  FsLoader,
  importModule,
  clearModuleCache,
  invalidateModule,
  readFile,
  writeFile,
  createFsPlugin,
  // Legacy aliases for backward compatibility
  OPFSLoader,
  importFromOPFS,
  clearOPFSCache,
  invalidateOPFSModule,
  readOPFSFile,
  writeOPFSFile,
  createOPFSPlugin,
} from "./opfs-loader.js";

// Code transformation
export {
  transform,
  getLoaderForLanguage,
  TransformAbortError,
  type Loader,
  type TransformOptions,
  type TransformResult,
} from "./transform.js";

// Types
export { BuildError, type BuildErrorDetail } from "./types.js";
