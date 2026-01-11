import * as path from "path";
import * as fs from "fs";
import * as os from "os";
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
 * Falls back to OS-conventional locations derived from environment variables,
 * then finally to a temp directory if the platform directory cannot be used.
 */
export function getCentralConfigDirectory(): string {
  const ensureDir = (dir: string): string => {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const platformFallback = (): string => {
    const home = os.homedir();

    try {
      switch (process.platform) {
        case "win32": {
          const appData = process.env["APPDATA"] ?? path.join(home, "AppData", "Roaming");
          return path.join(appData, "natstack");
        }
        case "darwin":
          return path.join(home, "Library", "Application Support", "natstack");
        default: {
          const xdgConfig = process.env["XDG_CONFIG_HOME"] ?? path.join(home, ".config");
          return path.join(xdgConfig, "natstack");
        }
      }
    } catch {
      return path.join(os.tmpdir(), "natstack");
    }
  };

  try {
    // Use Electron's app.getPath('userData') which handles platform differences
    const userDataPath = app.getPath("userData");

    // Create the directory if it doesn't exist
    return ensureDir(userDataPath);
  } catch (error) {
    console.warn("Failed to get Electron userData directory, using fallback:", error);

    try {
      return ensureDir(platformFallback());
    } catch (fallbackError) {
      console.warn("Failed to create fallback config directory, using temp dir:", fallbackError);
      return ensureDir(path.join(os.tmpdir(), "natstack"));
    }
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
 * Get the NatStack state root directory.
 * - With an active workspace: <workspace>/.cache/
 * - Otherwise: platform userData directory (or platform fallback)
 */
export function getNatstackStateRootDirectory(): string {
  if (activeWorkspace) {
    fs.mkdirSync(activeWorkspace.cachePath, { recursive: true });
    return activeWorkspace.cachePath;
  }

  return getCentralConfigDirectory();
}

/**
 * Get the central build artifacts directory (never inside panel/worker source trees).
 * Always stored in the central config location, not workspace-specific.
 *
 * Location: <userData>/build-artifacts/
 * - Linux: ~/.config/natstack/build-artifacts/
 * - macOS: ~/Library/Application Support/natstack/build-artifacts/
 * - Windows: %APPDATA%/natstack/build-artifacts/
 */
export function getBuildArtifactsDirectory(): string {
  const centralConfigDir = getCentralConfigDirectory();
  const artifactsDir = path.join(centralConfigDir, "build-artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  return artifactsDir;
}

/**
 * Escape an ID for use in a filesystem path.
 * Replaces slashes with double underscores to avoid directory traversal.
 */
function escapeIdForPath(id: string): string {
  return id.replace(/\//g, "__");
}

/**
 * Get the scoped filesystem root directory for an unsafe panel or worker.
 * Creates a directory at: <central-config>/panel-scopes/<workspace-id>/<escaped-panel-id>/
 *
 * This provides each unsafe panel/worker with its own isolated filesystem sandbox when unsafe=true.
 * Panels or workers with unsafe="/" will use "/" as their scope path (full system access).
 *
 * @param workspaceId - The workspace ID from workspace config
 * @param panelId - The panel or worker's tree node ID (may contain slashes)
 * @returns Absolute path to the scope directory
 */
export function getPanelScopePath(workspaceId: string, panelId: string): string {
  const configDir = getCentralConfigDirectory();
  const escapedPanelId = escapeIdForPath(panelId);
  const scopePath = path.join(configDir, "panel-scopes", workspaceId, escapedPanelId);

  // Create the directory if it doesn't exist
  fs.mkdirSync(scopePath, { recursive: true });

  return scopePath;
}
