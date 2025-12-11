/**
 * Panel Bootstrap
 *
 * Automatically bootstraps the panel's git repos (source + repoArgs)
 * before the panel's entry point runs.
 */

import { bootstrap, type BootstrapResult } from "@natstack/git";
import { ready as fsReady, promises as fs } from "./fs.js";

// Global storage for bootstrap result
declare global {
  interface Window {
    __natstackBootstrapResult?: BootstrapResult;
    __natstackBootstrapError?: string;
    __natstackBootstrapPromise?: Promise<BootstrapResult | null>;
  }
}

/**
 * Run bootstrap for this panel. Called automatically by panel wrapper.
 * Returns the bootstrap result or null if no repoArgs are configured.
 */
export async function runPanelBootstrap(): Promise<BootstrapResult | null> {
  // Return cached result if already run
  if (window.__natstackBootstrapResult) {
    return window.__natstackBootstrapResult;
  }
  if (window.__natstackBootstrapError) {
    throw new Error(window.__natstackBootstrapError);
  }

  // If already running, wait for it
  if (window.__natstackBootstrapPromise) {
    return window.__natstackBootstrapPromise;
  }

  // Start bootstrap
  window.__natstackBootstrapPromise = (async () => {
    try {
      // Wait for filesystem to be ready
      await fsReady;

      // Get git config from panel bridge
      const bridge = window.__natstackPanelBridge;
      if (!bridge) {
        console.warn("[Bootstrap] Panel bridge not available, skipping bootstrap");
        return null;
      }

      const gitConfig = await bridge.git.getConfig();

      // Check if there are any repoArgs to bootstrap
      const hasRepoArgs =
        gitConfig.resolvedRepoArgs && Object.keys(gitConfig.resolvedRepoArgs).length > 0;

      if (!hasRepoArgs) {
        console.log("[Bootstrap] No repoArgs configured, skipping bootstrap");
        // Still return a minimal result so panels can check
        // sourceCommit is undefined since we didn't actually clone/check the source
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
        window.__natstackBootstrapResult = result;
        return result;
      }

      console.log("[Bootstrap] Running bootstrap for panel repos...");

      // Run bootstrap
      const result = await bootstrap(fs as Parameters<typeof bootstrap>[0], {
        serverUrl: gitConfig.serverUrl,
        token: gitConfig.token,
        sourceRepo: gitConfig.sourceRepo,
        branch: gitConfig.branch,
        commit: gitConfig.commit,
        tag: gitConfig.tag,
        repoArgs: gitConfig.resolvedRepoArgs,
      });

      if (!result.success) {
        throw new Error(`Bootstrap failed: ${result.error}`);
      }

      console.log("[Bootstrap] Complete:", result.actions);
      window.__natstackBootstrapResult = result;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Bootstrap] Failed:", message);
      window.__natstackBootstrapError = message;
      throw error;
    }
  })();

  return window.__natstackBootstrapPromise;
}

/**
 * Get the cached bootstrap result. Returns null if bootstrap hasn't run or failed.
 */
export function getBootstrapResult(): BootstrapResult | null {
  return window.__natstackBootstrapResult ?? null;
}

/**
 * Check if bootstrap has completed successfully.
 */
export function isBootstrapped(): boolean {
  return !!window.__natstackBootstrapResult?.success;
}
