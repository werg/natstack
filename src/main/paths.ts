import * as path from "path";
import * as fs from "fs";
import { app } from "electron";

/**
 * Get the NatStack state directory based on the platform.
 * This directory is used for caching panel builds and other persistent data.
 *
 * Returns:
 * - Linux: ~/.config/natstack
 * - macOS: ~/Library/Application Support/natstack
 * - Windows: %APPDATA%/natstack
 *
 * Falls back to a .natstack directory in the current working directory if
 * the platform-specific directory cannot be determined or created.
 */
export function getStateDirectory(): string {
  try {
    // Use Electron's app.getPath('userData') which handles platform differences
    const userDataPath = app.getPath("userData");

    // Create the directory if it doesn't exist
    fs.mkdirSync(userDataPath, { recursive: true });

    return userDataPath;
  } catch (error) {
    console.warn("Failed to get platform state directory, using fallback:", error);

    // Fallback to local directory
    const fallbackPath = path.resolve(".natstack");
    fs.mkdirSync(fallbackPath, { recursive: true });

    return fallbackPath;
  }
}

/**
 * Get the panel cache directory.
 */
export function getPanelCacheDirectory(): string {
  const stateDir = getStateDirectory();
  const cacheDir = path.join(stateDir, "panel-cache");

  fs.mkdirSync(cacheDir, { recursive: true });

  return cacheDir;
}
