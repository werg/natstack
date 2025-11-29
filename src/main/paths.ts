import * as path from "path";
import * as fs from "fs";
import { app } from "electron";
import type { Workspace } from "./workspace/types.js";

/**
 * Active workspace, if one is set.
 * When set, paths resolve to workspace-relative locations.
 */
let activeWorkspace: Workspace | null = null;

/**
 * Set the active workspace. Once set, getPanelCacheDirectory()
 * will return the workspace cache path.
 */
export function setActiveWorkspace(workspace: Workspace): void {
  activeWorkspace = workspace;
}

/**
 * Get the currently active workspace, if any.
 */
export function getActiveWorkspace(): Workspace | null {
  return activeWorkspace;
}

/**
 * Get the central NatStack config directory based on the platform.
 * This directory is used for app-wide configuration.
 *
 * Platform-specific paths:
 * - Linux: ~/.config/natstack
 * - macOS: ~/Library/Application Support/natstack
 * - Windows: %APPDATA%/natstack
 *
 * Falls back to a .natstack directory in the current working directory if
 * the platform-specific directory cannot be determined or created.
 */
export function getCentralConfigDirectory(): string {
  try {
    // Use Electron's app.getPath('userData') which handles platform differences
    const userDataPath = app.getPath("userData");

    // Create the directory if it doesn't exist
    fs.mkdirSync(userDataPath, { recursive: true });

    return userDataPath;
  } catch (error) {
    console.warn("Failed to get platform config directory, using fallback:", error);

    // Fallback to local directory
    const fallbackPath = path.resolve(".natstack");
    fs.mkdirSync(fallbackPath, { recursive: true });

    return fallbackPath;
  }
}

/**
 * Get the panel cache directory.
 * If a workspace is active, returns the workspace's cache directory.
 * Otherwise returns a cache directory in the central config location.
 */
export function getPanelCacheDirectory(): string {
  // If workspace is active, use workspace cache directory
  if (activeWorkspace) {
    fs.mkdirSync(activeWorkspace.cachePath, { recursive: true });
    return activeWorkspace.cachePath;
  }

  const configDir = getCentralConfigDirectory();
  const cacheDir = path.join(configDir, "panel-cache");

  fs.mkdirSync(cacheDir, { recursive: true });

  return cacheDir;
}

/**
 * Escape a worker ID for use in a filesystem path.
 * Replaces slashes with double underscores to avoid directory traversal.
 */
function escapeWorkerIdForPath(workerId: string): string {
  return workerId.replace(/\//g, "__");
}

/**
 * Get the filesystem scope path for a worker.
 * Creates a directory at: <central-config>/worker-scopes/<workspace-id>/<escaped-worker-id>/
 *
 * This provides each worker with its own isolated filesystem sandbox.
 * Singleton workers will get the same path across restarts since their ID is deterministic.
 *
 * @param workspaceId - The workspace ID from workspace config
 * @param workerId - The worker's tree node ID (may contain slashes)
 * @returns Absolute path to the worker's scope directory
 */
export function getWorkerScopePath(workspaceId: string, workerId: string): string {
  const configDir = getCentralConfigDirectory();
  const escapedWorkerId = escapeWorkerIdForPath(workerId);
  const scopePath = path.join(configDir, "worker-scopes", workspaceId, escapedWorkerId);

  // Create the directory if it doesn't exist
  fs.mkdirSync(scopePath, { recursive: true });

  return scopePath;
}
