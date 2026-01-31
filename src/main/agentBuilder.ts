/**
 * Agent Builder for utilityProcess agents.
 *
 * Agents are Node.js processes that run in Electron's utilityProcess.
 * They use the same build infrastructure as panels/workers but with
 * Node.js-specific configuration:
 * - platform: "node" (no browser shims)
 * - target: "node20" (matches Electron's bundled Node.js)
 * - format: "esm" (.mjs output for Node.js ESM loader)
 * - No fs/path shims (full Node.js API access)
 * - Native addon externalization
 */

import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";

import { createBuildWorkspace, type BuildArtifactKey } from "./build/artifacts.js";
import {
  provisionSource,
  resolveTargetCommit,
  installDependencies,
  getNodeResolutionPaths,
  getVerdaccioVersionsHash,
  writeBuildTsconfig,
  runTypeCheck,
  resolveEntryPoint,
  loadPackageJson,
  getDependencyHashFromCache,
  saveDependencyHashToCache,
  type VersionSpec,
  type ProvisionProgress,
  type TypeCheckDiagnostic,
} from "./build/sharedBuild.js";
import { getMainCacheManager } from "./cacheManager.js";
import { isDev } from "./utils.js";
import { getActiveWorkspace, getAppNodeModules } from "./paths.js";
import { createDevLogger } from "./devLog.js";
import { getAgentDiscovery } from "./agentDiscovery.js";

const devLog = createDevLogger("AgentBuilder");

// ===========================================================================
// Types
// ===========================================================================

/**
 * Agent manifest from package.json natstack field.
 */
export interface AgentManifest {
  /** Type must be "agent" */
  type: "agent";
  /** Agent title for display */
  title: string;
  /** Optional explicit entry point */
  entry?: string;
  /** Dependencies to install */
  dependencies?: Record<string, string>;
}

/**
 * Build progress callback.
 */
export interface AgentBuildProgress {
  state: "provisioning" | "installing" | "building" | "type-checking" | "ready" | "error";
  message: string;
  log?: string;
}

/**
 * Options for building an agent.
 */
export interface AgentBuildOptions {
  /** Absolute path to the workspace root containing agents/ */
  workspaceRoot: string;
  /** Name of the agent (directory name under agents/) */
  agentName: string;
  /** Optional version specifier (branch, commit, or tag) */
  version?: VersionSpec;
  /** Progress callback */
  onProgress?: (progress: AgentBuildProgress) => void;
  /** Whether to emit inline sourcemaps (default: true) */
  sourcemap?: boolean;
}

/**
 * Result of building an agent.
 */
export interface AgentBuildResult {
  success: boolean;
  /** Path to the built bundle (.mjs file) */
  bundlePath?: string;
  /** Agent manifest */
  manifest?: AgentManifest;
  /** Path to node_modules for native addon resolution */
  nodeModulesDir?: string;
  /** Error message if build failed */
  error?: string;
  /** Full build log */
  buildLog?: string;
  /** TypeScript type errors found during build */
  typeErrors?: TypeCheckDiagnostic[];
}

// ===========================================================================
// Default Dependencies
// ===========================================================================

/**
 * Default dependencies for all agents.
 * Note: @types/node is NOT included - type checking service handles it.
 */
const defaultAgentDependencies: Record<string, string> = {
  "@natstack/agent-runtime": "workspace:*",
  "@natstack/agentic-messaging": "workspace:*",
  "@natstack/ai": "workspace:*",
  "@natstack/core": "workspace:*",
  "@natstack/rpc": "workspace:*",
};

/**
 * Known optional native dependencies that should always be externalized.
 * These may not be declared in package.json but break builds if bundled.
 */
const KNOWN_OPTIONAL_NATIVE_DEPS = [
  "fsevents",         // macOS file watching
  "bufferutil",       // WebSocket optional
  "utf-8-validate",   // WebSocket optional
  "node-pty",         // Terminal emulation
  "cpu-features",     // ssh2 optional
  "@parcel/watcher",  // File watching optional
];

// ===========================================================================
// Agent Builder
// ===========================================================================

export class AgentBuilder {
  private cacheManager = getMainCacheManager();

  /** Per-agent build locks for coalescing concurrent builds */
  private buildLocks = new Map<string, Promise<AgentBuildResult>>();

  /**
   * Build an agent from source.
   *
   * Uses git-based cache invalidation (same as panels/workers):
   * - Commit SHA in cache key
   * - Dirty worktrees are rejected
   */
  async build(options: AgentBuildOptions): Promise<AgentBuildResult> {
    const { workspaceRoot, agentName, version, onProgress, sourcemap = true } = options;

    // Build coalescing: if already building this agent, return the existing promise
    const lockKey = `${workspaceRoot}:${agentName}:${JSON.stringify(version ?? {})}`;
    const existingBuild = this.buildLocks.get(lockKey);
    if (existingBuild) {
      devLog.verbose(`Build already in progress for ${agentName}, coalescing`);
      return existingBuild;
    }

    const buildPromise = this.doBuild(workspaceRoot, agentName, version, onProgress, sourcemap);
    this.buildLocks.set(lockKey, buildPromise);

    try {
      return await buildPromise;
    } finally {
      this.buildLocks.delete(lockKey);
    }
  }

  private async doBuild(
    workspaceRoot: string,
    agentName: string,
    version: VersionSpec | undefined,
    onProgress: ((progress: AgentBuildProgress) => void) | undefined,
    sourcemap: boolean
  ): Promise<AgentBuildResult> {
    let cleanup: (() => Promise<void>) | null = null;
    let buildLog = "";
    const agentPath = `agents/${agentName}`;
    const canonicalAgentPath = path.resolve(workspaceRoot, agentPath);

    const log = (message: string) => {
      buildLog += message + "\n";
      devLog.verbose(message);
    };

    // Verify agent exists in discovery
    const discovery = getAgentDiscovery();
    if (!discovery) {
      return { success: false, error: "Agent discovery not initialized", buildLog };
    }
    const agent = discovery.get(agentName); // agentName = directory name = manifest.id
    if (!agent) {
      return { success: false, error: `Agent not found: ${agentName}`, buildLog };
    }
    if (!agent.valid) {
      return { success: false, error: `Agent manifest invalid: ${agent.error}`, buildLog };
    }

    try {
      // Step 1: Get verdaccio versions hash for cache key
      const versionsHash = await getVerdaccioVersionsHash();

      // Step 2: Early cache check (fast - no git checkout needed)
      onProgress?.({ state: "provisioning", message: "Checking cache...", log: buildLog });

      const earlyCommit = await resolveTargetCommit(workspaceRoot, agentPath, version);

      if (earlyCommit) {
        const cacheKey = `agent:${canonicalAgentPath}:${earlyCommit}:${versionsHash}:sm${sourcemap ? 1 : 0}`;
        const cached = this.cacheManager.get(cacheKey, isDev());

        if (cached) {
          log(`Cache hit for ${cacheKey}`);
          onProgress?.({ state: "ready", message: "Loaded from cache", log: buildLog });

          try {
            return JSON.parse(cached) as AgentBuildResult;
          } catch {
            log(`Cache parse failed, will rebuild`);
          }
        }
      }

      // Step 3: Provision source at the right version
      onProgress?.({ state: "provisioning", message: "Provisioning source...", log: buildLog });
      log(`Provisioning ${agentPath}${version ? ` at ${JSON.stringify(version)}` : ""}`);

      const provision = await provisionSource({
        sourceRoot: workspaceRoot,
        sourcePath: agentPath,
        version,
        onProgress: (progress: ProvisionProgress) => {
          log(`Git: ${progress.message}`);
        },
      });

      cleanup = provision.cleanup;
      const sourcePath = provision.sourcePath;
      const sourceCommit = provision.commit;

      log(`Source provisioned at ${sourcePath} (commit: ${sourceCommit.slice(0, 8)})`);

      // Cache key for storing the result (includes sourcemap option)
      const cacheKey = `agent:${canonicalAgentPath}:${sourceCommit}:${versionsHash}:sm${sourcemap ? 1 : 0}`;

      // Step 4: Load and validate manifest
      log(`Loading manifest...`);
      const manifest = this.loadManifest(sourcePath);
      log(`Manifest loaded: ${manifest.title}`);

      // Step 5: Create build workspace
      const artifactKey: BuildArtifactKey = {
        kind: "agent",
        canonicalPath: canonicalAgentPath,
        commit: sourceCommit,
      };
      const workspace = createBuildWorkspace(artifactKey);

      // Step 6: Install dependencies
      onProgress?.({ state: "installing", message: "Installing dependencies...", log: buildLog });
      log(`Installing dependencies...`);

      const runtimeDependencies = this.mergeRuntimeDependencies(manifest.dependencies);
      const dependencyCacheKey = `deps:agent:${canonicalAgentPath}:${sourceCommit}`;
      const previousDependencyHash = getDependencyHashFromCache(dependencyCacheKey);

      const installResult = await installDependencies({
        depsDir: workspace.depsDir,
        dependencies: runtimeDependencies,
        previousHash: previousDependencyHash,
        canonicalPath: canonicalAgentPath,
        log,
        userWorkspacePath: workspaceRoot,
      });

      if (installResult) {
        await saveDependencyHashToCache(dependencyCacheKey, installResult.hash);
      }
      log(`Dependencies installed`);

      // Step 7: Resolve entry point
      const entry = resolveEntryPoint({
        sourcePath,
        manifestEntry: manifest.entry,
      });
      const entryPath = path.join(sourcePath, entry);
      log(`Entry point: ${entry}`);

      // Step 8: Get node module resolution paths
      const nodePaths = getNodeResolutionPaths(sourcePath, workspace.nodeModulesDir, getAppNodeModules());

      // Step 9: Write build tsconfig
      const tsconfigPath = writeBuildTsconfig(workspace.buildDir, sourcePath, "agent", {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        useDefineForClassFields: true,
      });

      // Step 10: Build with esbuild AND run type checking in parallel
      onProgress?.({ state: "building", message: "Building agent...", log: buildLog });
      log(`Building agent...`);

      // Start type checking (runs in parallel with bundling)
      const typeCheckPromise = runTypeCheck({
        sourcePath,
        nodeModulesDir: workspace.nodeModulesDir,
        fsShimEnabled: false, // Agents have full Node.js fs access
        log,
      });

      // Get externals for esbuild
      const externals = this.getExternals(sourcePath);
      log(`Externals: ${externals.join(", ")}`);

      // Bundle path uses .mjs extension to signal ESM to Node.js
      const bundlePath = path.join(workspace.buildDir, "bundle.mjs");

      // Run esbuild
      const buildResult = await esbuild.build({
        entryPoints: [entryPath],
        bundle: true,
        platform: "node",
        target: "node20",
        format: "esm",
        outfile: bundlePath,
        sourcemap: sourcemap ? "inline" : false,
        keepNames: true,
        metafile: true,
        nodePaths,
        external: externals,
        tsconfig: tsconfigPath,
        // No custom conditions - agents use default Node.js resolution
      });

      // Log bundle size
      const bundleStats = fs.statSync(bundlePath);
      const bundleSizeMB = (bundleStats.size / 1024 / 1024).toFixed(2);
      log(`Bundle size: ${bundleSizeMB}MB`);

      // Warn for large bundles
      if (bundleStats.size > 10 * 1024 * 1024) {
        log(`Warning: Bundle size exceeds 10MB. Consider reviewing dependencies.`);
        if (buildResult.metafile) {
          this.logLargestInputs(buildResult.metafile, log);
        }
      }

      // Wait for type checking to complete
      onProgress?.({ state: "type-checking", message: "Type checking...", log: buildLog });
      const typeErrors = await typeCheckPromise;

      // If there are type errors, fail the build
      if (typeErrors.length > 0) {
        const errorSummary = typeErrors
          .slice(0, 40)
          .map((e) => `${e.file}:${e.line}:${e.column}: ${e.message}`)
          .join("\n");
        const moreMsg = typeErrors.length > 40 ? `\n... and ${typeErrors.length - 40} more errors` : "";

        log(`Build failed with ${typeErrors.length} type error(s)`);

        if (cleanup) {
          await cleanup();
        }

        return {
          success: false,
          error: `TypeScript errors:\n${errorSummary}${moreMsg}`,
          typeErrors,
          buildLog,
        };
      }

      log(`Build complete`);

      // Step 11: Cache result and return
      const result: AgentBuildResult = {
        success: true,
        bundlePath,
        manifest,
        nodeModulesDir: workspace.nodeModulesDir,
        buildLog,
      };

      // Cache the result (excluding bundlePath which is local, we store it relative)
      const cacheableResult: AgentBuildResult = {
        ...result,
        bundlePath, // Keep absolute path for this session
      };
      await this.cacheManager.set(cacheKey, JSON.stringify(cacheableResult));
      log(`Cached build result`);

      // Cleanup temp directory if we used one
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
        try {
          await cleanup();
        } catch {
          // Ignore cleanup errors
        }
      }

      onProgress?.({ state: "error", message: errorMsg, log: buildLog });

      return {
        success: false,
        error: errorMsg,
        buildLog,
      };
    }
  }

  /**
   * Load and validate agent manifest from package.json.
   */
  private loadManifest(sourcePath: string): AgentManifest {
    const pkgJson = loadPackageJson(sourcePath);

    if (!pkgJson.natstack) {
      throw new Error(`package.json must include a 'natstack' field for agents`);
    }

    const natstack = pkgJson.natstack as {
      type?: string;
      title?: string;
      entry?: string;
      dependencies?: Record<string, string>;
    };

    if (natstack.type !== "agent") {
      throw new Error(`natstack.type must be "agent" (got "${natstack.type}")`);
    }

    if (!natstack.title) {
      throw new Error("natstack.title must be specified in package.json");
    }

    // Merge package.json dependencies with natstack.dependencies
    const manifest: AgentManifest = {
      type: "agent",
      title: natstack.title,
      entry: natstack.entry,
      dependencies: {
        ...natstack.dependencies,
        ...pkgJson.dependencies,
      },
    };

    return manifest;
  }

  /**
   * Merge agent dependencies with default dependencies.
   */
  private mergeRuntimeDependencies(
    agentDependencies: Record<string, string> | undefined
  ): Record<string, string> {
    return {
      ...defaultAgentDependencies,
      ...agentDependencies,
    };
  }

  /**
   * Get externals for esbuild.
   * Externalizes native addons and known optional native dependencies.
   *
   * NOTE: We do NOT externalize user's optionalDependencies because:
   * 1. If externalized, they must be installed to be available at runtime
   * 2. Native modules are already caught by the "*.node" pattern
   * 3. Non-native optional deps can be safely bundled
   *
   * The KNOWN_OPTIONAL_NATIVE_DEPS are safe to externalize because libraries
   * that use them have proper try/catch fallbacks (e.g., fsevents on non-macOS).
   */
  private getExternals(_sourcePath: string): string[] {
    const externals = new Set<string>();

    // Pattern-based: all native addon files
    externals.add("*.node");

    // Known optional native deps that have proper fallbacks in consuming libraries
    for (const dep of KNOWN_OPTIONAL_NATIVE_DEPS) {
      externals.add(dep);
    }

    return Array.from(externals);
  }

  /**
   * Log the largest inputs from the metafile for debugging large bundles.
   */
  private logLargestInputs(metafile: esbuild.Metafile, log: (message: string) => void): void {
    const inputs = Object.entries(metafile.inputs)
      .map(([name, data]) => ({ name, bytes: data.bytes }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 10);

    log(`Largest inputs:`);
    for (const input of inputs) {
      const sizeMB = (input.bytes / 1024 / 1024).toFixed(2);
      log(`  ${sizeMB}MB: ${input.name}`);
    }
  }
}

// ===========================================================================
// Singleton Instance
// ===========================================================================

let agentBuilderInstance: AgentBuilder | null = null;

/**
 * Get the AgentBuilder singleton instance.
 */
export function getAgentBuilder(): AgentBuilder {
  if (!agentBuilderInstance) {
    agentBuilderInstance = new AgentBuilder();
  }
  return agentBuilderInstance;
}
