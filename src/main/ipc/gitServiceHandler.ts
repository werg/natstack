/**
 * Git Service Handler - Main process service for git and scoped filesystem operations.
 *
 * Provides git operations (via GitClient) and scoped filesystem access to panels,
 * replacing the need for nodeIntegration in shell about pages (git-init, dirty-repo).
 *
 * All filesystem operations are validated against a caller-provided scope directory
 * to prevent path traversal.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { GitClient, type FsPromisesLike } from "@natstack/git";
import type { ServiceContext } from "../serviceDispatcher.js";

/**
 * Create a GitClient instance for the service.
 * Uses Node.js fs and empty server config (local operations only).
 */
function createServiceGitClient(): GitClient {
  return new GitClient(fs as unknown as FsPromisesLike, {
    serverUrl: "",
    token: "",
  });
}

/** Singleton git client for the service */
let gitClient: GitClient | null = null;

function getGitClient(): GitClient {
  if (!gitClient) {
    gitClient = createServiceGitClient();
  }
  return gitClient;
}

/**
 * Validate that a file path is within the allowed scope directory.
 * Prevents path traversal attacks.
 */
function validateScopedPath(scopeDir: string, filePath: string): string {
  const resolved = path.resolve(filePath);
  const resolvedScope = path.resolve(scopeDir);
  if (!resolved.startsWith(resolvedScope + path.sep) && resolved !== resolvedScope) {
    throw new Error(`Path "${filePath}" is outside allowed scope "${scopeDir}"`);
  }
  return resolved;
}

/**
 * Handle git service calls from panels.
 *
 * Methods are grouped into:
 * - Git operations (status, add, commit, diff, etc.)
 * - Scoped filesystem operations (readFile, writeFile, etc.)
 */
export async function handleGitServiceCall(
  _ctx: ServiceContext,
  method: string,
  args: unknown[]
): Promise<unknown> {
  const client = getGitClient();

  switch (method) {
    // =========================================================================
    // Repository operations
    // =========================================================================

    case "init": {
      const dir = args[0] as string;
      const defaultBranch = (args[1] as string) ?? "main";
      await client.init(dir, defaultBranch);
      return;
    }

    case "isRepo": {
      const dir = args[0] as string;
      return client.isRepo(dir);
    }

    case "status": {
      const dir = args[0] as string;
      return client.status(dir);
    }

    // =========================================================================
    // Staging operations
    // =========================================================================

    case "add": {
      const [dir, filepath] = args as [string, string];
      await client.add(dir, filepath);
      return;
    }

    case "addAll": {
      const dir = args[0] as string;
      await client.addAll(dir);
      return;
    }

    case "unstage": {
      const [dir, filepath] = args as [string, string];
      await client.unstage(dir, filepath);
      return;
    }

    case "stageHunks": {
      const options = args[0] as Parameters<GitClient["stageHunks"]>[0];
      await client.stageHunks(options);
      return;
    }

    case "unstageHunks": {
      const options = args[0] as Parameters<GitClient["unstageHunks"]>[0];
      await client.unstageHunks(options);
      return;
    }

    case "discardChanges": {
      const [dir, filepath] = args as [string, string];
      await client.discardChanges(dir, filepath);
      return;
    }

    // =========================================================================
    // Commit operations
    // =========================================================================

    case "commit": {
      const options = args[0] as Parameters<GitClient["commit"]>[0];
      return client.commit(options);
    }

    case "log": {
      const [dir, options] = args as [string, { depth?: number; ref?: string }?];
      return client.log(dir, options);
    }

    case "getCommitFiles": {
      const [dir, sha] = args as [string, string];
      return client.getCommitFiles(dir, sha);
    }

    // =========================================================================
    // Diff operations
    // =========================================================================

    case "getWorkingDiff": {
      const [dir, filepath] = args as [string, string];
      return client.getWorkingDiff(dir, filepath);
    }

    case "getStagedDiff": {
      const [dir, filepath] = args as [string, string];
      return client.getStagedDiff(dir, filepath);
    }

    case "getCommitDiff": {
      const [dir, sha, filepath] = args as [string, string, string];
      return client.getCommitDiff(dir, sha, filepath);
    }

    // =========================================================================
    // Stash operations
    // =========================================================================

    case "stash": {
      const [dir, options] = args as [string, { message?: string; includeUntracked?: boolean }?];
      await client.stash(dir, options);
      return;
    }

    case "stashList": {
      const dir = args[0] as string;
      return client.stashList(dir);
    }

    case "stashApply": {
      const [dir, index] = args as [string, number?];
      await client.stashApply(dir, index);
      return;
    }

    case "stashPop": {
      const [dir, index] = args as [string, number?];
      await client.stashPop(dir, index);
      return;
    }

    case "stashDrop": {
      const [dir, index] = args as [string, number?];
      await client.stashDrop(dir, index);
      return;
    }

    // =========================================================================
    // Scoped filesystem operations
    // All take scopeDir as first arg and validate paths against it.
    // =========================================================================

    case "fs.readFile": {
      const [scopeDir, filePath, encoding] = args as [string, string, BufferEncoding?];
      const resolved = validateScopedPath(scopeDir, filePath);
      if (encoding) {
        return fs.readFile(resolved, { encoding });
      }
      // Return as base64 for binary data transport over RPC
      const buffer = await fs.readFile(resolved);
      return { __binary: true, data: buffer.toString("base64") };
    }

    case "fs.writeFile": {
      const [scopeDir, filePath, data] = args as [string, string, string];
      const resolved = validateScopedPath(scopeDir, filePath);
      await fs.writeFile(resolved, data);
      return;
    }

    case "fs.unlink": {
      const [scopeDir, filePath] = args as [string, string];
      const resolved = validateScopedPath(scopeDir, filePath);
      await fs.unlink(resolved);
      return;
    }

    case "fs.readdir": {
      const [scopeDir, dirPath] = args as [string, string];
      const resolved = validateScopedPath(scopeDir, dirPath);
      return fs.readdir(resolved);
    }

    case "fs.mkdir": {
      const [scopeDir, dirPath, options] = args as [string, string, { recursive?: boolean }?];
      const resolved = validateScopedPath(scopeDir, dirPath);
      return fs.mkdir(resolved, options);
    }

    case "fs.rmdir": {
      const [scopeDir, dirPath] = args as [string, string];
      const resolved = validateScopedPath(scopeDir, dirPath);
      await fs.rmdir(resolved);
      return;
    }

    case "fs.stat": {
      const [scopeDir, filePath] = args as [string, string];
      const resolved = validateScopedPath(scopeDir, filePath);
      const stat = await fs.stat(resolved);
      return { isDirectory: stat.isDirectory(), isFile: stat.isFile() };
    }

    default:
      throw new Error(`Unknown git service method: ${method}`);
  }
}
