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
  FsLoader,
  importModule,
  clearModuleCache,
  invalidateModule,
  readFile,
  writeFile,
  createFsPlugin,
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

// Dependency resolution
export {
  resolveDependency,
  resolveDependencies,
  getGitDependencies,
  parsePackageSpecifier,
  type ResolvedDependency,
  type DependencyResolverOptions,
  type PackageSpec,
  type PackageRegistry,
} from "./dependency-resolver.js";
