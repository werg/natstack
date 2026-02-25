import { GitClient, type FsPromisesLike } from "./client.js";
import type { RepoArgSpec, NormalizedRepoArg, GitClientOptions } from "./types.js";

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
  /** Git ref (branch, tag, or commit SHA) for the source repo */
  gitRef?: string;
  /** Resolved repo args (name -> spec) provided by parent at createChild time */
  repoArgs?: Record<string, RepoArgSpec>;
  /** Path for panel source (default: "/src") */
  sourcePath?: string;
  /** Path for repo args (default: "/args") */
  argsPath?: string;
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
  /** Path to panel source */
  sourcePath: string;
  /** Current commit SHA of panel source (for cache key generation) */
  sourceCommit?: string;
  /** Map of repo arg name -> path */
  argPaths: Record<string, string>;
  /** Map of repo arg name -> commit SHA (for cache key generation) */
  argCommits: Record<string, string>;
  /** Actions taken (cloned, pulled, unchanged) */
  actions: {
    source: "cloned" | "pulled" | "unchanged" | "error";
    args: Record<string, "cloned" | "updated" | "unchanged" | "error">;
  };
  /** Error message if failed */
  error?: string;
}

/**
 * Parse shorthand repo arg format into normalized form.
 *
 * Examples:
 *   "panels/shared" -> { repo: "panels/shared" }
 *   "panels/shared#develop" -> { repo: "panels/shared", ref: "develop" }
 *   "panels/shared@v1.0.0" -> { repo: "panels/shared", ref: "v1.0.0" }
 *   "panels/shared@abc123" -> { repo: "panels/shared", ref: "abc123" }
 */
function parseRepoArgShorthand(shorthand: string): { repo: string; ref?: string } {
  // Check for branch reference (#)
  const branchMatch = shorthand.match(/^(.+)#(.+)$/);
  if (branchMatch && branchMatch[1] && branchMatch[2]) {
    return { repo: branchMatch[1], ref: branchMatch[2] };
  }

  // Check for tag/commit reference (@)
  const refMatch = shorthand.match(/^(.+)@(.+)$/);
  if (refMatch && refMatch[1] && refMatch[2]) {
    return { repo: refMatch[1], ref: refMatch[2] };
  }

  return { repo: shorthand };
}

function isCommitHash(ref?: string): boolean {
  return !!ref && /^[0-9a-f]{7,40}$/i.test(ref);
}

/**
 * Normalize a RepoArgSpec into a consistent object form
 */
function normalizeRepoArg(
  name: string,
  spec: RepoArgSpec,
  git: GitClient,
  argsPath: string
): NormalizedRepoArg {
  const parsed = typeof spec === "string" ? parseRepoArgShorthand(spec) : spec;

  return {
    name,
    repo: parsed.repo,
    ref: parsed.ref,
    resolvedUrl: git.resolveUrl(parsed.repo),
    localPath: `${argsPath}/${name}`,
  };
}

/**
 * Try to clone with main, falling back to master if main fails.
 * Returns the branch that succeeded.
 */
async function cloneWithDefaultBranch(
  git: GitClient,
  url: string,
  dir: string,
  depth: number = 1
): Promise<string> {
  // Try "main" first (modern default)
  try {
    await git.clone({ url, dir, ref: "main", depth });
    return "main";
  } catch (mainError) {
    // If main fails, try master (legacy default)
    try {
      await git.clone({ url, dir, ref: "master", depth });
      return "master";
    } catch {
      // Both failed - rethrow the original error with helpful message
      const message = mainError instanceof Error ? mainError.message : String(mainError);
      throw new Error(
        `Failed to clone with default branch. Tried "main" and "master". ` +
          `Original error: ${message}. ` +
          `Specify an explicit ref in your repoArgs to resolve.`
      );
    }
  }
}

/**
 * Bootstrap a panel by cloning/pulling its source and repo args.
 *
 * Usage:
 * ```typescript
 * import { bootstrap } from "@natstack/git";
 * import { fs } from "@workspace/runtime";
 *
 * const config = await window.__natstackPanelBridge.git.getConfig();
 * const result = await bootstrap(fs, config);
 *
 * if (result.success) {
 *   // Panel source is now at result.sourcePath
 *   // Repo args are at result.argPaths
 * }
 * ```
 */
export async function bootstrap(
  fs: FsPromisesLike,
  config: BootstrapConfig
): Promise<BootstrapResult> {
  const sourcePath = config.sourcePath ?? "/src";
  const argsPath = config.argsPath ?? "/args";

  const result: BootstrapResult = {
    success: false,
    sourcePath,
    argPaths: {},
    argCommits: {},
    actions: {
      source: "error",
      args: {},
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
    const requestedSourceRef = config.gitRef;
    const isPinnedCommit = isCommitHash(requestedSourceRef);

    // Step 1: Clone or pull panel source
    const sourceExists = await git.isRepo(sourcePath);

    if (!sourceExists) {
      if (requestedSourceRef) {
        await git.clone({
          url: config.sourceRepo,
          dir: sourcePath,
          ref: requestedSourceRef,
          depth: isPinnedCommit ? undefined : 1,
        });
      } else {
        await cloneWithDefaultBranch(git, config.sourceRepo, sourcePath);
      }
      result.actions.source = "cloned";
    } else {
      const beforeStatus = await git.status(sourcePath);
      const beforeCommit = beforeStatus.commit;
      const checkoutRef = requestedSourceRef ?? beforeStatus.branch ?? undefined;

      if (checkoutRef) {
        await git.fetch({ dir: sourcePath, ref: checkoutRef });
        await git.checkout(sourcePath, checkoutRef);

        if (!isPinnedCommit) {
          const afterStatus = await git.status(sourcePath);
          if (afterStatus.branch) {
            await git.pull({ dir: sourcePath, ref: afterStatus.branch });
          }
        }
      } else {
        // No ref information; fall back to fetching and pulling current branch if available
        await git.fetch({ dir: sourcePath });
        if (beforeStatus.branch) {
          await git.pull({ dir: sourcePath, ref: beforeStatus.branch });
        }
      }

      const newCommit = await git.getCurrentCommit(sourcePath);
      result.actions.source =
        newCommit && beforeCommit !== newCommit ? "pulled" : "unchanged";
    }

    // Get current commit SHA for cache key generation
    const sourceCommit = await git.getCurrentCommit(sourcePath);
    if (sourceCommit) {
      result.sourceCommit = sourceCommit;
    }

    // Step 2: Clone or update repo args (collect all errors)
    const argErrors: string[] = [];

    if (config.repoArgs && Object.keys(config.repoArgs).length > 0) {
      for (const [name, spec] of Object.entries(config.repoArgs)) {
        const arg = normalizeRepoArg(name, spec, git, argsPath);
        result.argPaths[name] = arg.localPath;
        const argPinnedCommit = isCommitHash(arg.ref);

        try {
          const argExists = await git.isRepo(arg.localPath);

          if (argExists) {
            const beforeCommit = await git.getCurrentCommit(arg.localPath);
            // Validate that the remote matches what was provided
            const remotes = await git.listRemotes(arg.localPath);
            const origin = remotes.find((r) => r.remote === "origin");

            if (origin && origin.url !== arg.resolvedUrl) {
              throw new Error(
                `Remote mismatch: expected ${arg.resolvedUrl}, found ${origin.url}. ` +
                  `Clear context folder to resolve.`
              );
            }

            // Fetch latest and checkout the ref
            await git.fetch({ dir: arg.localPath, ref: arg.ref });
            if (arg.ref) {
              await git.checkout(arg.localPath, arg.ref);
            }

            if (!argPinnedCommit) {
              const status = await git.status(arg.localPath);
              if (status.branch) {
                await git.pull({ dir: arg.localPath, ref: status.branch });
              }
            }

            const currentCommit = await git.getCurrentCommit(arg.localPath);
            result.argCommits[name] = currentCommit ?? "";
            result.actions.args[name] =
              beforeCommit && currentCommit && beforeCommit === currentCommit
                ? "unchanged"
                : "updated";
          } else {
            // Clone the repository
            if (arg.ref) {
              // Explicit ref provided - use it directly
              await git.clone({
                url: arg.resolvedUrl,
                dir: arg.localPath,
                ref: arg.ref,
                depth: argPinnedCommit ? undefined : 1,
              });
            } else {
              // No ref - try main, then master
              await cloneWithDefaultBranch(git, arg.resolvedUrl, arg.localPath);
            }

            const commit = await git.getCurrentCommit(arg.localPath);
            result.argCommits[name] = commit ?? "";
            result.actions.args[name] = "cloned";
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.actions.args[name] = "error";
          argErrors.push(`${name}: ${message}`);
        }
      }
    }

    // If any repo args failed, report all errors together
    if (argErrors.length > 0) {
      throw new Error(
        `Failed to sync ${argErrors.length} repoArg(s):\n  - ${argErrors.join("\n  - ")}`
      );
    }

    result.success = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

// Re-export types for consumers
export type { RepoArgSpec, NormalizedRepoArg } from "./types.js";
