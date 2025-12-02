/**
 * Panel bridge proxy for workers.
 *
 * This module uses the unified RPC mechanism to access bridge operations.
 * Workers can create children, set titles, and access git config just like panels.
 */

import type { ChildSpec, GitConfig, EndpointInfo } from "@natstack/core";
import { rpc } from "./rpc.js";

/**
 * Create a child panel, worker, or browser from a spec.
 * The main process handles git checkout (if version specified) and build for app/worker types.
 * Returns the child ID immediately; build happens asynchronously.
 *
 * @param spec - Child specification with type discriminator
 * @returns Child ID that can be used for RPC communication
 *
 * @example
 * ```ts
 * // Create an app panel
 * const editorId = await createChild({
 *   type: 'app',
 *   name: 'editor',
 *   path: 'panels/editor',
 *   env: { FILE_PATH: '/foo.txt' },
 * });
 *
 * // Create a worker
 * const computeId = await createChild({
 *   type: 'worker',
 *   name: 'compute-worker',
 *   path: 'workers/compute',
 *   memoryLimitMB: 512,
 * });
 *
 * // Create a browser panel
 * const browserId = await createChild({
 *   type: 'browser',
 *   name: 'web-scraper',
 *   url: 'https://example.com',
 * });
 * ```
 */
export async function createChild(spec: ChildSpec): Promise<string> {
  return rpc.call<string>("main", "bridge.createChild", spec);
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

/**
 * Browser automation API for workers.
 */
export const browser = {
  /**
   * Get CDP WebSocket endpoint for Playwright connection.
   * Only the parent (worker or panel) that created the browser can access this.
   *
   * @param browserId - The browser panel's ID (returned from createChild)
   * @returns WebSocket URL for CDP connection (e.g., "ws://localhost:49300/browser-id?token=xxx")
   *
   * @example
   * ```ts
   * import { chromium } from 'playwright-core';
   *
   * const browserId = await createChild({
   *   type: 'browser',
   *   name: 'scraper',
   *   url: 'https://example.com',
   * });
   *
   * const endpoint = await browser.getCdpEndpoint(browserId);
   * const browser = await chromium.connectOverCDP(endpoint);
   * const page = browser.contexts()[0].pages()[0];
   * // ... automate the page
   * ```
   */
  async getCdpEndpoint(browserId: string): Promise<string> {
    return rpc.call<string>("main", "browser.getCdpEndpoint", browserId);
  },
};
