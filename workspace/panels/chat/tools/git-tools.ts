/**
 * Git tools for pubsub RPC using isomorphic-git.
 *
 * Implements: git_status, git_diff, git_log, git_add, git_commit, git_checkout
 * Pure JavaScript implementation - no shell commands.
 */

import * as fs from "fs";
import * as path from "path";
import * as git from "isomorphic-git";
import { STAGE, type WalkerEntry } from "isomorphic-git";
import { createTwoFilesPatch } from "diff";
import type { MethodDefinition } from "@natstack/agentic-messaging";
import { resolvePath } from "./utils";
import type { z } from "zod";
import {
  GitStatusArgsSchema,
  GitDiffArgsSchema,
  GitLogArgsSchema,
  GitAddArgsSchema,
  GitCommitArgsSchema,
  GitCheckoutArgsSchema,
} from "@natstack/agentic-messaging";


/**
 * git_status - Show repository status
 */
export async function gitStatus(args: z.infer<typeof GitStatusArgsSchema>, workspaceRoot?: string): Promise<string> {
  const repoPath = args.path ?? workspaceRoot ?? process.cwd();

  // Get current branch
  let currentBranch: string;
  try {
    currentBranch = await git.currentBranch({ fs, dir: repoPath }) ?? "HEAD";
  } catch {
    currentBranch = "HEAD";
  }

  // Get tracking branch info
  let trackingInfo = "";
  try {
    const config = await git.getConfig({ fs, dir: repoPath, path: `branch.${currentBranch}.remote` });
    if (config) {
      trackingInfo = `Your branch is tracking 'origin/${currentBranch}'.`;
    }
  } catch {
    // No tracking info
  }

  // Get status matrix
  const statusMatrix = await git.statusMatrix({ fs, dir: repoPath });

  // Categorize changes
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];

  for (const [filepath, headStatus, workdirStatus, stageStatus] of statusMatrix) {
    // New file staged
    if (headStatus === 0 && stageStatus === 2) {
      staged.push(`new file:   ${filepath}`);
    }
    // Modified and staged
    else if (headStatus === 1 && stageStatus === 2) {
      staged.push(`modified:   ${filepath}`);
    }
    // Deleted and staged
    else if (headStatus === 1 && stageStatus === 0) {
      staged.push(`deleted:    ${filepath}`);
    }
    // Modified but not staged
    else if (headStatus === 1 && workdirStatus === 2 && stageStatus === 1) {
      modified.push(`modified:   ${filepath}`);
    }
    // Deleted but not staged
    else if (headStatus === 1 && workdirStatus === 0 && stageStatus === 1) {
      modified.push(`deleted:    ${filepath}`);
    }
    // Untracked
    else if (headStatus === 0 && workdirStatus === 2 && stageStatus === 0) {
      untracked.push(filepath);
    }
  }

  // Build output
  const lines: string[] = [];
  lines.push(`On branch ${currentBranch}`);
  if (trackingInfo) {
    lines.push(trackingInfo);
  }
  lines.push("");

  if (staged.length === 0 && modified.length === 0 && untracked.length === 0) {
    lines.push("nothing to commit, working tree clean");
    return lines.join("\n");
  }

  if (staged.length > 0) {
    lines.push("Changes to be committed:");
    lines.push('  (use "git restore --staged <file>..." to unstage)');
    for (const file of staged) {
      lines.push(`        ${file}`);
    }
    lines.push("");
  }

  if (modified.length > 0) {
    lines.push("Changes not staged for commit:");
    lines.push('  (use "git add <file>..." to update what will be committed)');
    for (const file of modified) {
      lines.push(`        ${file}`);
    }
    lines.push("");
  }

  if (untracked.length > 0) {
    lines.push("Untracked files:");
    lines.push('  (use "git add <file>..." to include in what will be committed)');
    for (const file of untracked) {
      lines.push(`        ${file}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Get file content from HEAD commit.
 */
async function getContentFromHead(repoPath: string, filepath: string): Promise<string> {
  try {
    const commitOid = await git.resolveRef({ fs, dir: repoPath, ref: "HEAD" });
    const { blob } = await git.readBlob({ fs, dir: repoPath, oid: commitOid, filepath });
    return new TextDecoder().decode(blob);
  } catch {
    return "";
  }
}

/**
 * Get file content from the staging area (index).
 */
async function getContentFromStage(repoPath: string, filepath: string): Promise<string> {
  try {
    const entries = await git.walk({
      fs,
      dir: repoPath,
      trees: [STAGE()],
      map: async (entryPath: string, walkerEntries: Array<WalkerEntry | null>) => {
        const stage = walkerEntries[0];
        if (entryPath === filepath && stage) {
          return await stage.oid();
        }
        return null;
      },
    });
    const stagedOid = entries.find((e: string | null): e is string => e !== null);
    if (stagedOid) {
      const { blob } = await git.readBlob({ fs, dir: repoPath, oid: stagedOid });
      return new TextDecoder().decode(blob);
    }
    // No staged content found - this is normal for unstaged files
    return "";
  } catch (err) {
    // Log the error for debugging but return empty (file may not be staged)
    console.warn(`[git_diff] Failed to read staged content for ${filepath}:`, err);
    return "";
  }
}

/**
 * Get file content from the working directory.
 */
async function getContentFromWorkdir(fullPath: string): Promise<string> {
  try {
    return await fs.promises.readFile(fullPath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * git_diff - Show file changes in unified diff format
 */
export async function gitDiff(args: z.infer<typeof GitDiffArgsSchema>, workspaceRoot?: string): Promise<string> {
  const repoPath = args.path ?? workspaceRoot ?? process.cwd();
  const { staged = false, file: specificFile } = args;

  // Get status matrix
  const statusMatrix = await git.statusMatrix({ fs, dir: repoPath });

  const diffs: string[] = [];

  for (const row of statusMatrix) {
    // Cast to number to avoid literal type comparison issues
    const [filepath, headStatus, workdirStatus, stageStatus] = row as [string, number, number, number];
    // Filter by specific file if provided
    if (specificFile && filepath !== specificFile) continue;

    let oldContent = "";
    let newContent = "";
    let shouldDiff = false;

    const fullPath = path.join(repoPath, filepath);

    if (staged) {
      // Compare HEAD to stage
      if (stageStatus !== headStatus || (headStatus === 0 && stageStatus === 2)) {
        shouldDiff = true;

        // Get HEAD content
        if (headStatus === 1) {
          oldContent = await getContentFromHead(repoPath, filepath);
        }

        // Get staged content from the index (not working tree)
        if (stageStatus === 2 || stageStatus === 3) {
          newContent = await getContentFromStage(repoPath, filepath);
        }
      }
    } else {
      // Compare stage/HEAD to working directory
      if (workdirStatus === 2 && (stageStatus === 1 || stageStatus === 2 || headStatus === 1)) {
        shouldDiff = true;

        // Get staged/HEAD content
        if (stageStatus === 2 || stageStatus === 3) {
          // Compare against staged content from index
          oldContent = await getContentFromStage(repoPath, filepath);
        } else if (headStatus === 1) {
          // Compare against HEAD (stage matches HEAD)
          oldContent = await getContentFromHead(repoPath, filepath);
        }

        // Get working directory content
        newContent = await getContentFromWorkdir(fullPath);
      } else if (workdirStatus === 0 && headStatus === 1 && stageStatus === 1) {
        // Deleted file
        shouldDiff = true;
        oldContent = await getContentFromHead(repoPath, filepath);
        newContent = "";
      }
    }

    if (shouldDiff && (oldContent !== newContent)) {
      const patch = createTwoFilesPatch(
        `a/${filepath}`,
        `b/${filepath}`,
        oldContent,
        newContent,
        "",
        "",
        { context: 3 }
      );
      diffs.push(patch);
    }
  }

  if (diffs.length === 0) {
    return "";
  }

  return diffs.join("\n");
}

/**
 * git_log - Show commit history
 */
export async function gitLog(args: z.infer<typeof GitLogArgsSchema>, workspaceRoot?: string): Promise<string> {
  const repoPath = args.path ?? workspaceRoot ?? process.cwd();
  const { limit = 10, format = "oneline" } = args;

  const commits = await git.log({ fs, dir: repoPath, depth: limit });

  if (format === "oneline") {
    return commits
      .map((commit) => {
        const shortOid = commit.oid.slice(0, 7);
        const firstLine = commit.commit.message.split("\n")[0];
        return `${shortOid} ${firstLine}`;
      })
      .join("\n");
  }

  // Full format
  return commits
    .map((commit) => {
      const lines: string[] = [];
      lines.push(`commit ${commit.oid}`);
      lines.push(`Author: ${commit.commit.author.name} <${commit.commit.author.email}>`);
      const date = new Date(commit.commit.author.timestamp * 1000);
      lines.push(`Date:   ${date.toString()}`);
      lines.push("");
      // Indent message
      const messageLines = commit.commit.message.split("\n");
      for (const line of messageLines) {
        lines.push(`    ${line}`);
      }
      lines.push("");
      return lines.join("\n");
    })
    .join("\n");
}

/**
 * git_add - Stage files
 */
export async function gitAdd(args: z.infer<typeof GitAddArgsSchema>, workspaceRoot?: string): Promise<string> {
  const repoPath = args.path ?? workspaceRoot ?? process.cwd();
  const { files } = args;

  let stagedCount = 0;

  for (const file of files) {
    try {
      await git.add({ fs, dir: repoPath, filepath: file });
      stagedCount++;
    } catch (err) {
      throw new Error(`Failed to stage ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return `Staged ${stagedCount} file${stagedCount === 1 ? "" : "s"}`;
}

/**
 * git_commit - Create a commit
 */
export async function gitCommit(args: z.infer<typeof GitCommitArgsSchema>, workspaceRoot?: string): Promise<string> {
  const repoPath = args.path ?? workspaceRoot ?? process.cwd();
  const { message } = args;

  try {
    // Get author info from git config
    let authorName = "User";
    let authorEmail = "user@example.com";

    try {
      const name = await git.getConfig({ fs, dir: repoPath, path: "user.name" });
      const email = await git.getConfig({ fs, dir: repoPath, path: "user.email" });
      if (name) authorName = name;
      if (email) authorEmail = email;
    } catch {
      // Use defaults
    }

    const sha = await git.commit({
      fs,
      dir: repoPath,
      message,
      author: { name: authorName, email: authorEmail },
    });

    return `Created commit ${sha.slice(0, 7)}`;
  } catch (err) {
    throw new Error(`Commit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * git_checkout - Switch branches or restore files
 */
export async function gitCheckout(args: z.infer<typeof GitCheckoutArgsSchema>, workspaceRoot?: string): Promise<string> {
  const repoPath = args.path ?? workspaceRoot ?? process.cwd();
  const { branch, file, create } = args;

  if (file) {
    // Restore a file from HEAD
    try {
      const commitOid = await git.resolveRef({ fs, dir: repoPath, ref: "HEAD" });
      const { blob } = await git.readBlob({
        fs,
        dir: repoPath,
        oid: commitOid,
        filepath: file,
      });
      // Write raw bytes to preserve binary files - blob is already Uint8Array
      await fs.promises.writeFile(path.join(repoPath, file), blob);
      return `Restored ${file}`;
    } catch (err) {
      throw new Error(`Failed to restore ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (branch) {
    if (create) {
      // Create and switch to new branch
      try {
        await git.branch({ fs, dir: repoPath, ref: branch });
        await git.checkout({ fs, dir: repoPath, ref: branch });
        return `Switched to new branch '${branch}'`;
      } catch (err) {
        throw new Error(`Failed to create branch ${branch}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      // Switch to existing branch
      try {
        await git.checkout({ fs, dir: repoPath, ref: branch });
        return `Switched to branch '${branch}'`;
      } catch (err) {
        throw new Error(`Failed to checkout ${branch}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  throw new Error("Either branch or file must be specified");
}

/**
 * Create method definitions for git tools
 */
export function createGitToolMethodDefinitions(workspaceRoot?: string): Record<string, MethodDefinition> {
  return {
    git_status: {
      description: `Show repository status.

Output format matches \`git status\`:
- Current branch
- Changes to be committed (staged)
- Changes not staged for commit
- Untracked files`,
      parameters: GitStatusArgsSchema,
      execute: async (args: z.infer<typeof GitStatusArgsSchema>) => {
        return await gitStatus(args, workspaceRoot);
      },
    },
    git_diff: {
      description: `Show file changes in unified diff format.

Options:
- staged: Show staged changes (like --cached)
- file: Diff a specific file only`,
      parameters: GitDiffArgsSchema,
      execute: async (args: z.infer<typeof GitDiffArgsSchema>) => {
        return await gitDiff(args, workspaceRoot);
      },
    },
    git_log: {
      description: `Show commit history.

Formats:
- oneline: Short hash + first line of message
- full: Complete commit info with author, date, full message`,
      parameters: GitLogArgsSchema,
      execute: async (args: z.infer<typeof GitLogArgsSchema>) => {
        return await gitLog(args, workspaceRoot);
      },
    },
    git_add: {
      description: `Stage files for commit.

Accepts an array of file paths to stage.`,
      parameters: GitAddArgsSchema,
      execute: async (args: z.infer<typeof GitAddArgsSchema>) => {
        return await gitAdd(args, workspaceRoot);
      },
    },
    git_commit: {
      description: `Create a commit with the staged changes.

Uses author info from git config (user.name, user.email).`,
      parameters: GitCommitArgsSchema,
      execute: async (args: z.infer<typeof GitCommitArgsSchema>) => {
        return await gitCommit(args, workspaceRoot);
      },
    },
    git_checkout: {
      description: `Switch branches or restore files.

Use with:
- branch: Switch to an existing branch
- branch + create: Create and switch to a new branch
- file: Restore a file from HEAD`,
      parameters: GitCheckoutArgsSchema,
      execute: async (args: z.infer<typeof GitCheckoutArgsSchema>) => {
        return await gitCheckout(args, workspaceRoot);
      },
    },
  };
}
