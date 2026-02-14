/**
 * Panel Builder
 *
 * Builds panels and workers for the browser environment.
 *
 * Delegates to BuildOrchestrator with PanelBuildStrategy for the actual build.
 * This file handles:
 * - Shipped panel loading (production builds)
 * - Public API wrappers for buildPanel/buildWorker
 * - Worker-specific build options
 */

import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import type { PanelManifest } from "./panelTypes.js";
import { getMainCacheManager } from "./cacheManager.js";
import { isDev } from "./utils.js";
import type { PanelBuildState } from "../shared/types.js";
import { getShippedPanelsDir, getAppNodeModules, getAppRoot } from "./paths.js";
import { getBuildOrchestrator } from "./build/orchestrator.js";
import {
  PanelBuildStrategy,
  generateAsyncTrackingBanner,
} from "./build/strategies/panelStrategy.js";
import type { PanelBuildOptions, PanelArtifacts, BuildOutput } from "./build/types.js";
import {
  provisionSource,
  resolveTargetCommit,
  installDependencies,
  getNodeResolutionPaths,
  writeBuildTsconfig,
  runTypeCheck,
  getDependencyHashFromCache,
  saveDependencyHashToCache,
  type VersionSpec,
} from "./build/sharedBuild.js";
import {
  createBuildWorkspace,
  promoteToStable,
  stableBuildExists,
  getStableArtifactsDir,
  type BuildArtifactKey,
} from "./build/artifacts.js";
import {
  isFsModule,
  isFsPromisesModule,
  generateFsShimCode,
  isPathModule,
  generatePathShimCode,
} from "@natstack/typecheck";
import { createDevLogger } from "./devLog.js";

// Re-export banner generators for backwards compatibility
export {
  generateModuleMapBanner,
  generateNodeCompatibilityPatch,
  generateAsyncTrackingBanner,
} from "./build/strategies/panelStrategy.js";

// ===========================================================================
// Types
// ===========================================================================

export interface BuildProgress {
  state: PanelBuildState;
  message: string;
  log?: string;
}

type PanelAssetMap = NonNullable<PanelArtifacts["assets"]>;

export interface ChildBuildResult {
  success: boolean;
  bundle?: string;
  html?: string;
  css?: string;
  assets?: PanelAssetMap;
  manifest?: PanelManifest;
  error?: string;
  buildLog?: string;
}

export interface WorkerBuildResult {
  success: boolean;
  bundle?: string;
  manifest?: PanelManifest;
  error?: string;
  buildLog?: string;
}

// ===========================================================================
// Constants
// ===========================================================================

const devLog = createDevLogger("PanelBuilder");

const BUNDLE_SIZE_LIMITS = {
  MAX_JS_BYTES: 150 * 1024 * 1024,
  MAX_HTML_BYTES: 10 * 1024 * 1024,
  MAX_CSS_BYTES: 10 * 1024 * 1024,
} as const;

const defaultWorkerDependencies: Record<string, string> = {
  "@types/node": "^22.9.0",
  pathe: "^2.0.0",
};

// ===========================================================================
// Panel Builder
// ===========================================================================

export class PanelBuilder {
  private cacheManager = getMainCacheManager();
  private orchestrator = getBuildOrchestrator();
  private panelStrategy = new PanelBuildStrategy();

  /**
   * Load and validate a panel manifest from package.json.
   */
  loadManifest(panelPath: string): PanelManifest {
    const absolutePanelPath = path.resolve(panelPath);
    const packageJsonPath = path.join(absolutePanelPath, "package.json");

    if (!fs.existsSync(packageJsonPath)) {
      throw new Error(`package.json not found in ${panelPath}`);
    }

    const packageContent = fs.readFileSync(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(packageContent) as Record<string, unknown>;

    return this.panelStrategy.validateManifest(packageJson, absolutePanelPath);
  }

  /**
   * Try to load a pre-built shipped panel (production builds).
   */
  tryLoadShippedPanel(panelName: string): ChildBuildResult | null {
    const shippedDir = getShippedPanelsDir();
    if (!shippedDir) return null;

    const panelDir = path.join(shippedDir, panelName);
    const bundlePath = path.join(panelDir, "bundle.js");
    const htmlPath = path.join(panelDir, "html.html");
    const manifestPath = path.join(panelDir, "manifest.json");
    const assetsPath = path.join(panelDir, "assets.json");

    if (!fs.existsSync(bundlePath) || !fs.existsSync(htmlPath) || !fs.existsSync(manifestPath)) {
      return null;
    }

    try {
      const bundle = fs.readFileSync(bundlePath, "utf-8");
      const html = fs.readFileSync(htmlPath, "utf-8");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as PanelManifest;

      const cssPath = path.join(panelDir, "bundle.css");
      const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf-8") : undefined;

      let assets: ChildBuildResult["assets"] | undefined;
      if (fs.existsSync(assetsPath)) {
        assets = JSON.parse(fs.readFileSync(assetsPath, "utf-8"));
      }

      console.log(`[PanelBuilder] Loaded shipped panel: ${panelName}`);

      return {
        success: true,
        bundle,
        html,
        css,
        assets,
        manifest,
        buildLog: `Loaded from shipped panel: ${panelName}`,
      };
    } catch (error) {
      console.warn(
        `[PanelBuilder] Failed to load shipped panel ${panelName}:`,
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
  }

  /**
   * Build a panel using the unified orchestrator.
   */
  async buildPanel(
    panelsRoot: string,
    panelPath: string,
    version?: { gitRef: string },
    onProgress?: (progress: BuildProgress) => void,
    options?: { sourcemap?: boolean; unsafe?: boolean | string }
  ): Promise<ChildBuildResult> {
    // Check for shipped panels first (production optimization)
    if (!version) {
      const shippedPanelName = this.getShippedPanelName(panelPath);
      if (shippedPanelName) {
        const shippedResult = this.tryLoadShippedPanel(shippedPanelName);
        if (shippedResult) {
          onProgress?.({ state: "ready", message: "Loaded shipped panel", log: shippedResult.buildLog });
          return shippedResult;
        }
      }
    }

    // Delegate to orchestrator
    const buildOptions: PanelBuildOptions = {
      workspaceRoot: panelsRoot,
      sourcePath: panelPath,
      gitRef: version?.gitRef,
      sourcemap: options?.sourcemap,
      unsafe: options?.unsafe,
    };

    const result = await this.orchestrator.build(
      this.panelStrategy,
      buildOptions,
      (progress) => {
        // Map orchestrator progress to panel build states
        const stateMap: Record<string, PanelBuildState> = {
          provisioning: "cloning",
          installing: "building",
          building: "building",
          "type-checking": "building",
          ready: "ready",
          error: "error",
        };
        onProgress?.({
          state: stateMap[progress.state] ?? "building",
          message: progress.message,
          log: progress.log,
        });
      }
    );

    return this.convertBuildOutputToResult(result);
  }

  /**
   * Build a worker bundle.
   * Workers have different requirements than panels:
   * - Import @natstack/runtime for console/globals setup
   * - No React auto-mount wrapper
   * - Different default dependencies
   */
  async buildWorker(
    panelsRoot: string,
    workerPath: string,
    version?: VersionSpec,
    onProgress?: (progress: BuildProgress) => void,
    options?: { unsafe?: boolean | string }
  ): Promise<WorkerBuildResult> {
    let cleanup: (() => Promise<void>) | null = null;
    let buildLog = "";
    const canonicalWorkerPath = path.resolve(panelsRoot, workerPath);

    const log = (message: string) => {
      buildLog += message + "\n";
      devLog.verbose(`[Worker] ${message}`);
    };

    try {
      const optionsSuffix = this.computeWorkerOptionsSuffix(options);

      // Early cache check
      const earlyCommit = await resolveTargetCommit(panelsRoot, workerPath, version);

      if (earlyCommit) {
        const cacheKey = `worker:${canonicalWorkerPath}:${earlyCommit}${optionsSuffix}`;
        const cached = this.cacheManager.get(cacheKey, isDev());

        if (cached) {
          const earlyArtifactKey: BuildArtifactKey = {
            kind: "worker",
            canonicalPath: canonicalWorkerPath,
            commit: earlyCommit,
          };
          const workerStableDir = getStableArtifactsDir(earlyArtifactKey);
          if (fs.existsSync(path.join(workerStableDir, "worker-bundle.js"))) {
            log(`Early cache hit for ${cacheKey}`);
            onProgress?.({ state: "ready", message: "Loaded from cache", log: buildLog });

            try {
              const parsed = JSON.parse(cached) as WorkerBuildResult;
              // Read bundle from stable dir
              const bundlePath = path.join(workerStableDir, "worker-bundle.js");
              if (fs.existsSync(bundlePath)) {
                parsed.bundle = fs.readFileSync(bundlePath, "utf-8");
              }
              return parsed;
            } catch {
              log(`Cache parse failed, will rebuild`);
            }
          } else {
            log(`Cache hit but stable build missing, will rebuild`);
          }
        }
      }

      // Provision source
      onProgress?.({ state: "cloning", message: "Fetching worker source...", log: buildLog });
      log(`Provisioning ${workerPath}${version ? ` at ${JSON.stringify(version)}` : ""}`);

      const provision = await provisionSource({
        sourceRoot: panelsRoot,
        sourcePath: workerPath,
        version,
        onProgress: (progress) => {
          log(`Git: ${progress.message}`);
          onProgress?.({ state: "cloning", message: progress.message, log: buildLog });
        },
      });

      cleanup = provision.cleanup;
      const sourcePath = provision.sourcePath;
      const sourceCommit = provision.commit;

      log(`Source provisioned at ${sourcePath} (commit: ${sourceCommit.slice(0, 8)})`);

      const cacheKey = `worker:${canonicalWorkerPath}:${sourceCommit}${optionsSuffix}`;

      // Load manifest
      let manifest: PanelManifest;
      try {
        manifest = this.loadManifest(sourcePath);
        log(`Manifest loaded: ${manifest.title}`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log(`Failed to load manifest: ${errorMsg}`);
        onProgress?.({ state: "error", message: errorMsg, log: buildLog });
        if (cleanup) await cleanup();
        return { success: false, error: errorMsg, buildLog };
      }

      const workerArtifactKey: BuildArtifactKey = {
        kind: "worker",
        canonicalPath: canonicalWorkerPath,
        commit: sourceCommit,
      };
      const workspace = createBuildWorkspace(workerArtifactKey);

      // Install dependencies
      onProgress?.({ state: "building", message: "Installing dependencies...", log: buildLog });
      log(`Installing dependencies...`);

      const dependencyCacheKey = `deps:${canonicalWorkerPath}:${sourceCommit}`;
      const previousDependencyHash = getDependencyHashFromCache(dependencyCacheKey);

      const workerDependencies = this.mergeWorkerDependencies(manifest.dependencies);
      const depResult = await installDependencies({
        depsDir: workspace.depsDir,
        dependencies: workerDependencies,
        previousHash: previousDependencyHash,
        canonicalPath: canonicalWorkerPath,
        consumerKey: `worker:${canonicalWorkerPath}`,
        log,
      });

      if (depResult?.hash) {
        await saveDependencyHashToCache(dependencyCacheKey, depResult.hash);
      }
      log(`Dependencies installed`);

      // Build worker bundle
      onProgress?.({ state: "building", message: "Building worker...", log: buildLog });
      log(`Building worker bundle...`);

      const entry = this.resolveWorkerEntryPoint(sourcePath, manifest);
      const entryPath = path.join(sourcePath, entry);
      const bundlePath = path.join(workspace.buildDir, "worker-bundle.js");
      const nodePaths = getNodeResolutionPaths(sourcePath, workspace.nodeModulesDir, getAppNodeModules());

      // Worker wrapper - imports runtime to set up console/globals
      const tempEntryPath = path.join(workspace.buildDir, "_worker_entry.js");
      const relativeUserEntry = path.relative(workspace.buildDir, entryPath);

      const wrapperCode = `
// Import worker runtime to set up console and globals
import "@natstack/runtime";

// Import user module
import ${JSON.stringify(relativeUserEntry)};
`;
      fs.writeFileSync(tempEntryPath, wrapperCode);

      // Create shim plugins for safe mode
      const plugins: esbuild.Plugin[] = [];
      if (!options?.unsafe) {
        plugins.push(this.createWorkerFsShimPlugin(workspace.depsDir));
        plugins.push(this.createWorkerPathShimPlugin(getAppRoot()));
      }

      const importMetaUrlShim = 'var __import_meta_url = require("url").pathToFileURL(__filename).href;';
      const bannerJs = options?.unsafe
        ? [importMetaUrlShim, generateAsyncTrackingBanner()].join("\n")
        : generateAsyncTrackingBanner();

      const [, typeErrors] = await Promise.all([
        esbuild.build({
          entryPoints: [tempEntryPath],
          bundle: true,
          platform: options?.unsafe ? "node" : "browser",
          target: "es2022",
          conditions: ["natstack-panel"],
          outfile: bundlePath,
          sourcemap: "inline",
          keepNames: true,
          format: options?.unsafe ? "cjs" : "esm",
          absWorkingDir: sourcePath,
          nodePaths,
          plugins,
          tsconfig: writeBuildTsconfig(workspace.buildDir, sourcePath, "worker", {
            target: "ES2022",
            useDefineForClassFields: true,
          }),
          supported: options?.unsafe ? { "dynamic-import": false } : undefined,
          define: options?.unsafe ? { "import.meta.url": "__import_meta_url" } : undefined,
          banner: {
            js: bannerJs,
          },
        }),
        runTypeCheck({
          sourcePath,
          nodeModulesDir: workspace.nodeModulesDir,
          fsShimEnabled: !options?.unsafe,
          log,
        }),
      ]);

      const bundle = fs.readFileSync(bundlePath, "utf-8");

      if (bundle.length > BUNDLE_SIZE_LIMITS.MAX_JS_BYTES) {
        const sizeMB = (bundle.length / 1024 / 1024).toFixed(2);
        const maxMB = (BUNDLE_SIZE_LIMITS.MAX_JS_BYTES / 1024 / 1024).toFixed(0);
        try { await workspace.cleanupBuildDir(); } catch {}
        if (cleanup) await cleanup();
        return {
          success: false,
          error: `Bundle too large: ${sizeMB}MB (max: ${maxMB}MB)`,
          buildLog,
        };
      }

      log(`Build complete: ${bundle.length} bytes JS`);

      if (typeErrors.length > 0) {
        const errorSummary = typeErrors
          .slice(0, 40)
          .map((e) => `${e.file}:${e.line}:${e.column}: ${e.message}`)
          .join("\n");
        const moreMsg = typeErrors.length > 40 ? `\n... and ${typeErrors.length - 40} more errors` : "";
        try { await workspace.cleanupBuildDir(); } catch {}
        if (cleanup) await cleanup();
        return {
          success: false,
          error: `TypeScript errors:\n${errorSummary}${moreMsg}`,
          buildLog,
        };
      }

      // Promote workspace to stable instead of cleaning up
      log(`Promoting worker build to stable location...`);
      const stableDir = await promoteToStable(workspace.buildDir, workerArtifactKey);
      log(`Worker build promoted to ${stableDir}`);

      const result: WorkerBuildResult = {
        success: true,
        bundle,
        manifest,
        buildLog,
      };

      // Cache only metadata (no bundle string)
      const cacheResult: WorkerBuildResult = {
        success: true,
        manifest,
        buildLog,
      };
      await this.cacheManager.set(cacheKey, JSON.stringify(cacheResult));
      log(`Cached worker build metadata`);

      if (cleanup) {
        await cleanup();
        log(`Cleaned up temp directory`);
      }

      onProgress?.({ state: "ready", message: "Build complete", log: buildLog });

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`Build failed: ${errorMsg}`);

      if (cleanup) {
        try { await cleanup(); } catch {}
      }

      onProgress?.({ state: "error", message: errorMsg, log: buildLog });

      return {
        success: false,
        error: errorMsg,
        buildLog,
      };
    }
  }

  private mergeWorkerDependencies(
    workerDependencies: Record<string, string> | undefined
  ): Record<string, string> {
    const merged = { ...defaultWorkerDependencies };
    if (workerDependencies) {
      Object.assign(merged, workerDependencies);
    }
    return merged;
  }

  private resolveWorkerEntryPoint(workerPath: string, manifest: PanelManifest): string {
    const absoluteWorkerPath = path.resolve(workerPath);

    const verifyEntry = (entryCandidate: string): string | null => {
      const entryPath = path.join(absoluteWorkerPath, entryCandidate);
      return fs.existsSync(entryPath) ? entryCandidate : null;
    };

    if (manifest.entry) {
      const entry = verifyEntry(manifest.entry);
      if (!entry) {
        throw new Error(`Entry point not found: ${manifest.entry}`);
      }
      return entry;
    }

    const defaultCandidates = ["index.tsx", "index.ts", "index.jsx", "index.js", "main.tsx", "main.ts"];
    const entries = defaultCandidates.filter(verifyEntry);
    if (entries.length > 1) {
      throw new Error(`Multiple entry points found (${entries.join(", ")}). Please specify 'entry' in manifest.`);
    } else if (entries.length === 1) {
      return entries[0]!;
    }

    throw new Error(`No entry point found. Provide an entry file or set 'entry' in manifest.`);
  }

  private computeWorkerOptionsSuffix(options?: { unsafe?: boolean | string }): string {
    const parts: string[] = [];
    if (options?.unsafe) {
      if (typeof options.unsafe === "string") {
        parts.push(`unsafe:${options.unsafe}`);
      } else {
        parts.push("unsafe");
      }
    }
    return parts.length > 0 ? `:${parts.join(":")}` : "";
  }

  private createWorkerFsShimPlugin(resolveDir: string): esbuild.Plugin {
    return {
      name: "worker-fs-shim",
      setup(build) {
        build.onResolve({ filter: /^(fs|node:fs|fs\/promises|node:fs\/promises)$/ }, (args) => {
          if (!isFsModule(args.path)) return null;
          return { path: args.path, namespace: "natstack-worker-fs-shim" };
        });

        build.onLoad({ filter: /.*/, namespace: "natstack-worker-fs-shim" }, (args) => {
          const isPromises = isFsPromisesModule(args.path);
          const contents = generateFsShimCode(isPromises);
          return { contents, loader: "js", resolveDir };
        });
      },
    };
  }

  private createWorkerPathShimPlugin(resolveDir: string): esbuild.Plugin {
    return {
      name: "worker-path-shim",
      setup(build) {
        build.onResolve({ filter: /^(path|node:path|path\/posix|node:path\/posix)$/ }, (args) => {
          if (!isPathModule(args.path)) return null;
          return { path: args.path, namespace: "natstack-worker-path-shim" };
        });

        build.onLoad({ filter: /.*/, namespace: "natstack-worker-path-shim" }, () => {
          const contents = generatePathShimCode();
          return { contents, loader: "js", resolveDir };
        });
      },
    };
  }

  /**
   * Clear the build cache.
   */
  async clearCache(): Promise<void> {
    await this.cacheManager.clear();
  }

  // ===========================================================================
  // Private Helper Methods
  // ===========================================================================

  /**
   * Check if a panel path corresponds to a shipped panel.
   */
  private getShippedPanelName(panelPath: string): string | null {
    const match = panelPath.match(/^panels\/([^/]+)$/);
    if (!match) return null;

    const panelName = match[1];
    const shippedDir = getShippedPanelsDir();
    if (!shippedDir) return null;

    const panelDir = path.join(shippedDir, panelName!);
    if (fs.existsSync(panelDir)) {
      return panelName!;
    }

    return null;
  }

  /**
   * Convert orchestrator BuildOutput to ChildBuildResult.
   */
  private convertBuildOutputToResult(
    result: BuildOutput<PanelManifest, PanelArtifacts>
  ): ChildBuildResult {
    if (!result.success) {
      return {
        success: false,
        error: result.error,
        buildLog: result.buildLog,
      };
    }

    const { bundle, html, css, assets } = result.artifacts;

    // Check bundle size limits
    if (bundle.length > BUNDLE_SIZE_LIMITS.MAX_JS_BYTES) {
      const sizeMB = (bundle.length / 1024 / 1024).toFixed(2);
      const maxMB = (BUNDLE_SIZE_LIMITS.MAX_JS_BYTES / 1024 / 1024).toFixed(0);
      return {
        success: false,
        error: `Bundle too large: ${sizeMB}MB (max: ${maxMB}MB)`,
        buildLog: result.buildLog,
      };
    }

    if (html.length > BUNDLE_SIZE_LIMITS.MAX_HTML_BYTES) {
      const sizeMB = (html.length / 1024 / 1024).toFixed(2);
      const maxMB = (BUNDLE_SIZE_LIMITS.MAX_HTML_BYTES / 1024 / 1024).toFixed(0);
      return {
        success: false,
        error: `HTML too large: ${sizeMB}MB (max: ${maxMB}MB)`,
        buildLog: result.buildLog,
      };
    }

    if (css && css.length > BUNDLE_SIZE_LIMITS.MAX_CSS_BYTES) {
      const sizeMB = (css.length / 1024 / 1024).toFixed(2);
      const maxMB = (BUNDLE_SIZE_LIMITS.MAX_CSS_BYTES / 1024 / 1024).toFixed(0);
      return {
        success: false,
        error: `CSS too large: ${sizeMB}MB (max: ${maxMB}MB)`,
        buildLog: result.buildLog,
      };
    }

    return {
      success: true,
      bundle,
      html,
      css,
      assets,
      manifest: result.manifest,
      buildLog: result.buildLog,
    };
  }
}
