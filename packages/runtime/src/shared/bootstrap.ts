/**
 * Shared Bootstrap Module
 *
 * Provides bootstrap functionality for both panels and workers.
 * Clones repoArgs repositories before user code runs.
 */

import { bootstrap, type BootstrapResult } from "@natstack/git";
import type { RuntimeFs } from "../types.js";
import type { GitConfig } from "../core/index.js";

export type { BootstrapResult };

export interface BootstrapState {
  result: BootstrapResult | null;
  error: string | null;
  promise: Promise<BootstrapResult | null> | null;
}

/**
 * Create a fresh bootstrap state container.
 */
export function createBootstrapState(): BootstrapState {
  return {
    result: null,
    error: null,
    promise: null,
  };
}

export interface RunBootstrapOptions {
  /** Filesystem implementation (panel's ZenFS or worker's RPC-based fs) */
  fs: RuntimeFs;
  /** Git configuration with server URL, token, and repoArgs */
  gitConfig: GitConfig | null;
  /** State container to store results */
  state: BootstrapState;
  /** Optional: Promise that resolves when fs is ready (for panel's async ZenFS init) */
  fsReady?: Promise<void>;
  /** Log prefix for console messages */
  logPrefix?: string;
}

/**
 * Run bootstrap to clone repoArgs repositories.
 *
 * This function is idempotent - calling it multiple times returns the same promise.
 * The promise is stored in the state container for later access.
 *
 * @returns Promise that resolves to BootstrapResult or null if no bootstrap needed
 */
export function runBootstrap(options: RunBootstrapOptions): Promise<BootstrapResult | null> {
  const { fs, gitConfig, state, fsReady, logPrefix = "[Bootstrap]" } = options;

  // Return cached result if already completed
  if (state.result) {
    return Promise.resolve(state.result);
  }
  if (state.error) {
    return Promise.reject(new Error(state.error));
  }

  // Return existing promise if already running
  if (state.promise) {
    return state.promise;
  }

  // Start bootstrap
  state.promise = (async () => {
    try {
      // Wait for filesystem to be ready (if provided)
      if (fsReady) {
        await fsReady;
      }

      if (!gitConfig) {
        console.warn(`${logPrefix} Git config not available, skipping bootstrap`);
        return null;
      }

      // Check if there are any repoArgs to bootstrap
      const hasRepoArgs =
        gitConfig.resolvedRepoArgs && Object.keys(gitConfig.resolvedRepoArgs).length > 0;

      if (!hasRepoArgs) {
        console.log(`${logPrefix} No repoArgs configured, skipping bootstrap`);
        // Return a minimal result so code can check bootstrap completed
        const result: BootstrapResult = {
          success: true,
          sourcePath: "/src",
          sourceCommit: undefined,
          argPaths: {},
          argCommits: {},
          actions: {
            source: "unchanged",
            args: {},
          },
        };
        state.result = result;
        return result;
      }

      console.log(`${logPrefix} Running bootstrap for repos...`);

      // Run bootstrap - RuntimeFs is compatible with FsPromisesLike
      const result = await bootstrap(fs, {
        serverUrl: gitConfig.serverUrl,
        token: gitConfig.token,
        sourceRepo: gitConfig.sourceRepo,
        branch: gitConfig.branch,
        commit: gitConfig.commit,
        tag: gitConfig.tag,
        repoArgs: gitConfig.resolvedRepoArgs as Record<string, string>,
      });

      if (!result.success) {
        throw new Error(`Bootstrap failed: ${result.error}`);
      }

      console.log(`${logPrefix} Complete:`, result.actions);
      state.result = result;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${logPrefix} Failed:`, message);
      state.error = message;
      throw error;
    }
  })();

  return state.promise;
}

/**
 * Get the bootstrap result from a state container.
 * Returns null if bootstrap hasn't completed or failed.
 */
export function getBootstrapResult(state: BootstrapState): BootstrapResult | null {
  return state.result;
}

/**
 * Check if bootstrap has completed successfully.
 */
export function isBootstrapped(state: BootstrapState): boolean {
  return state.result !== null && state.result.success === true;
}

/**
 * Get the bootstrap promise from a state container.
 * Returns a resolved promise with null if bootstrap hasn't been started.
 */
export function getBootstrapPromise(state: BootstrapState): Promise<BootstrapResult | null> {
  return state.promise ?? Promise.resolve(null);
}
