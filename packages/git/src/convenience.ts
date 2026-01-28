/**
 * Git convenience functions for common operations.
 *
 * These compose existing GitClient methods into higher-level workflows.
 */

import * as path from "path";
import type { GitClient, FsPromisesLike } from "./client.js";

export interface InitAndPushOptions {
  /** Directory to initialize the repo in */
  dir: string;
  /** Remote path (e.g., "panels/my-new-panel") - resolved via GitClient.resolveUrl internally */
  remote: string;
  /** Branch name (default: "main") */
  branch?: string;
  /** Initial files to create (path -> content) */
  initialFiles?: Record<string, string>;
  /** Commit message (default: "Initial commit") */
  message?: string;
}

/**
 * Initialize a new git repo, optionally add files, and push to remote.
 *
 * This is a convenience function that composes:
 * 1. git init
 * 2. Write initial files (if provided)
 * 3. git add all
 * 4. git commit (if there are changes)
 * 5. git remote add origin
 * 6. git push -u origin <branch>
 *
 * @param client - GitClient instance
 * @param fs - Filesystem promises interface (for writing files)
 * @param options - Init and push options
 */
export async function initAndPush(
  client: GitClient,
  fs: FsPromisesLike,
  options: InitAndPushOptions
): Promise<void> {
  const { dir, remote, branch = "main", initialFiles, message = "Initial commit" } = options;

  // 1. git init
  await client.init(dir, branch);

  // 2. Write initial files if provided (ensure parent directories exist)
  if (initialFiles && Object.keys(initialFiles).length > 0) {
    for (const [filePath, content] of Object.entries(initialFiles)) {
      const fullPath = path.posix.join(dir, filePath);
      const parentDir = path.posix.dirname(fullPath);
      if (parentDir && parentDir !== dir) {
        await fs.mkdir(parentDir, { recursive: true });
      }
      await fs.writeFile(fullPath, content);
    }
  }

  // 3. git add all
  await client.addAll(dir);

  // 4. git commit (skip if nothing to commit)
  const status = await client.status(dir);
  const hasChanges = status.files.some(
    (f) => f.status !== "unmodified" && f.status !== "ignored"
  );

  let didCommit = false;
  if (hasChanges) {
    await client.commit({ dir, message });
    didCommit = true;
  }

  // 5. git remote add origin
  // Note: GitClient.addRemote calls resolveUrl() internally, so relative paths
  // like "panels/foo" are automatically resolved to full URLs
  await client.addRemote(dir, "origin", remote);

  // 6. git push -u origin <branch> (only if we made a commit)
  // Pushing an empty repo (no commits) will fail with "src refspec does not match"
  if (didCommit) {
    await client.push({ dir, ref: branch });
  }
}
