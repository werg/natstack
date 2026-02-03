/**
 * Agent Builder for utilityProcess agents.
 *
 * Thin facade over BuildOrchestrator with agent-specific pre-checks:
 * - Agent discovery validation
 * - Git dirty state detection
 *
 * Agents are Node.js processes that run in Electron's utilityProcess.
 * They use the same build infrastructure as panels/workers but with
 * Node.js-specific configuration (see AgentBuildStrategy).
 */

import * as fs from "fs";
import * as path from "path";
import * as git from "isomorphic-git";

import { getBuildOrchestrator } from "./build/orchestrator.js";
import { AgentBuildStrategy, type AgentManifest } from "./build/strategies/agentStrategy.js";
import type { AgentBuildOptions as StrategyOptions, BuildOutput, AgentArtifacts, OnBuildProgress } from "./build/types.js";
import type { TypeCheckDiagnostic } from "./build/sharedBuild.js";
import { createDevLogger } from "./devLog.js";
import { getAgentDiscovery } from "./agentDiscovery.js";

const devLog = createDevLogger("AgentBuilder");

// ===========================================================================
// Types
// ===========================================================================

// Re-export AgentManifest from strategy
export type { AgentManifest };

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
  version?: { gitRef?: string };
  /** Progress callback */
  onProgress?: (progress: AgentBuildProgress) => void;
  /** Whether to emit inline sourcemaps (default: true) */
  sourcemap?: boolean;
}

/**
 * Dirty repository state information.
 */
export interface DirtyRepoState {
  modified: string[];
  untracked: string[];
  staged: string[];
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
  /** Git dirty state if repo has uncommitted changes (null if clean) */
  dirtyRepo?: DirtyRepoState;
}

// ===========================================================================
// Git Dirty State Detection
// ===========================================================================

/**
 * Check if the agent directory has uncommitted changes.
 * Returns null if the directory is clean, otherwise returns the dirty state.
 */
async function checkDirtyRepo(agentPath: string): Promise<DirtyRepoState | null> {
  try {
    const gitRoot = await git.findRoot({ fs, filepath: agentPath });
    const statusMatrix = await git.statusMatrix({ fs, dir: gitRoot });

    const modified: string[] = [];
    const untracked: string[] = [];
    const staged: string[] = [];

    const relativePath = path.relative(gitRoot, agentPath);
    const prefix = relativePath ? relativePath + "/" : "";

    for (const [filepath, headStatus, workdirStatus, stageStatus] of statusMatrix) {
      if (prefix && !filepath.startsWith(prefix)) {
        continue;
      }

      // Modified but not staged
      if (headStatus === 1 && workdirStatus === 2 && stageStatus === 1) {
        modified.push(filepath);
      }
      // Deleted but not staged
      else if (headStatus === 1 && workdirStatus === 0 && stageStatus === 1) {
        modified.push(filepath);
      }
      // Untracked
      else if (headStatus === 0 && workdirStatus === 2 && stageStatus === 0) {
        untracked.push(filepath);
      }
      // Staged - new file
      else if (headStatus === 0 && stageStatus === 2) {
        staged.push(filepath);
      }
      // Staged - modified
      else if (headStatus === 1 && stageStatus === 2) {
        staged.push(filepath);
      }
      // Staged - deleted
      else if (headStatus === 1 && stageStatus === 0 && workdirStatus === 0) {
        staged.push(filepath);
      }
    }

    const isDirty = modified.length > 0 || untracked.length > 0 || staged.length > 0;
    return isDirty ? { modified, untracked, staged } : null;
  } catch (err) {
    devLog.verbose(`[checkDirtyRepo] Could not check git status: ${err}`);
    return null;
  }
}

// ===========================================================================
// Agent Builder
// ===========================================================================

export class AgentBuilder {
  private strategy = new AgentBuildStrategy();

  /**
   * Build an agent from source.
   *
   * Uses git-based cache invalidation (same as panels/workers):
   * - Commit SHA in cache key
   * - Dirty worktrees are rejected
   */
  async build(options: AgentBuildOptions): Promise<AgentBuildResult> {
    const { workspaceRoot, agentName, version, onProgress, sourcemap = true } = options;
    const agentPath = `agents/${agentName}`;
    const canonicalAgentPath = path.resolve(workspaceRoot, agentPath);

    let buildLog = "";
    const log = (message: string) => {
      buildLog += message + "\n";
      devLog.verbose(message);
    };

    // Pre-check: Verify agent exists in discovery
    const discovery = getAgentDiscovery();
    if (!discovery) {
      return { success: false, error: "Agent discovery not initialized", buildLog };
    }
    const agent = discovery.get(agentName);
    if (!agent) {
      return { success: false, error: `Agent not found: ${agentName}`, buildLog };
    }
    if (!agent.valid) {
      return { success: false, error: `Agent manifest invalid: ${agent.error}`, buildLog };
    }

    // Check for uncommitted changes (for reporting purposes, doesn't block build)
    let dirtyRepo: DirtyRepoState | null = null;
    try {
      dirtyRepo = await checkDirtyRepo(canonicalAgentPath);
      if (dirtyRepo) {
        const totalChanges =
          dirtyRepo.modified.length + dirtyRepo.untracked.length + dirtyRepo.staged.length;
        log(`Warning: Agent has ${totalChanges} uncommitted change(s)`);
      }
    } catch {
      // Ignore dirty check errors
    }

    // Convert to orchestrator options
    const orchestratorOptions: StrategyOptions = {
      workspaceRoot,
      sourcePath: agentPath,
      gitRef: version?.gitRef,
      sourcemap,
    };

    // Wrap progress callback
    const orchestratorProgress: OnBuildProgress | undefined = onProgress
      ? (progress) => {
          onProgress({
            state: progress.state as AgentBuildProgress["state"],
            message: progress.message,
            log: progress.log,
          });
        }
      : undefined;

    // Delegate to orchestrator
    const orchestrator = getBuildOrchestrator();
    const result = await orchestrator.build(this.strategy, orchestratorOptions, orchestratorProgress);

    // Convert result to AgentBuildResult
    if (result.success) {
      const successResult = result as BuildOutput<AgentManifest, AgentArtifacts> & { success: true };
      return {
        success: true,
        bundlePath: successResult.artifacts.bundlePath,
        manifest: successResult.manifest,
        nodeModulesDir: successResult.artifacts.nodeModulesDir,
        buildLog: successResult.buildLog ?? buildLog,
        dirtyRepo: dirtyRepo ?? undefined,
      };
    } else {
      return {
        success: false,
        error: result.error,
        buildLog: result.buildLog ?? buildLog,
        typeErrors: result.typeErrors,
        dirtyRepo: dirtyRepo ?? undefined,
      };
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
