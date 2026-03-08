import * as fs from "fs";
import * as path from "path";
import type { DetectedProfile } from "../types.js";

/**
 * Detect Chromium-family browser profiles.
 *
 * Strategy:
 * 1. Parse `Local State` JSON -> `profile.info_cache` for profile metadata.
 * 2. Fallback: scan for `Default`, `Profile 1`, `Profile 2`, ... directories
 *    that contain a `Preferences` file.
 */
export function detectChromiumProfiles(dataDir: string): DetectedProfile[] {
  const localStatePath = path.join(dataDir, "Local State");

  if (fs.existsSync(localStatePath)) {
    try {
      const localState = JSON.parse(fs.readFileSync(localStatePath, "utf-8"));
      const infoCache = localState?.profile?.info_cache;
      if (infoCache && typeof infoCache === "object") {
        return parseInfoCache(infoCache, dataDir);
      }
    } catch {
      // Fall through to directory scanning
    }
  }

  return scanProfileDirectories(dataDir);
}

function parseInfoCache(
  infoCache: Record<string, { name?: string; gaia_name?: string; is_using_default_name?: boolean; shortcut_name?: string }>,
  dataDir: string,
): DetectedProfile[] {
  const profiles: DetectedProfile[] = [];

  for (const [dirName, info] of Object.entries(infoCache)) {
    const profilePath = path.join(dataDir, dirName);
    if (!fs.existsSync(profilePath)) continue;

    const displayName =
      info.gaia_name || info.name || info.shortcut_name || dirName;

    profiles.push({
      id: dirName,
      displayName,
      path: profilePath,
      isDefault: dirName === "Default",
    });
  }

  // If no profile is marked default but profiles exist, mark first
  if (profiles.length > 0 && !profiles.some((p) => p.isDefault)) {
    profiles[0]!.isDefault = true;
  }

  return profiles;
}

function scanProfileDirectories(dataDir: string): DetectedProfile[] {
  const profiles: DetectedProfile[] = [];

  // Check Default profile
  const defaultPath = path.join(dataDir, "Default");
  if (
    fs.existsSync(defaultPath) &&
    fs.existsSync(path.join(defaultPath, "Preferences"))
  ) {
    profiles.push({
      id: "Default",
      displayName: "Default",
      path: defaultPath,
      isDefault: true,
    });
  }

  // Scan Profile N directories
  try {
    const entries = fs.readdirSync(dataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(/^Profile (\d+)$/);
      if (!match) continue;

      const profilePath = path.join(dataDir, entry.name);
      if (fs.existsSync(path.join(profilePath, "Preferences"))) {
        profiles.push({
          id: entry.name,
          displayName: `Profile ${match[1]}`,
          path: profilePath,
          isDefault: false,
        });
      }
    }
  } catch {
    // Directory not readable
  }

  return profiles;
}

/**
 * Try to read browser version from Local State.
 */
export function detectChromiumVersion(dataDir: string): string | undefined {
  try {
    const localStatePath = path.join(dataDir, "Local State");
    if (!fs.existsSync(localStatePath)) return undefined;
    const localState = JSON.parse(fs.readFileSync(localStatePath, "utf-8"));
    // Some Chromium browsers store version in different places
    return localState?.browser?.last_version || undefined;
  } catch {
    return undefined;
  }
}
