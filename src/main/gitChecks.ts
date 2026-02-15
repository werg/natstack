/**
 * Git worktree checks for panel lifecycle.
 *
 * Simple shell-out to `git` CLI for checking repo state before building.
 * Used by PanelManager to redirect to shell pages when git state is invalid.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

const execFileAsync = promisify(execFile);

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

/**
 * Check if a directory has uncommitted changes.
 */
export async function isWorktreeDirty(repoPath: string): Promise<boolean> {
  const status = await runGit(["status", "--porcelain"], repoPath);
  return status.trim().length > 0;
}

/**
 * Check if a directory is a git repository root.
 */
async function isGitRepositoryRoot(repoPath: string): Promise<boolean> {
  const gitDir = path.join(repoPath, ".git");
  if (!fs.existsSync(gitDir)) {
    return false;
  }

  try {
    const gitRoot = await runGit(["rev-parse", "--show-toplevel"], repoPath);
    const normalizedRepoPath = path.resolve(repoPath);
    const normalizedGitRoot = path.resolve(gitRoot);
    return normalizedRepoPath === normalizedGitRoot;
  } catch {
    return false;
  }
}

/**
 * Check if a directory is a clean git repository (no uncommitted changes).
 */
export async function checkWorktreeClean(repoPath: string): Promise<{ clean: boolean; path: string }> {
  const dirty = await isWorktreeDirty(repoPath);
  return { clean: !dirty, path: repoPath };
}

/**
 * Check if a directory is a git repository root.
 */
export async function checkGitRepository(repoPath: string): Promise<{ isRepo: boolean; path: string }> {
  const isRepo = await isGitRepositoryRoot(repoPath);
  return { isRepo, path: repoPath };
}
