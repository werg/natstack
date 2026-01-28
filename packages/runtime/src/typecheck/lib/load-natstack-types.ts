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

function readDtsFiles(dir: string, baseDir: string = dir): Map<string, string> {
  const files = new Map<string, string>();
  if (!fs.existsSync(dir)) return files;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      const subFiles = readDtsFiles(fullPath, baseDir);
      for (const [subPath, content] of subFiles) {
        files.set(subPath, content);
      }
    } else if (entry.name.endsWith(".d.ts") && !entry.name.endsWith(".d.ts.map")) {
      const content = fs.readFileSync(fullPath, "utf-8");
      files.set(relativePath, content);
    }
  }
  return files;
}

function loadPackageTypes(packagesDir: string, pkgName: string): NatstackPackageTypes | null {
  const pkgDir = path.join(packagesDir, pkgName);
  const pkgJsonPath = path.join(pkgDir, "package.json");

  if (!fs.existsSync(pkgJsonPath)) return null;

  let pkgJson: PackageJson;
  try {
    pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as PackageJson;
  } catch {
    return null;
  }

  const distDir = path.join(pkgDir, "dist");
  if (!fs.existsSync(distDir)) return null;

  const dtsFiles = readDtsFiles(distDir);
  if (dtsFiles.size === 0) return null;

  const files: Record<string, string> = {};
  for (const [filePath, content] of dtsFiles) {
    files[filePath] = content;
  }

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

export function loadNatstackPackageTypes(packagesDir: string): Record<string, NatstackPackageTypes> {
  const result: Record<string, NatstackPackageTypes> = {};
  for (const pkgName of PACKAGES_TO_LOAD) {
    const types = loadPackageTypes(packagesDir, pkgName);
    if (types) {
      result[`@natstack/${pkgName}`] = types;
    }
  }
  return result;
}

export function loadSinglePackageTypes(packagesDir: string, packageName: string): NatstackPackageTypes | null {
  const shortName = packageName.replace("@natstack/", "");
  return loadPackageTypes(packagesDir, shortName);
}

export function findPackagesDir(workspaceRoot: string): string | null {
  const directPath = path.join(workspaceRoot, "packages");
  if (fs.existsSync(directPath)) return directPath;

  const parentPath = path.join(path.dirname(workspaceRoot), "packages");
  if (fs.existsSync(parentPath)) return parentPath;

  return null;
}
