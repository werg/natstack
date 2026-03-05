/**
 * Git Context Service — git operations scoped to context folders.
 *
 * Context folders exclude `.git/` (SKIP_DIRS in contextFolderManager), so
 * this service initializes git repos on first use. Push uses the workspace
 * git server (PushTrigger → auto-rebuild).
 */

import * as path from "path";
import * as fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveWithinContext } from "./contextPaths.js";
import type { ContextFolderManager } from "../contextFolderManager.js";
import type { GitServer } from "../gitServer.js";
import type { TokenManager } from "../tokenManager.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Post-push checkout waiter
// ---------------------------------------------------------------------------

/**
 * Create a listener that waits for the git server to complete post-push
 * checkout for a specific repo. Must be set up BEFORE `git push` runs to
 * avoid a race where the event fires before the listener is registered.
 *
 * Resolves when the matching push event fires (working tree is updated)
 * or after timeoutMs (graceful degradation — build may still work from
 * the old checkout or a slightly delayed one).
 */
function createPushCheckoutWaiter(
  gitServer: GitServer,
  repoPath: string,
  timeoutMs: number = 10_000,
): { promise: Promise<void>; cancel: () => void } {
  let resolve!: () => void;
  let settled = false;

  const promise = new Promise<void>((res) => { resolve = res; });

  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      unsubscribe();
      resolve();
    }
  }, timeoutMs);

  const unsubscribe = gitServer.onPush((event) => {
    if (!settled && event.repo === repoPath) {
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    }
  });

  const cancel = () => {
    if (!settled) {
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    }
  };

  return { promise, cancel };
}

/** Cache of directories we've already initialized git in */
const initializedPaths = new Set<string>();

/**
 * Run a git command in a directory.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  // Some git commands (push, commit) write progress to stderr
  return stdout || stderr || "";
}

/**
 * Ensure a directory is a git repo. If not, initialize it with an initial commit,
 * configure the remote to the workspace git server, and set up auth.
 */
async function ensureGitInit(
  dirPath: string,
  repoPath: string,
  gitServer: GitServer,
  tokenManager: TokenManager,
  contextId: string,
): Promise<void> {
  if (initializedPaths.has(dirPath)) return;

  const gitDir = path.join(dirPath, ".git");
  if (fs.existsSync(gitDir)) {
    initializedPaths.add(dirPath);
    return;
  }

  // Initialize git repo
  await git(dirPath, ["init", "-b", "main"]);
  await git(dirPath, ["config", "user.email", "natstack@local"]);
  await git(dirPath, ["config", "user.name", "NatStack"]);

  // Configure remote
  const remoteUrl = `${gitServer.getBaseUrl()}/${repoPath}`;
  await git(dirPath, ["remote", "add", "origin", remoteUrl]);

  // Configure auth header
  const token = tokenManager.ensureToken(contextId, "server");
  await git(dirPath, ["config", "http.extraHeader", `Authorization: Bearer ${token}`]);

  // Initial commit (only if there are files)
  const status = await git(dirPath, ["status", "--porcelain"]);
  if (status.trim()) {
    await git(dirPath, ["add", "-A"]);
    await git(dirPath, ["commit", "-m", "Initial"]);
  }

  initializedPaths.add(dirPath);
}

/**
 * Derive the repo path from the absolute path relative to the context root.
 * E.g., /workspace/.contexts/abc/panels/my-app → panels/my-app
 */
function deriveRepoPath(contextRoot: string, absPath: string): string {
  return path.relative(contextRoot, absPath);
}

export async function handleGitContextCall(
  contextFolderManager: ContextFolderManager,
  gitServer: GitServer,
  tokenManager: TokenManager,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const contextId = args[0] as string;
  const operation = args[1] as string;
  const opPath = args[2] as string | undefined;
  const message = args[3] as string | undefined;
  const files = args[4] as string[] | undefined;

  const contextRoot = await contextFolderManager.ensureContextFolder(contextId);

  // Resolve target path within context. It may be a directory or a file.
  const resolvedPath = opPath
    ? resolveWithinContext(contextRoot, opPath)
    : contextRoot;

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Target path does not exist: ${opPath ?? "."}`);
  }

  // If opPath points to a file, use its parent directory as the git repo root
  // and track the filename for file-scoped operations (diff).
  const isFile = fs.statSync(resolvedPath).isFile();
  const targetDir = isFile ? path.dirname(resolvedPath) : resolvedPath;
  const scopedFile = isFile ? path.basename(resolvedPath) : undefined;

  const repoPath = deriveRepoPath(contextRoot, targetDir);

  // Ensure git is initialized for this directory
  await ensureGitInit(targetDir, repoPath, gitServer, tokenManager, contextId);

  switch (operation) {
    case "status": {
      const statusArgs = ["status", "--porcelain"];
      if (scopedFile) statusArgs.push("--", scopedFile);
      const output = await git(targetDir, statusArgs);
      return output || "Nothing to commit, working tree clean";
    }

    case "diff": {
      const diffArgs = scopedFile ? ["--", scopedFile] : [];
      const output = await git(targetDir, ["diff", ...diffArgs]);
      const staged = await git(targetDir, ["diff", "--staged", ...diffArgs]);
      const parts: string[] = [];
      if (output.trim()) parts.push("Unstaged changes:\n" + output);
      if (staged.trim()) parts.push("Staged changes:\n" + staged);
      return parts.length ? parts.join("\n\n") : "No changes";
    }

    case "commit": {
      if (!message) {
        throw new Error("Commit message is required for 'commit' operation");
      }

      // Stage files
      if (files && files.length > 0) {
        // Validate each file path
        for (const f of files) {
          resolveWithinContext(targetDir, f);
        }
        await git(targetDir, ["add", ...files]);
      } else {
        await git(targetDir, ["add", "-A"]);
      }

      // Check if there's anything staged
      const staged = await git(targetDir, ["diff", "--cached", "--stat"]);
      if (!staged.trim()) {
        return "Nothing to commit (no staged changes)";
      }

      const output = await git(targetDir, ["commit", "-m", message]);
      return output.trim();
    }

    case "log": {
      const output = await git(targetDir, ["log", "--oneline", "-n", "20"]);
      return output || "No commits yet";
    }

    case "push": {
      // Ensure auth token is current
      const token = tokenManager.ensureToken(contextId, "server");
      await git(targetDir, [
        "config", "http.extraHeader", `Authorization: Bearer ${token}`,
      ]);

      // Set up listener BEFORE push so we don't miss the event
      const pushWaiter = createPushCheckoutWaiter(gitServer, repoPath);
      try {
        await git(targetDir, ["push", "-u", "origin", "main"]);
      } catch (err) {
        pushWaiter.cancel();
        throw err;
      }
      // Wait for post-push checkout (symbolic-ref + reset --hard) to complete
      await pushWaiter.promise;

      return "Pushed to origin/main";
    }

    case "commit_and_push": {
      if (!message) {
        throw new Error("Commit message is required for 'commit_and_push' operation");
      }

      // Stage files
      if (files && files.length > 0) {
        for (const f of files) {
          resolveWithinContext(targetDir, f);
        }
        await git(targetDir, ["add", ...files]);
      } else {
        await git(targetDir, ["add", "-A"]);
      }

      // Check if there's anything staged
      const staged = await git(targetDir, ["diff", "--cached", "--stat"]);
      if (!staged.trim()) {
        return "Nothing to commit (no staged changes)";
      }

      // Commit
      const commitOutput = await git(targetDir, ["commit", "-m", message]);

      // Push — wait for post-push checkout to complete before returning,
      // so callers (like launch_panel) can immediately use the updated working tree.
      const token = tokenManager.ensureToken(contextId, "server");
      await git(targetDir, [
        "config", "http.extraHeader", `Authorization: Bearer ${token}`,
      ]);

      // Set up listener BEFORE push so we don't miss the event
      const pushWaiter = createPushCheckoutWaiter(gitServer, repoPath);
      try {
        await git(targetDir, ["push", "-u", "origin", "main"]);
      } catch (pushErr) {
        pushWaiter.cancel();
        throw pushErr;
      }
      await pushWaiter.promise;

      return (commitOutput.trim() + "\nPushed to origin/main").trim();
    }

    default:
      throw new Error(`Unknown git operation: ${operation}`);
  }
}
