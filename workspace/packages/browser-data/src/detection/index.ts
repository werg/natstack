import * as fs from "fs";
import type { DetectedBrowser } from "../types.js";
import { BROWSER_PATHS, getBrowserDataDir } from "./paths.js";
import { detectFirefoxProfiles, detectFirefoxVersion } from "./firefox.js";
import { detectChromiumProfiles, detectChromiumVersion } from "./chromium.js";
import { detectSafari } from "./safari.js";

/**
 * Detect all installed browsers on the current system.
 *
 * Scans platform-specific paths for every known browser, enumerates profiles,
 * and returns a list of DetectedBrowser objects. Detection errors are non-fatal:
 * a browser that can't be read is excluded from results.
 */
export function detectBrowsers(): DetectedBrowser[] {
  const browsers: DetectedBrowser[] = [];

  for (const entry of BROWSER_PATHS) {
    try {
      // Safari is special
      if (entry.name === "safari") {
        const result = detectSafari();
        if (result.profiles.length > 0) {
          browsers.push({
            name: "safari",
            family: "safari",
            displayName: "Safari",
            dataDir: result.profiles[0]!.path,
            profiles: result.profiles,
            tccBlocked: result.tccBlocked || undefined,
          });
        }
        continue;
      }

      const dataDir = getBrowserDataDir(entry);
      if (!dataDir || !fs.existsSync(dataDir)) continue;

      let profiles;
      let version: string | undefined;

      if (entry.family === "firefox") {
        profiles = detectFirefoxProfiles(dataDir);
        version = detectFirefoxVersion(dataDir);
      } else {
        profiles = detectChromiumProfiles(dataDir);
        version = detectChromiumVersion(dataDir);
      }

      if (profiles.length === 0) continue;

      browsers.push({
        name: entry.name,
        family: entry.family,
        displayName: entry.displayName,
        version,
        dataDir,
        profiles,
      });
    } catch {
      // Non-fatal: skip this browser
    }
  }

  return browsers;
}
