/**
 * Git version provisioning for panel builds.
 * Handles checking out specific branches, commits, or tags to temp directories.
 */

import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { getGitTempBuildsDirectory } from "./build/artifacts.js";

const execFileAsync = promisify(execFile);

export interface VersionSpec {
  /** Git ref (branch name, tag, or commit SHA) */
  gitRef?: string;
}

export interface ProvisionResult {
  /** Absolute path to the provisioned panel source */
  sourcePath: string;
  /** The resolved commit SHA */
  commit: string;
  /** Cleanup function to remove temp directory (only for versioned checkouts) */
  cleanup: (() => Promise<void>) | null;
}

export interface ProvisionProgress {
  stage: "resolving" | "checking-out" | "ready";
  message: string;
}

/**
 * Provision panel source code at a specific version.
 *
 * For panels without version specifiers, returns the workspace path directly.
 * For versioned panels, creates a temporary worktree or checkout.
 *
 * @param panelsRoot - Absolute path to the workspace root
 * @param panelPath - Relative path to the panel within workspace (e.g., "panels/child")
 * @param version - Optional version specifier (branch, commit, or tag)
 * @param onProgress - Optional progress callback
 */
export async function provisionPanelVersion(
  panelsRoot: string,
  panelPath: string,
  version?: VersionSpec,
  onProgress?: (progress: ProvisionProgress) => void
): Promise<ProvisionResult> {
  const absolutePanelPath = path.resolve(panelsRoot, panelPath);

  // Validate panel exists
  if (!fs.existsSync(absolutePanelPath)) {
    throw new Error(`Panel directory not found: ${absolutePanelPath}`);
  }

  // Require panels to be git repos (submodules are allowed via .git file)
  const gitDir = path.join(absolutePanelPath, ".git");
  if (!fs.existsSync(gitDir)) {
    throw new Error(`Panel must be a git repository (or submodule): ${absolutePanelPath}`);
  }

  // Ensure we only use committed state; reject dirty worktrees to avoid local edits
  await assertCleanWorktree(absolutePanelPath);

  // Get current commit for cache keying
  const currentCommit = await getGitCommit(absolutePanelPath);

  // No version specifier - use working directory as-is
  if (!version?.gitRef) {
    onProgress?.({ stage: "ready", message: "Using current working directory" });
    return {
      sourcePath: absolutePanelPath,
      commit: currentCommit,
      cleanup: null,
    };
  }

  // Resolve the target ref
  onProgress?.({ stage: "resolving", message: "Resolving version..." });

  const targetRef = version.gitRef;

  // Resolve to actual commit SHA
  const resolvedCommit = await resolveRef(absolutePanelPath, targetRef);

  // If resolved commit matches current HEAD, no need for temp checkout
  if (resolvedCommit === currentCommit) {
    onProgress?.({ stage: "ready", message: "Already at requested version" });
    return {
      sourcePath: absolutePanelPath,
      commit: resolvedCommit,
      cleanup: null,
    };
  }

  // Create temp directory for the versioned checkout
  onProgress?.({ stage: "checking-out", message: `Checking out ${targetRef}...` });

  const { tempDir, cleanup } = await createTempCheckout(absolutePanelPath, resolvedCommit);

  return {
    sourcePath: tempDir,
    commit: resolvedCommit,
    cleanup,
  };
}

/**
 * Get the current HEAD commit SHA for a git repo.
 */
async function getGitCommit(repoPath: string): Promise<string> {
  return runGit(["rev-parse", "HEAD"], repoPath);
}

/**
 * Resolve the target commit for a panel without creating any temp directories.
 * This allows early cache lookup before expensive git operations.
 *
 * @param panelsRoot - Absolute path to the workspace root
 * @param panelPath - Relative path to the panel within workspace
 * @param version - Optional version specifier
 * @returns The commit SHA that would be used, or null if not determinable (non-git repo)
 */
export async function resolveTargetCommit(
  panelsRoot: string,
  panelPath: string,
  version?: VersionSpec
): Promise<string | null> {
  const absolutePanelPath = path.resolve(panelsRoot, panelPath);

  if (!fs.existsSync(absolutePanelPath)) {
    return null;
  }

  const gitDir = path.join(absolutePanelPath, ".git");
  if (!fs.existsSync(gitDir)) {
    throw new Error(`Panel must be a git repository (or submodule): ${absolutePanelPath}`);
  }

  // No version specifier - use current HEAD, but only if worktree is clean
  if (!version?.gitRef) {
    // Check for dirty state - return null to skip cache and force full provision
    // which will then error with a proper message via assertCleanWorktree
    const isDirty = await isWorktreeDirty(absolutePanelPath);
    if (isDirty) {
      return null;
    }
    return getGitCommit(absolutePanelPath);
  }

  // Resolve the target ref to a commit SHA
  return resolveRef(absolutePanelPath, version.gitRef);
}

/**
 * Resolve a ref (branch, tag, or commit) to a full commit SHA.
 */
async function resolveRef(repoPath: string, ref: string): Promise<string> {
  try {
    return await runGit(["rev-parse", ref], repoPath);
  } catch (error) {
    const candidates: string[] = [];
    if (ref === "main") candidates.push("master");
    if (ref === "master") candidates.push("main");

    // If the user passed a plain branch name that doesn't exist locally, try origin/<branch>.
    if (!ref.includes("/") && !ref.startsWith("refs/")) {
      candidates.push(`origin/${ref}`);
    }

    for (const candidate of candidates) {
      try {
        return await runGit(["rev-parse", candidate], repoPath);
      } catch {
        // continue
      }
    }

    const msg = error instanceof Error ? error.message : String(error);
    const hint =
      ref === "main" || ref === "master"
        ? `Hint: this repo may use "${ref === "main" ? "master" : "main"}" instead of "${ref}".`
        : `Hint: if you meant the default branch, omit the gitRef fragment (no "#...").`;
    throw new Error(`${msg}\n${hint}`);
  }
}

/**
 * Create a temporary checkout of a repo at a specific commit.
 * Uses git worktree for efficiency when possible.
 */
async function createTempCheckout(
  repoPath: string,
  commit: string
): Promise<{ tempDir: string; cleanup: () => Promise<void> }> {
  const tempBase = getGitTempBuildsDirectory(repoPath);
  const tempDir = path.join(tempBase, `build-${commit.slice(0, 8)}-${Date.now()}`);

  try {
    // Try using git worktree first (more efficient, shares object store)
    await runGit(["worktree", "add", "--detach", tempDir, commit], repoPath);
    return {
      tempDir,
      cleanup: async () => {
        try {
          // Properly unregister the worktree to avoid leaving stale .git/worktrees entries.
          await runGit(["worktree", "remove", "--force", tempDir], repoPath);
        } catch (error) {
          console.warn(`[GitProvisioner] Failed to remove worktree: ${tempDir}`, error);
          try {
            await fs.promises.rm(tempDir, { recursive: true, force: true });
          } catch (rmError) {
            console.warn(`[GitProvisioner] Failed to cleanup temp dir: ${tempDir}`, rmError);
          }
        }
      },
    };
  } catch (worktreeError) {
    // Fallback to archive extraction if worktree fails
    console.warn("[GitProvisioner] Worktree failed, falling back to archive:", worktreeError);

    await fs.promises.mkdir(tempDir, { recursive: true });

    // Use git archive to extract files at specific commit without a shell pipeline
    const archivePath = path.join(tempBase, `archive-${commit.slice(0, 8)}.tar`);
    await runGit(["archive", "-o", archivePath, commit], repoPath);
    await execFileAsync("tar", ["-xf", archivePath, "-C", tempDir]);
    await fs.promises.rm(archivePath, { force: true });

    return {
      tempDir,
      cleanup: async () => {
        try {
          await fs.promises.rm(tempDir, { recursive: true, force: true });
        } catch (error) {
          console.warn(`[GitProvisioner] Failed to cleanup temp dir: ${tempDir}`, error);
        }
      },
    };
  }
}

/**
 * Check if a git worktree has uncommitted changes.
 */
export async function isWorktreeDirty(repoPath: string): Promise<boolean> {
  const status = await runGit(["status", "--porcelain"], repoPath);
  return status.trim().length > 0;
}

/**
 * Check if worktree is clean and return the result with the path.
 * Use this instead of assertCleanWorktree when you want to handle dirty state gracefully.
 */
export async function checkWorktreeClean(repoPath: string): Promise<{ clean: boolean; path: string }> {
  const dirty = await isWorktreeDirty(repoPath);
  return { clean: !dirty, path: repoPath };
}

/**
 * Internal helper: Check if a directory is the root of a git repository.
 * Returns true only if the directory is the actual root, not a subdirectory within a repo.
 *
 * Note: Use checkGitRepository() instead for the public API with structured output.
 */
async function isGitRepository(repoPath: string): Promise<boolean> {
  // First check if .git exists in this directory
  const gitDir = path.join(repoPath, ".git");
  if (!fs.existsSync(gitDir)) {
    return false;
  }

  // Verify this is the root of the repo, not a subdirectory
  try {
    const gitRoot = await runGit(["rev-parse", "--show-toplevel"], repoPath);
    const normalizedRepoPath = path.resolve(repoPath);
    const normalizedGitRoot = path.resolve(gitRoot);
    return normalizedRepoPath === normalizedGitRoot;
  } catch {
    // If git command fails, not a valid git repo
    return false;
  }
}

/**
 * Check if a directory is a git repository and return detailed result.
 * Returns both the boolean result and the checked path for consistency with checkWorktreeClean().
 *
 * This is the primary public API for git repository checks.
 */
export async function checkGitRepository(repoPath: string): Promise<{ isRepo: boolean; path: string }> {
  const isRepo = await isGitRepository(repoPath);
  return { isRepo, path: repoPath };
}

async function assertCleanWorktree(repoPath: string): Promise<void> {
  if (await isWorktreeDirty(repoPath)) {
    throw new Error(
      `Panel repo has uncommitted changes. Commit or stash before building: ${repoPath}`
    );
  }
}

async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(
      `Git command failed (${args.join(" ")}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
