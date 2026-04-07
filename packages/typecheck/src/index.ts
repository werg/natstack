/**
 * @natstack/typecheck — TypeScript type checking for NatStack projects.
 *
 * Server-side type checking for panels, workspace packages, and workers.
 * The TypeCheckService runs TypeScript's language service against on-disk
 * source files, with workspace-package discovery via `pnpm-workspace.yaml`
 * and tsconfig.json honoring.
 *
 * @example
 * ```typescript
 * import { TypeCheckService, createDiskFileSource, loadSourceFiles } from "@natstack/typecheck";
 *
 * const service = new TypeCheckService({
 *   panelPath: "/abs/path/to/workspace/packages/my-pkg",
 * });
 *
 * const fileSource = createDiskFileSource("/abs/path/to/workspace/packages/my-pkg");
 * for (const [rel, content] of await loadSourceFiles(fileSource, ".")) {
 *   service.updateFile(rel, content);
 * }
 *
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
} from "./service.js";

// Workspace package discovery — used by TypeCheckService to map package
// names to source directories. Also exports the shared `parseWorkspaceImport`
// and `resolveExportSubpath` helpers that the esbuild panel builder consumes
// so there's one source of truth for workspace import parsing.
export {
  discoverWorkspaceContext,
  findMonorepoRoot,
  clearWorkspaceContextCache,
  parseWorkspaceImport,
  resolveExportSubpath,
  WORKSPACE_CONDITIONS,
  type WorkspaceContext,
  type WorkspacePackageInfo,
  type WorkspaceImportParts,
} from "./lib/index.js";

// Virtual type definitions — used by Monaco editor in panels (git-ui) to
// configure its in-browser TypeScript service. Not used by the server-side
// TypeCheckService.
export {
  FS_TYPE_DEFINITIONS,
  PATH_TYPE_DEFINITIONS,
  GLOBAL_TYPE_DEFINITIONS,
} from "./lib/index.js";

// Bundled TypeScript lib files — Monaco editor and TypeCheckService both
// use these to provide ES2022+ / DOM / esnext.disposable types without
// reading from typescript/lib/ at runtime.
export { TS_LIB_FILES } from "./lib/typescript-libs.js";

// Type definition loader — walks node_modules and reads `.d.ts` files for
// a named package. Used by the server-side `getPackageTypes` RPC and the
// eval-imports install flow.
export {
  TypeDefinitionLoader,
  createTypeDefinitionLoader,
  getDefaultNodeModulesPaths,
  type TypeDefinitionLoaderConfig,
  type LoadedTypeDefinitions,
} from "./loader.js";

// File source abstraction — `createDiskFileSource` + `loadSourceFiles` are
// the canonical way to feed source files into a TypeCheckService.
export {
  createDiskFileSource,
  loadSourceFiles,
  type FileSource,
  type FileSourceStats,
} from "./sources.js";
