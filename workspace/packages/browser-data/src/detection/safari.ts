import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { DetectedProfile } from "../types.js";

/**
 * Detect Safari browser (macOS only, single profile).
 *
 * Safari data is split across:
 *   ~/Library/Safari/ (bookmarks, history, preferences)
 *   ~/Library/Cookies/ (cookies)
 *
 * Since macOS Mojave (10.14), Safari data is TCC-protected and requires
 * Full Disk Access. On EPERM, we return `tccBlocked: true`.
 */
export function detectSafari(): {
  profiles: DetectedProfile[];
  tccBlocked: boolean;
} {
  if (process.platform !== "darwin") {
    return { profiles: [], tccBlocked: false };
  }

  const safariDir = path.join(os.homedir(), "Library", "Safari");

  if (!fs.existsSync(safariDir)) {
    return { profiles: [], tccBlocked: false };
  }

  // Check TCC access by trying to read the directory
  try {
    fs.readdirSync(safariDir);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "EPERM" || error.code === "EACCES") {
      return {
        profiles: [
          {
            id: "default",
            displayName: "Default",
            path: safariDir,
            isDefault: true,
          },
        ],
        tccBlocked: true,
      };
    }
    return { profiles: [], tccBlocked: false };
  }

  return {
    profiles: [
      {
        id: "default",
        displayName: "Default",
        path: safariDir,
        isDefault: true,
      },
    ],
    tccBlocked: false,
  };
}
