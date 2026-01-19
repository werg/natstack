/**
 * Gitignore parser and cache for workspace-aware file filtering.
 *
 * Implements hierarchical .gitignore resolution similar to git:
 * - Parses .gitignore files at each directory level
 * - Caches parsed ignore rules for performance
 * - Combines with default ignore patterns (node_modules, .git)
 */

import ignore, { type Ignore } from "ignore";
import * as fs from "fs";
import * as path from "path";

// Cache structure: Map<directory path, Ignore instance>
const ignoreCache = new Map<string, Ignore>();

// Default patterns always ignored (matches current behavior)
const DEFAULT_IGNORE_PATTERNS = ["node_modules", ".git"];

/**
 * Load and parse a .gitignore file, returning the patterns as an array.
 * Returns null if the file doesn't exist or can't be read.
 */
async function loadGitignoreFile(gitignorePath: string): Promise<string[] | null> {
  try {
    const content = await fs.promises.readFile(gitignorePath, "utf-8");
    // Filter out empty lines and comments
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return null;
  }
}

/**
 * Build a combined Ignore instance for a directory.
 * Includes patterns from all .gitignore files from workspace root to the directory.
 */
export async function getIgnoreForDirectory(
  dir: string,
  workspaceRoot: string
): Promise<Ignore> {
  // Check cache first
  const cached = ignoreCache.get(dir);
  if (cached) return cached;

  // Build ignore instance with default patterns
  const ig = ignore().add(DEFAULT_IGNORE_PATTERNS);

  // Collect all .gitignore paths from workspace root to current dir
  const gitignorePaths: string[] = [];
  let current = dir;

  while (current.startsWith(workspaceRoot) || current === workspaceRoot) {
    gitignorePaths.unshift(path.join(current, ".gitignore"));
    const parent = path.dirname(current);
    if (parent === current) break; // Reached filesystem root
    current = parent;
  }

  // Load and add patterns from each .gitignore (order matters: parent first)
  for (const gitignorePath of gitignorePaths) {
    const patterns = await loadGitignoreFile(gitignorePath);
    if (patterns) {
      ig.add(patterns);
    }
  }

  // Cache and return
  ignoreCache.set(dir, ig);
  return ig;
}

/**
 * Check if a relative path should be ignored.
 *
 * @param relativePath - Path relative to workspace root
 * @param workspaceRoot - Absolute path to workspace root
 */
export async function shouldIgnore(
  relativePath: string,
  workspaceRoot: string
): Promise<boolean> {
  const dir = path.dirname(path.join(workspaceRoot, relativePath));
  const ig = await getIgnoreForDirectory(dir, workspaceRoot);
  return ig.ignores(relativePath);
}

/**
 * Create a filter function for use with walkDirectory.
 * Pre-loads .gitignore for the starting directory.
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @returns Async function that returns true if path should be ignored
 */
export async function createIgnoreFilter(
  workspaceRoot: string
): Promise<(relativePath: string, parentDir: string) => Promise<boolean>> {
  // Pre-load root .gitignore
  await getIgnoreForDirectory(workspaceRoot, workspaceRoot);

  return async (relativePath: string, parentDir: string): Promise<boolean> => {
    const ig = await getIgnoreForDirectory(parentDir, workspaceRoot);
    return ig.ignores(relativePath);
  };
}

/**
 * Clear the gitignore cache (useful for testing or when files change).
 */
export function clearIgnoreCache(): void {
  ignoreCache.clear();
}
