import type { FsClient } from "isomorphic-git";
import { GitClient } from "./client.js";
import { DependencyResolver } from "./dependencies.js";
import type { GitDependency, GitClientOptions } from "./types.js";

/**
 * Configuration for panel bootstrap
 */
export interface BootstrapConfig {
  /** Git server URL */
  serverUrl: string;
  /** Auth token for git operations */
  token: string;
  /** Panel's source repo path (e.g., "panels/my-panel") */
  sourceRepo: string;
  /** Git dependencies to clone */
  gitDependencies?: Record<string, GitDependency | string>;
  /** Path in OPFS for panel source (default: "/src") */
  sourcePath?: string;
  /** Path in OPFS for dependencies (default: "/deps") */
  depsPath?: string;
  /** Author info for commits */
  author?: {
    name: string;
    email: string;
  };
}

/**
 * Result of bootstrap operation
 */
export interface BootstrapResult {
  /** Whether bootstrap succeeded */
  success: boolean;
  /** Path to panel source in OPFS */
  sourcePath: string;
  /** Map of dependency name -> path in OPFS */
  depPaths: Record<string, string>;
  /** Actions taken (cloned, pulled, unchanged) */
  actions: {
    source: "cloned" | "pulled" | "unchanged" | "error";
    deps: Record<string, "cloned" | "updated" | "unchanged" | "error">;
  };
  /** Error message if failed */
  error?: string;
}

/**
 * Bootstrap a panel by cloning/pulling its source and dependencies into OPFS.
 *
 * Usage:
 * ```typescript
 * import { bootstrap } from "@natstack/git";
 * import { fs } from "@zenfs/core";
 *
 * const config = await window.__natstackPanelBridge.git.getConfig();
 * const result = await bootstrap(fs, config);
 *
 * if (result.success) {
 *   // Panel source is now at result.sourcePath
 *   // Dependencies are at result.depPaths
 * }
 * ```
 */
export async function bootstrap(
  fs: FsClient,
  config: BootstrapConfig
): Promise<BootstrapResult> {
  const sourcePath = config.sourcePath ?? "/src";
  const depsPath = config.depsPath ?? "/deps";

  const result: BootstrapResult = {
    success: false,
    sourcePath,
    depPaths: {},
    actions: {
      source: "error",
      deps: {},
    },
  };

  const gitOptions: GitClientOptions = {
    serverUrl: config.serverUrl,
    token: config.token,
    author: config.author ?? {
      name: "NatStack Panel",
      email: "panel@natstack.local",
    },
  };

  const git = new GitClient(fs, gitOptions);

  try {
    // Step 1: Clone or pull panel source
    const sourceExists = await git.isRepo(sourcePath);

    if (!sourceExists) {
      // Clone the source repo
      await git.clone({
        url: config.sourceRepo,
        dir: sourcePath,
        ref: "main",
        depth: 1,
      });
      result.actions.source = "cloned";
    } else {
      // Pull latest changes
      try {
        await git.pull({
          dir: sourcePath,
          ref: "main",
        });
        result.actions.source = "pulled";
      } catch (pullError) {
        // Pull might fail if there are no changes or conflicts
        // Check if we're already up to date
        const status = await git.status(sourcePath);
        if (!status.dirty) {
          result.actions.source = "unchanged";
        } else {
          throw pullError;
        }
      }
    }

    // Step 2: Clone or update dependencies
    if (config.gitDependencies && Object.keys(config.gitDependencies).length > 0) {
      const resolver = new DependencyResolver(fs, gitOptions, depsPath);
      const depResults = await resolver.syncAll(config.gitDependencies);

      for (const [name, depResult] of depResults) {
        result.depPaths[name] = `${depsPath}/${name}`;
        if (depResult.action.startsWith("error")) {
          result.actions.deps[name] = "error";
        } else {
          result.actions.deps[name] = depResult.action as "cloned" | "updated" | "unchanged";
        }
      }
    }

    result.success = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

/**
 * Check if panel source exists in OPFS
 */
export async function hasSource(
  fs: FsClient,
  sourcePath: string = "/src"
): Promise<boolean> {
  try {
    const fsAny = fs as {
      promises?: { stat: (p: string) => Promise<unknown> };
    };
    if (fsAny.promises?.stat) {
      await fsAny.promises.stat(sourcePath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
