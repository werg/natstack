/**
 * Build Orchestrator
 *
 * Coordinates the build pipeline for all build types (panels, workers, agents).
 * Wraps existing sharedBuild.ts functions into a unified pipeline:
 *
 *   provision → install → build → typecheck → cache
 *
 * Type-specific behavior is delegated to BuildStrategy implementations.
 */

import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";

import {
  provisionSource,
  resolveTargetCommit,
  installDependencies,
  getNodeResolutionPaths,
  writeBuildTsconfig,
  runTypeCheck,
  resolveEntryPoint,
  loadPackageJson,
  getDependencyHashFromCache,
  saveDependencyHashToCache,
  type VersionSpec,
} from "./sharedBuild.js";
import {
  createBuildWorkspace,
  stableBuildExists,
  promoteToStable,
  type BuildArtifactKey,
} from "./artifacts.js";
import { getMainCacheManager } from "../cacheManager.js";
import { isDev } from "../utils.js";
import { getAppNodeModules } from "../paths.js";
import { createDevLogger } from "../devLog.js";
import type {
  BuildStrategy,
  BuildContext,
  BaseBuildOptions,
  BuildOutput,
  OnBuildProgress,
  BuildProgress,
} from "./types.js";

const devLog = createDevLogger("BuildOrchestrator");

// ===========================================================================
// Build Orchestrator
// ===========================================================================

export class BuildOrchestrator {
  private cacheManager = getMainCacheManager();

  /** Per-build locks for coalescing concurrent builds */
  private buildLocks = new Map<string, Promise<BuildOutput>>();

  /**
   * Execute a build using the given strategy.
   *
   * @param strategy - The build strategy to use
   * @param options - Build options
   * @param onProgress - Optional progress callback
   * @returns Build output with artifacts or error
   */
  async build<TManifest, TArtifacts, TOptions extends BaseBuildOptions>(
    strategy: BuildStrategy<TManifest, TArtifacts, TOptions>,
    options: TOptions,
    onProgress?: OnBuildProgress
  ): Promise<BuildOutput<TManifest, TArtifacts>> {
    const { workspaceRoot, sourcePath, gitRef } = options;

    // Build coalescing: if already building this exact config, return the existing promise
    const lockKey = this.computeLockKey(strategy.kind, options);
    const existingBuild = this.buildLocks.get(lockKey);
    if (existingBuild) {
      devLog.verbose(`Build already in progress for ${sourcePath}, coalescing`);
      return existingBuild as Promise<BuildOutput<TManifest, TArtifacts>>;
    }

    const buildPromise = this.doBuild(strategy, options, onProgress);
    this.buildLocks.set(lockKey, buildPromise as Promise<BuildOutput>);

    try {
      return await buildPromise;
    } finally {
      this.buildLocks.delete(lockKey);
    }
  }

  private computeLockKey<TOptions extends BaseBuildOptions>(
    kind: string,
    options: TOptions
  ): string {
    return `${kind}:${options.workspaceRoot}:${options.sourcePath}:${JSON.stringify(options)}`;
  }

  /**
   * Update artifact paths from temp build dir to stable dir.
   * Handles both panel and agent artifacts.
   */
  private updateArtifactPaths<TArtifacts>(
    artifacts: TArtifacts,
    tempDir: string,
    stableDir: string
  ): TArtifacts {
    const result = { ...(artifacts as Record<string, unknown>) };

    // Update bundlePath if present (agents and panels)
    if (typeof result["bundlePath"] === "string") {
      result["bundlePath"] = (result["bundlePath"] as string).replace(tempDir, stableDir);
    }

    // Add stableDir to artifacts
    result["stableDir"] = stableDir;

    return result as TArtifacts;
  }

  private async doBuild<TManifest, TArtifacts, TOptions extends BaseBuildOptions>(
    strategy: BuildStrategy<TManifest, TArtifacts, TOptions>,
    options: TOptions,
    onProgress?: OnBuildProgress
  ): Promise<BuildOutput<TManifest, TArtifacts>> {
    const { workspaceRoot, sourcePath, gitRef, sourcemap = true } = options;
    const canonicalPath = path.resolve(workspaceRoot, sourcePath);

    let cleanup: (() => Promise<void>) | null = null;
    let buildLog = "";

    const log = (message: string) => {
      buildLog += message + "\n";
      devLog.verbose(message);
    };

    const emitProgress = (state: BuildProgress["state"], message: string) => {
      onProgress?.({ state, message, log: buildLog });
    };

    try {
      // Compute options suffix for cache key
      const optionsSuffix = strategy.computeOptionsSuffix(options);

      // Step 1: Early cache check (fast - no git checkout needed)
      emitProgress("provisioning", "Checking cache...");

      const version: VersionSpec | undefined = gitRef ? { gitRef } : undefined;
      const earlyCommit = await resolveTargetCommit(workspaceRoot, sourcePath, version);

      if (earlyCommit) {
        const cacheKey = `${strategy.kind}:${canonicalPath}:${earlyCommit}${optionsSuffix}`;
        const cached = this.cacheManager.get(cacheKey, isDev());

        if (cached) {
          // Verify stable build files also exist (unified infrastructure)
          const earlyArtifactKey: BuildArtifactKey = {
            kind: strategy.kind,
            canonicalPath,
            commit: earlyCommit,
          };
          const stableExists = stableBuildExists(earlyArtifactKey);

          if (stableExists) {
            log(`Cache hit for ${cacheKey} (stable build exists)`);
            emitProgress("ready", "Loaded from cache");

            try {
              const parsed = JSON.parse(cached) as BuildOutput<TManifest, TArtifacts>;
              return parsed;
            } catch {
              log(`Cache parse failed, will rebuild`);
            }
          } else {
            log(`Cache hit but stable build missing, will rebuild`);
          }
        }
      }

      // Step 2: Provision source at the right version
      emitProgress("provisioning", "Provisioning source...");
      log(`Provisioning ${sourcePath}${version ? ` at ${JSON.stringify(version)}` : ""}`);

      const provision = await provisionSource({
        sourceRoot: workspaceRoot,
        sourcePath,
        version,
        onProgress: (progress) => {
          log(`Git: ${progress.message}`);
        },
      });

      cleanup = provision.cleanup;
      const provisionedSourcePath = provision.sourcePath;
      const sourceCommit = provision.commit;

      log(`Source provisioned at ${provisionedSourcePath} (commit: ${sourceCommit.slice(0, 8)})`);

      // Cache key for storing the result
      const cacheKey = `${strategy.kind}:${canonicalPath}:${sourceCommit}${optionsSuffix}`;

      // Step 3: Load and validate manifest
      log(`Loading manifest...`);
      const packageJson = loadPackageJson(provisionedSourcePath);
      let manifest: TManifest;
      try {
        manifest = strategy.validateManifest(
          packageJson as Record<string, unknown>,
          provisionedSourcePath
        );
        log(`Manifest loaded`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log(`Manifest validation failed: ${errorMsg}`);
        if (cleanup) await cleanup();
        return {
          success: false,
          error: errorMsg,
          buildLog,
        };
      }

      // Step 4: Create build workspace
      const artifactKey: BuildArtifactKey = {
        kind: strategy.kind,
        canonicalPath,
        commit: sourceCommit,
      };
      const workspace = createBuildWorkspace(artifactKey);

      // Step 5: Install dependencies
      emitProgress("installing", "Installing dependencies...");
      log(`Installing dependencies...`);

      const runtimeDependencies = strategy.mergeDependencies(
        (manifest as Record<string, unknown>)["dependencies"] as Record<string, string> | undefined
      );
      const dependencyCacheKey = `deps:${canonicalPath}:${sourceCommit}`;
      const previousDependencyHash = getDependencyHashFromCache(dependencyCacheKey);

      const installResult = await installDependencies({
        depsDir: workspace.depsDir,
        dependencies: runtimeDependencies,
        previousHash: previousDependencyHash,
        canonicalPath,
        consumerKey: `${artifactKey.kind}:${artifactKey.canonicalPath}`,
        log,
        userWorkspacePath: workspaceRoot,
      });

      if (installResult) {
        await saveDependencyHashToCache(dependencyCacheKey, installResult.hash);
      }
      log(`Dependencies installed`);

      // Step 6: Resolve entry point
      const manifestEntry = (manifest as Record<string, unknown>)["entry"] as string | undefined;
      const entryPoint = resolveEntryPoint({
        sourcePath: provisionedSourcePath,
        manifestEntry,
      });
      log(`Entry point: ${entryPoint}`);

      // Step 7: Get node module resolution paths
      const nodePaths = getNodeResolutionPaths(
        provisionedSourcePath,
        workspace.nodeModulesDir,
        getAppNodeModules()
      );

      // Build context for strategy methods (with multi-pass fields)
      const ctx: BuildContext<TManifest> = {
        kind: strategy.kind,
        sourcePath: provisionedSourcePath,
        canonicalPath,
        commit: sourceCommit,
        entryPoint,
        workspace,
        artifactKey,
        manifest,
        nodePaths,
        esmVersions: installResult?.esmVersions,
        log,
        // Multi-pass support fields
        dependencyHash: installResult?.hash ?? "",
        cacheManager: this.cacheManager,
        passState: new Map(),
        passNumber: 0,
        lastMetafile: undefined,
      };

      // Step 8: Write build tsconfig
      const platformConfig = strategy.getPlatformConfig(options);
      const strategyTsconfigOptions = strategy.getTsconfigCompilerOptions?.(options) ?? {};
      const tsconfigPath = writeBuildTsconfig(
        workspace.buildDir,
        provisionedSourcePath,
        strategy.kind,
        {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          useDefineForClassFields: true,
          ...strategyTsconfigOptions,
        }
      );

      // Start type checking early (runs in parallel with builds)
      const typeCheckPromise = runTypeCheck({
        sourcePath: provisionedSourcePath,
        nodeModulesDir: workspace.nodeModulesDir,
        fsShimEnabled: strategy.supportsShims(options),
        log,
      });

      // Get strategy-specific build configuration (these don't change across passes)
      const plugins = strategy.getPlugins(ctx, options);
      const externals = strategy.getExternals(ctx, options);
      const bannerJs = strategy.getBannerJs(ctx, options);
      const additionalOptions = strategy.getAdditionalEsbuildOptions(ctx, options);

      if (externals.length > 0) {
        log(`Externals: ${externals.slice(0, 10).join(", ")}${externals.length > 10 ? ` ... and ${externals.length - 10} more` : ""}`);
      }

      // Determine output configuration based on platform config
      const outputConfig = platformConfig.splitting
        ? {
            outdir: workspace.buildDir,
            splitting: true,
            entryNames: "bundle",
            chunkNames: "chunk-[hash]",
          }
        : {
            outfile: path.join(
              workspace.buildDir,
              strategy.kind === "agent" ? "bundle.mjs" : "bundle.js"
            ),
          };

      // =========================================================================
      // Multi-pass build loop
      // =========================================================================
      const MAX_PASSES = 5;
      let buildResult: esbuild.BuildResult;

      for (let pass = 1; pass <= MAX_PASSES; pass++) {
        ctx.passNumber = pass;

        // Prepare entry point for this pass (strategy can generate wrappers)
        const entryPath = strategy.prepareEntry
          ? await strategy.prepareEntry(ctx, options)
          : path.join(provisionedSourcePath, entryPoint);

        // Emit progress for this pass
        const passMsg = pass === 1 ? "Building..." : `Building (pass ${pass})...`;
        emitProgress("building", passMsg);
        log(`Building ${strategy.kind} (pass ${pass})...`);

        // Run esbuild - with graceful degradation for subsequent passes
        try {
          const result = await esbuild.build({
            entryPoints: [entryPath],
            bundle: true,
            platform: platformConfig.platform,
            target: platformConfig.target,
            format: platformConfig.format,
            conditions: platformConfig.conditions,
            sourcemap: sourcemap ? "inline" : false,
            keepNames: true,
            metafile: true,
            absWorkingDir: provisionedSourcePath,
            nodePaths,
            plugins,
            external: externals,
            tsconfig: tsconfigPath,
            banner: {
              js: bannerJs,
            },
            ...outputConfig,
            ...additionalOptions,
          });
          buildResult = result;
        } catch (buildError) {
          // If first pass fails, propagate the error
          if (pass === 1) {
            throw buildError;
          }
          // Subsequent pass failures - continue with previous build output
          const msg = buildError instanceof Error ? buildError.message : String(buildError);
          log(`Warning: Build pass ${pass} failed: ${msg}`);
          log(`Continuing with previous build output (some features may not work correctly)`);
          break;
        }

        // Store metafile for next pass
        ctx.lastMetafile = buildResult.metafile;

        // Check if another pass is needed
        const needsRebuild = strategy.shouldRebuild
          ? await strategy.shouldRebuild(ctx, buildResult, options)
          : false;

        if (!needsRebuild) {
          if (pass > 1) {
            log(`Build stabilized after ${pass} passes`);
          }
          break;
        }

        if (pass === MAX_PASSES) {
          log(`Warning: Reached maximum build passes (${MAX_PASSES}), stopping`);
        }
      }

      // =========================================================================
      // Auxiliary builds and type checking (in parallel)
      // =========================================================================
      emitProgress("type-checking", "Type checking...");

      const [typeErrors, auxiliaryArtifacts] = await Promise.all([
        typeCheckPromise,
        strategy.buildAuxiliary?.(ctx, buildResult!, options),
      ]);

      // If there are type errors, fail the build
      if (typeErrors.length > 0) {
        const errorSummary = typeErrors
          .slice(0, 40)
          .map((e) => `${e.file}:${e.line}:${e.column}: ${e.message}`)
          .join("\n");
        const moreMsg =
          typeErrors.length > 40 ? `\n... and ${typeErrors.length - 40} more errors` : "";

        log(`Build failed with ${typeErrors.length} type error(s)`);

        // Cleanup
        try {
          await workspace.cleanupBuildDir();
        } catch {
          // Best-effort
        }
        if (cleanup) await cleanup();

        return {
          success: false,
          error: `TypeScript errors:\n${errorSummary}${moreMsg}`,
          typeErrors,
          buildLog,
        };
      }

      // Step 10: Process result into final artifacts
      const mainArtifacts = await strategy.processResult(ctx, buildResult!, options);

      // Deep merge artifacts if auxiliary builds produced any
      const artifacts: TArtifacts = auxiliaryArtifacts
        ? mergeArtifacts(mainArtifacts as Record<string, unknown>, auxiliaryArtifacts as Record<string, unknown>) as TArtifacts
        : mainArtifacts;

      log(`Build complete`);

      // Step 11: Promote build to stable location (unified infrastructure)
      // This moves the temp build dir to a deterministic path based on commit hash
      log(`Promoting build to stable location...`);
      const stableDir = await promoteToStable(workspace.buildDir, artifactKey);
      log(`Build promoted to ${stableDir}`);

      // Update artifacts with stable paths (strategy processResult uses temp paths)
      // The artifacts already contain the correct relative structure, just update base path
      const stableArtifacts = this.updateArtifactPaths(artifacts, workspace.buildDir, stableDir);

      // Step 12: Cache result and return
      const result: BuildOutput<TManifest, TArtifacts> = {
        success: true,
        manifest,
        artifacts: stableArtifacts,
        cacheKey,
        buildLog,
      };

      await this.cacheManager.set(cacheKey, JSON.stringify(result));
      log(`Cached build result`);

      // Cleanup git provision temp directory if any
      if (cleanup) {
        await cleanup();
        log(`Cleaned up temp directory`);
      }

      emitProgress("ready", "Build complete");

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`Build failed: ${errorMsg}`);

      if (cleanup) {
        try {
          await cleanup();
        } catch {
          // Ignore cleanup errors
        }
      }

      emitProgress("error", errorMsg);

      return {
        success: false,
        error: errorMsg,
        buildLog,
      };
    }
  }
}

// ===========================================================================
// Helper Functions
// ===========================================================================

/**
 * Deep merge artifacts, preserving both main and auxiliary assets.
 */
function mergeArtifacts(
  main: Record<string, unknown>,
  aux: Record<string, unknown>
): Record<string, unknown> {
  const mainAssets = (main["assets"] ?? {}) as Record<string, unknown>;
  const auxAssets = (aux["assets"] ?? {}) as Record<string, unknown>;
  return {
    ...main,
    ...aux,
    assets: { ...mainAssets, ...auxAssets },
  };
}

// ===========================================================================
// Singleton Instance
// ===========================================================================

let orchestratorInstance: BuildOrchestrator | null = null;

/**
 * Get the BuildOrchestrator singleton instance.
 */
export function getBuildOrchestrator(): BuildOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new BuildOrchestrator();
  }
  return orchestratorInstance;
}
