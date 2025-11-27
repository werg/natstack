/**
 * Configuration exports for @natstack/build
 *
 * This module contains only configuration and type exports,
 * with no runtime dependencies. It can be safely imported
 * in any context, including panels built with the standard builder.
 */

// Version and CDN configuration
export {
  VERSIONS,
  CDN_BASE_URLS,
  CDN_URLS,
  CDN_DEFAULTS,
  ESBUILD_CDN_FALLBACKS,
} from "./types.js";

// Framework presets
export {
  REACT_PRESET,
  createImportMap,
  getImportMapPackages,
} from "./types.js";

export type {
  PanelManifest,
  PanelBuildArtifacts,
  PanelBuildResult,
  BuildFileSystem,
  BuildOptions,
  DependencyResolver,
  FrameworkPreset,
} from "./types.js";
