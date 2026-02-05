/**
 * Build System Types
 *
 * Defines the BuildStrategy interface and related types for the unified
 * builder architecture. Strategies encapsulate platform-specific behavior
 * (esbuild config, output processing) while the BuildOrchestrator handles
 * the common pipeline.
 */

import type * as esbuild from "esbuild";
import type { BuildKind, BuildWorkspace, BuildArtifactKey } from "./artifacts.js";
import type { TypeCheckDiagnostic } from "./sharedBuild.js";
import type { MainCacheManager } from "../cacheManager.js";

// Re-export for convenience
export type { BuildKind, BuildWorkspace, BuildArtifactKey };
export type { TypeCheckDiagnostic };

// ===========================================================================
// Build Context
// ===========================================================================

/**
 * Context passed to BuildStrategy methods during the build process.
 * Contains all the information a strategy needs to make decisions.
 */
export interface BuildContext<TManifest = unknown> {
  /** The build kind (panel, worker, agent) */
  kind: BuildKind;

  /** Absolute path to the source directory */
  sourcePath: string;

  /** The canonical path used for caching */
  canonicalPath: string;

  /** The resolved git commit SHA */
  commit: string;

  /** Resolved entry point file (relative to sourcePath) */
  entryPoint: string;

  /** Build workspace with directories for deps, build output, etc. */
  workspace: BuildWorkspace;

  /** Resolved artifact key for this build */
  artifactKey: BuildArtifactKey;

  /** The validated manifest from package.json */
  manifest: TManifest;

  /** Node module resolution paths */
  nodePaths: string[];

  /** ESM package versions for version pinning (from dependency installation) */
  esmVersions?: Map<string, string>;

  /** Logger function */
  log: (message: string) => void;

  // Multi-pass build support fields

  /** Hash of installed dependencies (from installDependencies result) */
  dependencyHash: string;

  /** Cache manager for persistent caching across builds */
  cacheManager: MainCacheManager;

  /** Mutable state that persists across build passes within a single build */
  passState: Map<string, unknown>;

  /** Metafile from the previous build pass (undefined on first pass) */
  lastMetafile?: esbuild.Metafile;

  /** Current build pass number (1-indexed) */
  passNumber: number;
}

// ===========================================================================
// Build Options
// ===========================================================================

/**
 * Common build options shared across all build types.
 */
export interface BaseBuildOptions {
  /** Absolute path to the workspace root */
  workspaceRoot: string;

  /** Relative path within workspace (e.g., "agents/my-agent", "panels/chat") */
  sourcePath: string;

  /** Optional git ref (branch, tag, or commit SHA) */
  gitRef?: string;

  /** Whether to emit inline sourcemaps (default: true) */
  sourcemap?: boolean;
}

/**
 * Panel-specific build options.
 */
export interface PanelBuildOptions extends BaseBuildOptions {
  /**
   * Run panel with full Node.js API access instead of browser sandbox.
   * - `true`: Unsafe mode with default scoped filesystem
   * - `string`: Unsafe mode with custom filesystem root
   */
  unsafe?: boolean | string;
}

/**
 * Worker-specific build options.
 */
export interface WorkerBuildOptions extends BaseBuildOptions {
  /** Run worker with Node.js integration */
  unsafe?: boolean | string;
}

/**
 * Agent-specific build options (no unsafe mode - agents always have Node.js access).
 */
export interface AgentBuildOptions extends BaseBuildOptions {
  // Agents always run in Node.js, no unsafe flag needed
}

// ===========================================================================
// Platform Configuration
// ===========================================================================

/**
 * Platform configuration returned by strategy.
 */
export interface PlatformConfig {
  /** esbuild platform: "browser" or "node" */
  platform: "browser" | "node";

  /** esbuild target (e.g., "es2022", "node20") */
  target: string;

  /** Output format: "esm" or "cjs" */
  format: "esm" | "cjs";

  /** Custom conditions for package.json exports field */
  conditions?: string[];

  /** Whether to enable code splitting */
  splitting?: boolean;
}

// ===========================================================================
// Build Output
// ===========================================================================

/**
 * Base build output with common fields.
 */
export interface BaseBuildOutput {
  /** Whether the build succeeded */
  success: boolean;

  /** Error message if build failed */
  error?: string;

  /** Full build log */
  buildLog?: string;

  /** TypeScript type errors found during build */
  typeErrors?: TypeCheckDiagnostic[];
}

/**
 * Successful build output with artifacts.
 */
export interface SuccessfulBuildOutput<TManifest = unknown, TArtifacts = unknown>
  extends BaseBuildOutput {
  success: true;

  /** The validated manifest */
  manifest: TManifest;

  /** Build-specific artifacts (bundle, html, assets, etc.) */
  artifacts: TArtifacts;

  /** Cache key for storing the result */
  cacheKey: string;
}

/**
 * Failed build output.
 */
export interface FailedBuildOutput extends BaseBuildOutput {
  success: false;
  error: string;
}

/**
 * Union type for build output.
 */
export type BuildOutput<TManifest = unknown, TArtifacts = unknown> =
  | SuccessfulBuildOutput<TManifest, TArtifacts>
  | FailedBuildOutput;

// ===========================================================================
// Panel-Specific Types
// ===========================================================================

/**
 * Asset map for panel builds.
 */
export type PanelAssetMap = Record<
  string,
  { content: string; encoding?: "base64" }
>;

/**
 * Panel build artifacts.
 */
export interface PanelArtifacts {
  /** The bundled JavaScript code (kept for backwards compatibility) */
  bundle: string;

  /** Generated HTML template */
  html: string;

  /** CSS bundle if any */
  css?: string;

  /** Additional asset files (path -> content + encoding) */
  assets?: PanelAssetMap;

  /** Path to stable artifacts directory (unified infrastructure) */
  stableDir: string;

  /** Path to the bundle file on disk */
  bundlePath: string;
}

/**
 * Worker build artifacts (subset of panel).
 */
export interface WorkerArtifacts {
  /** The bundled JavaScript code */
  bundle: string;
}

/**
 * Agent build artifacts.
 */
export interface AgentArtifacts {
  /** Path to the built bundle (.mjs file) */
  bundlePath: string;

  /** Path to node_modules for native addon resolution */
  nodeModulesDir: string;

  /** Path to stable artifacts directory (unified infrastructure) */
  stableDir: string;
}

// ===========================================================================
// Build Strategy Interface
// ===========================================================================

/**
 * Strategy interface for type-specific build behavior.
 *
 * The BuildOrchestrator handles the common pipeline while strategies
 * provide type-specific configuration and processing.
 */
export interface BuildStrategy<
  TManifest = unknown,
  TArtifacts = unknown,
  TOptions extends BaseBuildOptions = BaseBuildOptions
> {
  /** The build kind this strategy handles */
  readonly kind: BuildKind;

  /**
   * Get platform configuration for esbuild.
   * Determines platform, target, format, conditions, and splitting.
   */
  getPlatformConfig(options: TOptions): PlatformConfig;

  /**
   * Get default dependencies that are always installed.
   */
  getDefaultDependencies(): Record<string, string>;

  /**
   * Merge manifest dependencies with defaults.
   */
  mergeDependencies(manifestDeps?: Record<string, string>): Record<string, string>;

  /**
   * Validate and parse the natstack manifest from package.json.
   * Throws if manifest is invalid.
   */
  validateManifest(
    packageJson: Record<string, unknown>,
    sourcePath: string
  ): TManifest;

  /**
   * Get esbuild plugins for this build type.
   */
  getPlugins(ctx: BuildContext<TManifest>, options: TOptions): esbuild.Plugin[];

  /**
   * Get external modules that should not be bundled.
   */
  getExternals(
    ctx: BuildContext<TManifest>,
    options: TOptions
  ): string[];

  /**
   * Get banner JavaScript code to prepend to the bundle.
   */
  getBannerJs(ctx: BuildContext<TManifest>, options: TOptions): string;

  /**
   * Get additional esbuild options specific to this build type.
   */
  getAdditionalEsbuildOptions(
    ctx: BuildContext<TManifest>,
    options: TOptions
  ): Partial<esbuild.BuildOptions>;

  /**
   * Process the esbuild result into final artifacts.
   * This is where HTML generation, asset collection, etc. happen.
   */
  processResult(
    ctx: BuildContext<TManifest>,
    esbuildResult: esbuild.BuildResult,
    options: TOptions
  ): Promise<TArtifacts>;

  /**
   * Whether this build type supports fs/path shims.
   * Panels and safe workers do; agents and unsafe builds don't.
   */
  supportsShims(options: TOptions): boolean;

  /**
   * Compute a cache key suffix based on build options.
   * Options that affect build output must be in the cache key.
   */
  computeOptionsSuffix(options: TOptions): string;

  /**
   * Get additional TypeScript compiler options for the build tsconfig.
   * Used to configure jsx mode, lib, etc.
   *
   * Default: {} (use orchestrator defaults)
   */
  getTsconfigCompilerOptions?(options: TOptions): Record<string, unknown>;

  // ===========================================================================
  // Multi-Pass Build Hooks (all optional with sensible defaults)
  // ===========================================================================

  /**
   * Called before each build pass to prepare entry points.
   * Strategy can generate wrapper files, expose modules, etc.
   * Returns the ABSOLUTE entry point path to use for this pass.
   *
   * Default: path.join(ctx.sourcePath, ctx.entryPoint) (no transformation)
   */
  prepareEntry?(
    ctx: BuildContext<TManifest>,
    options: TOptions
  ): Promise<string>;

  /**
   * Called after each build pass to determine if another pass is needed.
   * Receives the esbuild result (including metafile).
   *
   * Default: false (single pass)
   * Max passes enforced (5) to prevent infinite loops.
   */
  shouldRebuild?(
    ctx: BuildContext<TManifest>,
    esbuildResult: esbuild.BuildResult,
    options: TOptions
  ): Promise<boolean> | boolean;

  /**
   * Build auxiliary bundles after main bundle is complete.
   * Used for workers, service workers, etc.
   * Returns additional artifacts to merge with main artifacts.
   *
   * Default: no auxiliary builds
   */
  buildAuxiliary?(
    ctx: BuildContext<TManifest>,
    mainResult: esbuild.BuildResult,
    options: TOptions
  ): Promise<Partial<TArtifacts> | undefined>;
}

// ===========================================================================
// Build Progress
// ===========================================================================

/**
 * Build progress state.
 */
export type BuildProgressState =
  | "provisioning"
  | "installing"
  | "building"
  | "type-checking"
  | "ready"
  | "error";

/**
 * Build progress callback payload.
 */
export interface BuildProgress {
  state: BuildProgressState;
  message: string;
  log?: string;
}

/**
 * Progress callback type.
 */
export type OnBuildProgress = (progress: BuildProgress) => void;
