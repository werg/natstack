/**
 * Dynamic loader for natstack package type definitions.
 * Loads types from packages/x/dist/ at runtime.
 */

import * as fs from "fs";
import * as path from "path";

const PACKAGES_TO_LOAD = [
  "runtime",
  "ai",
  "eval",
  "git",
  "git-ui",
  "react",
  "rpc",
  "pubsub",
  "agentic-messaging",
  "playwright-client",
  "playwright-core",
  "playwright-protocol",
  "tool-ui",
] as const;

export interface NatstackPackageTypes {
  files: Record<string, string>;
  subpaths: Record<string, string>;
}

interface PackageExports {
  [subpath: string]: { types?: string; default?: string } | string;
}

interface PackageJson {
  name: string;
  types?: string;
  typings?: string;
  exports?: PackageExports;
}

/** Module-level cache for loadNatstackPackageTypes results, keyed by packagesDir */
const natstackTypesCache = new Map<string, Record<string, NatstackPackageTypes>>();

/**
 * Get @natstack/* package types from the pre-warmed cache.
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
 * Get types for a single @natstack/* package from the pre-warmed cache.
 *
 * IMPORTANT: Call preloadNatstackTypesAsync() at app startup before using this.
 */
export function loadSinglePackageTypes(packagesDir: string, packageName: string): NatstackPackageTypes | null {
  const allTypes = loadNatstackPackageTypes(packagesDir);
  const fullName = packageName.startsWith("@natstack/") ? packageName : `@natstack/${packageName}`;
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

  // Load all packages in parallel
  const loadResults = await Promise.all(
    PACKAGES_TO_LOAD.map(async (pkgName) => {
      const types = await loadPackageTypesAsync(packagesDir, pkgName);
      return { pkgName, types };
    })
  );

  const result: Record<string, NatstackPackageTypes> = {};
  for (const { pkgName, types } of loadResults) {
    if (types) {
      result[`@natstack/${pkgName}`] = types;
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
    for (const [exportPath, exportConfig] of Object.entries(pkgJson.exports)) {
      if (exportPath === ".") continue;

      let typesPath: string | undefined;
      if (typeof exportConfig === "string") {
        typesPath = exportConfig;
      } else if (exportConfig.types) {
        typesPath = exportConfig.types;
      }

      if (typesPath) {
        const relativePath = typesPath.replace(/^\.\/dist\//, "");
        subpaths[exportPath] = relativePath;
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
