import * as path from "path";
import * as os from "os";

let _userDataPath: string | null = null;

/** Explicitly set the user-data directory (for headless/test use). */
export function setUserDataPath(p: string): void {
  _userDataPath = p;
}

/**
 * Get the per-workspace user-data directory.
 * After app.setPath('userData', workspaceDir), this returns the workspace dir.
 * Resolution order:
 *   1. Explicitly set via setUserDataPath()
 *   2. Lazy require("electron").app.getPath("userData")
 *   3. Platform-conventional fallback (XDG / Library / AppData)
 */
export function getUserDataPath(): string {
  if (_userDataPath) return _userDataPath;
  try {
    // Lazy require — only succeeds inside Electron
    const { app } = require("electron");
    return app.getPath("userData");
  } catch {
    return platformDefault();
  }
}

/**
 * Get the central NatStack config directory (shared across all workspaces).
 * Always returns ~/.config/natstack/ (or platform equivalent).
 * Never returns Electron's app.getPath('userData') — that may point to a workspace.
 */
export function getCentralDataPath(): string {
  return platformDefault();
}

/** Get the directory containing all managed workspaces. */
export function getWorkspacesDir(): string {
  return path.join(getCentralDataPath(), "workspaces");
}

/** Get the directory for a specific managed workspace by name. */
export function getWorkspaceDir(name: string): string {
  return path.join(getWorkspacesDir(), name);
}

/** Platform-conventional config directory for NatStack. */
function platformDefault(): string {
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
}
