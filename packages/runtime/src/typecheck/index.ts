/**
 * @natstack/runtime/typecheck - TypeScript type checking for panels and workers.
 *
 * This module provides type checking with module resolution that matches
 * the panel build system, ensuring developers get accurate feedback.
 *
 * @example
 * ```typescript
 * import { createTypeCheckService } from "@natstack/runtime/typecheck";
 *
 * const service = createTypeCheckService({
 *   panelPath: "/workspace/panels/my-panel",
 * });
 *
 * // Add panel files
 * service.updateFile("/workspace/panels/my-panel/index.tsx", sourceCode);
 *
 * // Run type checking
 * const result = service.check();
 * console.log(result.diagnostics);
 * ```
 */

// Service
export {
  TypeCheckService,
  createTypeCheckService,
  type TypeCheckServiceConfig,
  type TypeCheckResult,
  type BaseDiagnostic,
  type TypeCheckDiagnostic,
  type QuickInfo,
  type ExternalTypesResult,
} from "./service.js";

// Resolution
export {
  resolveModule,
  isFsModule,
  isFsPromisesModule,
  isPathModule,
  generatePathShimCode,
  isNatstackModule,
  getNatstackPackageName,
  packageToRegex,
  matchesDedupePattern,
  generateFsShimCode,
  isBareSpecifier,
  DEFAULT_DEDUPE_PACKAGES,
  FS_ASYNC_METHODS,
  FS_SYNC_METHODS,
  FS_CONSTANTS,
  type ModuleResolutionConfig,
  type ResolutionResult,
} from "./resolution.js";

// Virtual type definitions (for fs/path shims and globals - NOT @natstack/runtime which uses real types)
export { FS_TYPE_DEFINITIONS, PATH_TYPE_DEFINITIONS, GLOBAL_TYPE_DEFINITIONS, NODE_BUILTIN_TYPE_STUBS } from "./lib/index.js";

// Dynamic natstack package type loading
export {
  loadNatstackPackageTypes,
  loadSinglePackageTypes,
  findPackagesDir,
  clearNatstackTypesCache,
  preloadNatstackTypesAsync,
  type NatstackPackageTypes,
} from "./lib/index.js";

// Bundled TypeScript lib files
export { TS_LIB_FILES } from "./lib/typescript-libs.js";

// Type definition loader (for main process)
export {
  TypeDefinitionLoader,
  createTypeDefinitionLoader,
  getDefaultNodeModulesPaths,
  type TypeDefinitionLoaderConfig,
  type LoadedTypeDefinitions,
} from "./loader.js";

// File source abstraction
export {
  createDiskFileSource,
  createOpfsFileSource,
  createVirtualFileSource,
  findTypeScriptFiles,
  loadSourceFiles,
  type FileSource,
  type FileSourceStats,
} from "./sources.js";

// Watch mode
export {
  TypeCheckWatcher,
  createTypeCheckWatcher,
  TYPECHECK_EVENTS,
  type TypeCheckWatcherOptions,
  type TypeCheckDiagnosticsEvent,
  type TypeCheckFileUpdatedEvent,
} from "./watch.js";

// RPC client (for panels to fetch types from main process)
export {
  TypeDefinitionClient,
  createTypeDefinitionClient,
  type TypeDefinitionClientConfig,
  type PackageTypesResult,
  type PackageTypesResultRecord,
} from "./rpc-client.js";

// Factory for easy service creation
export {
  createPanelTypeCheckService,
  type PanelTypeCheckServiceConfig,
} from "./factory.js";
