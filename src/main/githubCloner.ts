/**
 * GitHub repository cloning for transparent remote repo access.
 *
 * This module handles on-demand cloning of GitHub repositories when
 * requested through the internal git server. It provides:
 * - Path parsing for github.com/<owner>/<repo> format
 * - Clone-on-demand with in-flight deduplication
 * - Error classification for appropriate HTTP responses
 * - Optional fetch for keeping clones updated
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { createDevLogger } from "./devLog.js";

const execFileAsync = promisify(execFile);
const log = createDevLogger("GitHubCloner");

// =============================================================================
// Types
// =============================================================================

/**
 * Parsed GitHub repository specification from a path
 */
export interface GitHubRepoSpec {
  /** Always "github.com" */
  host: "github.com";
  /** User or organization name */
  owner: string;
  /** Repository name (without .git suffix) */
  repo: string;
}

/** Git smart HTTP endpoint suffixes that follow repo paths */
const GIT_HTTP_SUFFIXES = [
  "/info/refs",
  "/git-upload-pack",
  "/git-receive-pack",
  "/HEAD",
  "/objects",
];

/**
 * Options for cloning a GitHub repository
 */
export interface GitHubCloneOptions {
  /** Where to clone (e.g., <workspace>/github.com/owner/repo) */
  targetPath: string;
  /** GitHub URL (e.g., https://github.com/owner/repo.git) */
  remoteUrl: string;
  /** Optional: specific branch to clone */
  branch?: string;
  /** Optional: shallow clone depth (default: 1 for faster clones, 0 for full) */
  depth?: number;
  /** Optional: GitHub personal access token for private repos */
  token?: string;
}

/**
 * Error types for clone operations
 */
export type CloneErrorType =
  | "network" // Network/DNS issues
  | "not-found" // Repo doesn't exist
  | "auth" // Private repo without token
  | "rate-limited" // GitHub rate limit
  | "timeout" // Clone took too long
  | "unknown";

/**
 * Result of a clone operation
 */
export interface CloneResult {
  success: boolean;
  path: string;
  error?: string;
  errorType?: CloneErrorType;
}

// =============================================================================
// Path Parsing
// =============================================================================

/**
 * Strip git smart HTTP suffixes from a path.
 * Git clone makes requests to paths like:
 * - /repo/info/refs?service=git-upload-pack
 * - /repo/git-upload-pack
 */
function stripGitHttpSuffix(repoPath: string): string {
  let path = repoPath;
  for (const suffix of GIT_HTTP_SUFFIXES) {
    if (path.includes(suffix)) {
      path = path.substring(0, path.indexOf(suffix));
      break;
    }
  }
  return path;
}

/**
 * Parse a repository path to extract GitHub spec.
 *
 * Accepts formats:
 * - github.com/owner/repo
 * - github.com/owner/repo.git
 * - /github.com/owner/repo (with leading slash)
 * - github.com/owner/repo/info/refs (git smart HTTP)
 * - github.com/owner/repo/git-upload-pack (git smart HTTP)
 *
 * @returns GitHubRepoSpec if valid GitHub path, null otherwise
 */
export function parseGitHubPath(repoPath: string): GitHubRepoSpec | null {
  // Normalize: forward slashes, no leading/trailing slashes
  let normalized = repoPath
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  // Strip git smart HTTP suffixes (e.g., /info/refs, /git-upload-pack)
  normalized = stripGitHttpSuffix(normalized);

  // Match: github.com/owner/repo or github.com/owner/repo.git
  // Owner and repo: alphanumeric, hyphens, underscores, dots (GitHub allows these)
  const match = normalized.match(
    /^(github\.com)\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+?)(\.git)?$/
  );

  if (!match) return null;

  // These groups are guaranteed to exist if the regex matches
  const owner = match[2];
  const repo = match[3];
  if (!owner || !repo) return null;

  return {
    host: "github.com",
    owner,
    repo,
  };
}

/**
 * Check if a path is a GitHub repository path
 */
export function isGitHubPath(repoPath: string): boolean {
  return parseGitHubPath(repoPath) !== null;
}

/**
 * Build the normalized relative path for a GitHub repo
 */
export function toGitHubRelativePath(spec: GitHubRepoSpec): string {
  return `${spec.host}/${spec.owner}/${spec.repo}`;
}

/**
 * Build the GitHub HTTPS URL for cloning
 */
export function toGitHubUrl(spec: GitHubRepoSpec): string {
  return `https://github.com/${spec.owner}/${spec.repo}.git`;
}

// =============================================================================
// Clone Operations
// =============================================================================

/** Track in-flight clones to deduplicate concurrent requests */
const inFlightClones = new Map<string, Promise<CloneResult>>();

/**
 * Ensure a GitHub repository is cloned locally.
 *
 * - If already cloned, returns immediately
 * - If clone is in progress, waits for it
 * - Otherwise, starts a new clone
 *
 * This deduplication prevents multiple concurrent requests from
 * triggering multiple clones of the same repo.
 */
export async function ensureGitHubRepo(
  options: GitHubCloneOptions
): Promise<CloneResult> {
  const { targetPath } = options;

  // Check if already cloned
  if (fs.existsSync(path.join(targetPath, ".git"))) {
    return { success: true, path: targetPath };
  }

  // Check for in-flight clone (deduplicate concurrent requests)
  const existing = inFlightClones.get(targetPath);
  if (existing) {
    log.verbose(` Waiting for in-flight clone: ${targetPath}`);
    return existing;
  }

  // Start new clone
  const clonePromise = performClone(options);
  inFlightClones.set(targetPath, clonePromise);

  try {
    return await clonePromise;
  } finally {
    inFlightClones.delete(targetPath);
  }
}

/**
 * Perform the actual clone operation
 */
async function performClone(options: GitHubCloneOptions): Promise<CloneResult> {
  const { targetPath, remoteUrl, branch, depth = 1, token } = options;

  log.verbose(` Cloning ${remoteUrl} to ${targetPath}`);

  try {
    // Ensure parent directory exists
    const parentDir = path.dirname(targetPath);
    await fs.promises.mkdir(parentDir, { recursive: true });

    // Build git clone command
    const args = ["clone"];

    // Single branch for efficiency (can still fetch other branches later)
    args.push("--single-branch");

    // Shallow clone if depth specified (0 means full history)
    if (depth > 0) {
      args.push("--depth", String(depth));
    }

    // Specific branch if requested
    if (branch) {
      args.push("--branch", branch);
    }

    args.push(remoteUrl, targetPath);

    // Build environment for git command
    // Use credential helper to provide credentials without embedding in URL
    // This prevents token from being stored in .git/config or leaked in errors
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (token) {
      // Set credentials in environment variables (not in URL)
      env["GIT_USERNAME"] = token;
      env["GIT_PASSWORD"] = "x-oauth-basic";
      // Use credential helper that reads from env
      args.unshift(
        "-c",
        "credential.helper=!f() { echo username=$GIT_USERNAME; echo password=$GIT_PASSWORD; }; f"
      );
    }

    await execFileAsync("git", args, {
      timeout: 120000, // 2 minute timeout
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for output
      env,
    });

    // Configure the cloned repo for local use
    await configureClonedRepo(targetPath);

    log.verbose(` Successfully cloned ${remoteUrl}`);
    return { success: true, path: targetPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorType = classifyError(error);

    console.error(
      `[GitHubCloner] Failed to clone ${remoteUrl}: ${message} (${errorType})`
    );

    // Clean up partial clone if it exists
    try {
      if (fs.existsSync(targetPath)) {
        await fs.promises.rm(targetPath, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }

    return { success: false, path: targetPath, error: message, errorType };
  }
}

/**
 * Configure a cloned repository for local use
 */
async function configureClonedRepo(repoPath: string): Promise<void> {
  try {
    // Set local user config (for any local commits)
    await execFileAsync("git", ["config", "user.email", "natstack@local"], {
      cwd: repoPath,
    });
    await execFileAsync("git", ["config", "user.name", "NatStack"], {
      cwd: repoPath,
    });
  } catch (error) {
    // Non-fatal: repo is still usable without local config
    console.warn(`[GitHubCloner] Failed to configure repo: ${error}`);
  }
}

/**
 * Classify an error for appropriate HTTP response
 */
function classifyError(error: unknown): CloneErrorType {
  const message = String(error).toLowerCase();

  if (
    message.includes("repository not found") ||
    message.includes("not found")
  ) {
    return "not-found";
  }
  if (
    message.includes("authentication") ||
    message.includes("403") ||
    message.includes("could not read username")
  ) {
    return "auth";
  }
  if (message.includes("rate limit") || message.includes("429")) {
    return "rate-limited";
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return "timeout";
  }
  if (
    message.includes("network") ||
    message.includes("dns") ||
    message.includes("could not resolve")
  ) {
    return "network";
  }

  return "unknown";
}

/**
 * Map error type to HTTP status code
 */
export function errorTypeToHttpStatus(errorType: CloneErrorType): number {
  switch (errorType) {
    case "not-found":
      return 404;
    case "auth":
      return 403;
    case "rate-limited":
      return 429;
    case "timeout":
      return 504;
    case "network":
      return 502;
    default:
      return 500;
  }
}

// =============================================================================
// Update Operations
// =============================================================================

/**
 * Fetch latest from remote (for update operations).
 * This is a fire-and-forget operation - errors are logged but not thrown.
 */
export async function fetchGitHubRepo(repoPath: string): Promise<void> {
  try {
    await execFileAsync("git", ["fetch", "--all", "--prune"], {
      cwd: repoPath,
      timeout: 60000, // 1 minute timeout
    });
    log.verbose(` Fetched updates for ${repoPath}`);
  } catch (error) {
    console.warn(`[GitHubCloner] Failed to fetch ${repoPath}: ${error}`);
  }
}

/**
 * Check if a path contains a valid git repository
 */
export function isGitRepo(targetPath: string): boolean {
  return fs.existsSync(path.join(targetPath, ".git"));
}
