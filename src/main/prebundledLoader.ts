/**
 * Load pre-bundled @natstack/* packages for injection into panel runtime
 *
 * These bundles are created at build time by scripts/prebundle-packages.mjs
 * and are used by panels that build children using @natstack/build
 */

import * as fs from "fs";
import * as path from "path";

export interface PrebundledPackages {
  core: {
    [packageName: string]: string;
  };
  optional: {
    [packageName: string]: string;
  };
}

export interface PrebundledManifest {
  version: string;
  timestamp: string;
  packageVersions: Record<string, string>;
  bundles: PrebundledPackages;
}

let cachedPrebundled: Record<string, string> | null = null;
let cachedVersion: string | null = null;

/**
 * Load pre-bundled packages from the dist directory
 * Returns a flattened map of all packages (core + optional) for backwards compatibility
 */
export function loadPrebundledPackages(): Record<string, string> {
  if (cachedPrebundled) {
    return cachedPrebundled;
  }

  const prebundledPath = path.join(__dirname, "prebundled-packages.json");

  if (!fs.existsSync(prebundledPath)) {
    console.warn(
      "[Prebundled] prebundled-packages.json not found. In-panel builds may not work correctly."
    );
    return {};
  }

  try {
    const content = fs.readFileSync(prebundledPath, "utf-8");
    const manifest = JSON.parse(content) as PrebundledManifest;

    // Cache version for invalidation checks
    cachedVersion = manifest.version;

    // Flatten core + optional into a single map for panel runtime
    cachedPrebundled = {
      ...manifest.bundles.core,
      ...manifest.bundles.optional,
    };

    const coreCount = Object.keys(manifest.bundles.core).length;
    const optionalCount = Object.keys(manifest.bundles.optional).length;

    console.log(
      `[Prebundled] Loaded ${coreCount} core + ${optionalCount} optional packages ` +
      `(version: ${manifest.version})`
    );
    return cachedPrebundled;
  } catch (error) {
    console.error("[Prebundled] Failed to load pre-bundled packages:", error);
    return {};
  }
}

/**
 * Get the current prebundled packages version hash
 * Used for cache invalidation
 */
export function getPrebundledVersion(): string | null {
  if (!cachedVersion) {
    loadPrebundledPackages(); // Load if not already loaded
  }
  return cachedVersion;
}

/**
 * Get the pre-bundled packages as a serialized JSON string
 * Suitable for injection into panel preload
 */
export function getPrebundledPackagesJson(): string {
  const packages = loadPrebundledPackages();
  return JSON.stringify(packages);
}
