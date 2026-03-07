import * as path from "path";
import * as os from "os";

let _userDataPath: string | null = null;

/** Explicitly set the user-data directory (for headless/test use). */
export function setUserDataPath(p: string): void {
  _userDataPath = p;
}

/**
 * Get the platform-specific user-data directory.
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

/** Mirrors the fallback logic already in paths.ts and loader.ts */
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
