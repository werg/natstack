/**
 * Panel bridge proxy for workers.
 *
 * This module uses the unified RPC mechanism to access bridge operations.
 * Workers can create children, set titles, and access git config just like panels.
 */

import type { CreateChildOptions, GitConfig, EndpointInfo } from "@natstack/core";
import { rpc } from "./rpc.js";

/**
 * Create a child panel or worker from a workspace-relative path.
 * The main process handles git checkout (if version specified) and build.
 * Returns the child ID immediately; build happens asynchronously.
 *
 * @param childPath - Workspace-relative path to the panel/worker (e.g., "panels/my-panel")
 * @param options - Optional env vars and version specifiers (branch, commit, tag)
 * @returns Child ID that can be used for RPC communication
 */
export async function createChild(
  childPath: string,
  options?: CreateChildOptions
): Promise<string> {
  return rpc.call<string>("main", "bridge.createChild", childPath, options);
}

/**
 * Remove a child panel or worker.
 *
 * @param childId - ID of the child to remove
 */
export async function removeChild(childId: string): Promise<void> {
  await rpc.call("main", "bridge.removeChild", childId);
}

/**
 * Set the title for this worker.
 * This is displayed in the panel tree UI.
 *
 * @param title - New title to display
 */
export async function setTitle(title: string): Promise<void> {
  await rpc.call("main", "bridge.setTitle", title);
}

/**
 * Close this worker.
 * This terminates the worker and removes it from the tree.
 */
export async function close(): Promise<void> {
  await rpc.call("main", "bridge.close");
}

/**
 * Get environment variables passed to this worker.
 */
export async function getEnv(): Promise<Record<string, string>> {
  return rpc.call<Record<string, string>>("main", "bridge.getEnv");
}

/**
 * Get information about this worker (ID and partition).
 */
export async function getInfo(): Promise<EndpointInfo> {
  return rpc.call<EndpointInfo>("main", "bridge.getInfo");
}

/**
 * Git operations for workers.
 */
export const git = {
  /**
   * Get git configuration for this worker.
   * Use with @natstack/git to clone/pull repos into the worker's scoped filesystem.
   *
   * Returns:
   * - serverUrl: Git server base URL (e.g., http://localhost:63524)
   * - token: Bearer token for authentication
   * - sourceRepo: This worker's source repo path (e.g., "workers/my-worker")
   * - gitDependencies: Git dependencies from manifest (to clone)
   */
  async getConfig(): Promise<GitConfig> {
    return rpc.call<GitConfig>("main", "bridge.getGitConfig");
  },
};
