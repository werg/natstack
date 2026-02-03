/**
 * Agent Build Strategy
 *
 * Implements BuildStrategy for agent builds with Node.js-specific configuration:
 * - Platform: node
 * - Target: node20
 * - Format: esm (.mjs)
 * - No code splitting
 * - No fs/path shims (full Node.js access)
 * - Native addon externalization
 */

import type * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";

import type {
  BuildStrategy,
  BuildContext,
  AgentBuildOptions,
  PlatformConfig,
  AgentArtifacts,
} from "../types.js";

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

// ===========================================================================
// Constants
// ===========================================================================

/**
 * Default dependencies for all agents.
 */
const defaultAgentDependencies: Record<string, string> = {
  "@natstack/agent-runtime": "workspace:*",
  "@natstack/agent-patterns": "workspace:*",
  "@natstack/agentic-messaging": "workspace:*",
  "@natstack/ai": "workspace:*",
  "@natstack/core": "workspace:*",
  "@natstack/rpc": "workspace:*",
};

/**
 * Known optional native dependencies that should always be externalized.
 */
const KNOWN_OPTIONAL_NATIVE_DEPS = [
  "fsevents", // macOS file watching
  "bufferutil", // WebSocket optional
  "utf-8-validate", // WebSocket optional
  "node-pty", // Terminal emulation
  "cpu-features", // ssh2 optional
  "@parcel/watcher", // File watching optional
];

// ===========================================================================
// Agent Build Strategy
// ===========================================================================

export class AgentBuildStrategy
  implements BuildStrategy<AgentManifest, AgentArtifacts, AgentBuildOptions>
{
  readonly kind = "agent" as const;

  getPlatformConfig(_options: AgentBuildOptions): PlatformConfig {
    return {
      platform: "node",
      target: "node20",
      format: "esm",
      conditions: undefined, // Use default Node.js resolution
      splitting: false,
    };
  }

  getDefaultDependencies(): Record<string, string> {
    return { ...defaultAgentDependencies };
  }

  mergeDependencies(manifestDeps?: Record<string, string>): Record<string, string> {
    return {
      ...defaultAgentDependencies,
      ...manifestDeps,
    };
  }

  validateManifest(
    packageJson: Record<string, unknown>,
    sourcePath: string
  ): AgentManifest {
    if (!packageJson["natstack"]) {
      throw new Error(`package.json must include a 'natstack' field for agents`);
    }

    const natstack = packageJson["natstack"] as {
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
    const pkgDeps = packageJson["dependencies"] as Record<string, string> | undefined;
    const manifest: AgentManifest = {
      type: "agent",
      title: natstack.title,
      entry: natstack.entry,
      dependencies: {
        ...natstack.dependencies,
        ...pkgDeps,
      },
    };

    return manifest;
  }

  getPlugins(
    _ctx: BuildContext<AgentManifest>,
    _options: AgentBuildOptions
  ): esbuild.Plugin[] {
    // Agents don't need any special plugins
    return [];
  }

  getExternals(
    _ctx: BuildContext<AgentManifest>,
    _options: AgentBuildOptions
  ): string[] {
    const externals = new Set<string>();

    // Pattern-based: all native addon files
    externals.add("*.node");

    // Known optional native deps that have proper fallbacks
    for (const dep of KNOWN_OPTIONAL_NATIVE_DEPS) {
      externals.add(dep);
    }

    return Array.from(externals);
  }

  getBannerJs(
    _ctx: BuildContext<AgentManifest>,
    _options: AgentBuildOptions
  ): string {
    // Agents don't need special banners - they run in Node.js
    return "";
  }

  getAdditionalEsbuildOptions(
    _ctx: BuildContext<AgentManifest>,
    _options: AgentBuildOptions
  ): Partial<esbuild.BuildOptions> {
    // No additional options needed for agents
    return {};
  }

  async processResult(
    ctx: BuildContext<AgentManifest>,
    esbuildResult: esbuild.BuildResult,
    options: AgentBuildOptions
  ): Promise<AgentArtifacts> {
    const { workspace, log } = ctx;

    const bundlePath = path.join(workspace.buildDir, "bundle.mjs");

    // Log bundle size
    const bundleStats = fs.statSync(bundlePath);
    const bundleSizeMB = (bundleStats.size / 1024 / 1024).toFixed(2);
    log(`Bundle size: ${bundleSizeMB}MB`);

    // Warn for large bundles
    if (bundleStats.size > 10 * 1024 * 1024) {
      log(`Warning: Bundle size exceeds 10MB. Consider reviewing dependencies.`);
      if (esbuildResult.metafile) {
        this.logLargestInputs(esbuildResult.metafile, log);
      }
    }

    return {
      bundlePath,
      nodeModulesDir: workspace.nodeModulesDir,
      // Will be updated by orchestrator after promotion to stable
      stableDir: workspace.buildDir,
    };
  }

  supportsShims(_options: AgentBuildOptions): boolean {
    // Agents have full Node.js fs access, no shims needed
    return false;
  }

  computeOptionsSuffix(options: AgentBuildOptions): string {
    const parts: string[] = [];

    if (options.sourcemap === false) {
      parts.push("nosm");
    }

    return parts.length > 0 ? `:${parts.join(":")}` : "";
  }

  // ===========================================================================
  // Private Helper Methods
  // ===========================================================================

  private logLargestInputs(
    metafile: esbuild.Metafile,
    log: (message: string) => void
  ): void {
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
