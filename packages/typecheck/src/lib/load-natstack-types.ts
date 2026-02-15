/**
 * Dynamic loader for natstack package type definitions.
 * Loads types from packages/x/dist/ at runtime.
 */

import * as fs from "fs";
import * as path from "path";
import { resolveExportSubpath, TYPES_CONDITIONS } from "../resolution.js";

/**
 * Discover @workspace/* packages by scanning the packages directory.
 * Returns directory names that contain a package.json.
 */
async function discoverPackages(packagesDir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(packagesDir, { withFileTypes: true });
    const checks = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          try {
            await fs.promises.access(path.join(packagesDir, e.name, "package.json"));
            return e.name;
          } catch {
            return null;
          }
        })
    );
    return checks.filter((name): name is string => name !== null);
  } catch {
    return [];
  }
}

export interface NatstackPackageTypes {
  files: Record<string, string>;
  subpaths: Record<string, string>;
}

interface PackageJson {
  name: string;
  types?: string;
  typings?: string;
  exports?: Record<string, string | Record<string, string>>;
}

/** Module-level cache for loadNatstackPackageTypes results, keyed by packagesDir */
const natstackTypesCache = new Map<string, Record<string, NatstackPackageTypes>>();

/**
 * Get @workspace/* package types from the pre-warmed cache.
 *
 * IMPORTANT: Call preloadNatstackTypesAsync() at app startup before using this.
 * If the cache is cold, returns empty object and logs a warning.
 */
export function loadNatstackPackageTypes(packagesDir: string): Record<string, NatstackPackageTypes> {
  const cached = natstackTypesCache.get(packagesDir);
  if (cached) return cached;

  // Cache miss - preload wasn't called or used different path
  console.warn(
    `[loadNatstackPackageTypes] Cache miss for "${packagesDir}". ` +
    `Call preloadNatstackTypesAsync() at startup to avoid this warning.`
  );
  return {};
}

/**
 * Clear the loadNatstackPackageTypes cache.
 * Call when workspace packages change (e.g., after Verdaccio republish).
 */
export function clearNatstackTypesCache(): void {
  natstackTypesCache.clear();
}

/**
 * Get types for a single @workspace/* package from the pre-warmed cache.
 *
 * IMPORTANT: Call preloadNatstackTypesAsync() at app startup before using this.
 */
export function loadSinglePackageTypes(packagesDir: string, packageName: string): NatstackPackageTypes | null {
  const allTypes = loadNatstackPackageTypes(packagesDir);
  const fullName = packageName.startsWith("@workspace/") ? packageName : `@workspace/${packageName}`;
  return allTypes[fullName] ?? null;
}

// =============================================================================
// Async Preloader Functions
// =============================================================================

/**
 * Async preloader - call at app startup to warm the cache.
 * After this completes, loadNatstackPackageTypes() returns instantly from cache.
 */
export async function preloadNatstackTypesAsync(packagesDir: string): Promise<void> {
  if (natstackTypesCache.has(packagesDir)) return;

  // Discover and load all packages in parallel
  const packageNames = await discoverPackages(packagesDir);
  const loadResults = await Promise.all(
    packageNames.map(async (pkgName) => {
      const types = await loadPackageTypesAsync(packagesDir, pkgName);
      return { pkgName, types };
    })
  );

  const result: Record<string, NatstackPackageTypes> = {};
  for (const { pkgName, types } of loadResults) {
    if (types) {
      result[`@workspace/${pkgName}`] = types;
    }
  }

  natstackTypesCache.set(packagesDir, result);
}

async function loadPackageTypesAsync(
  packagesDir: string,
  pkgName: string
): Promise<NatstackPackageTypes | null> {
  const pkgDir = path.join(packagesDir, pkgName);
  const pkgJsonPath = path.join(pkgDir, "package.json");

  try {
    await fs.promises.access(pkgJsonPath);
  } catch {
    return null;
  }

  let pkgJson: PackageJson;
  try {
    pkgJson = JSON.parse(
      await fs.promises.readFile(pkgJsonPath, "utf-8")
    ) as PackageJson;
  } catch {
    return null;
  }

  const distDir = path.join(pkgDir, "dist");
  const dtsFiles = await readDtsFilesAsync(distDir);
  if (dtsFiles.size === 0) return null;

  const files: Record<string, string> = {};
  for (const [filePath, content] of dtsFiles) {
    files[filePath] = content;
  }

  // Build subpaths from package.json exports
  const subpaths: Record<string, string> = {};
  if (pkgJson.exports) {
    for (const exportPath of Object.keys(pkgJson.exports)) {
      if (exportPath === ".") continue;
      const typesPath = resolveExportSubpath(pkgJson.exports as Record<string, unknown>, exportPath, TYPES_CONDITIONS);
      if (typesPath && /\.d\.[cm]?ts$/.test(typesPath)) {
        subpaths[exportPath] = typesPath.replace(/^\.\/dist\//, "");
      }
    }
  }

  return { files, subpaths };
}

async function readDtsFilesAsync(
  dir: string,
  baseDir: string = dir
): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    // Directory doesn't exist
    return files;
  }

  // Process all entries in parallel
  const results = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(baseDir, fullPath);

      if (entry.isDirectory()) {
        return { type: "dir" as const, subFiles: await readDtsFilesAsync(fullPath, baseDir) };
      } else if (entry.name.endsWith(".d.ts") && !entry.name.endsWith(".d.ts.map")) {
        const content = await fs.promises.readFile(fullPath, "utf-8");
        return { type: "file" as const, relativePath, content };
      }
      return null;
    })
  );

  // Merge results
  for (const result of results) {
    if (!result) continue;
    if (result.type === "dir") {
      for (const [subPath, content] of result.subFiles) {
        files.set(subPath, content);
      }
    } else {
      files.set(result.relativePath, result.content);
    }
  }

  return files;
}

export function findPackagesDir(workspaceRoot: string): string | null {
  const directPath = path.join(workspaceRoot, "packages");
  if (fs.existsSync(directPath)) return directPath;

  const parentPath = path.join(path.dirname(workspaceRoot), "packages");
  if (fs.existsSync(parentPath)) return parentPath;

  return null;
}
