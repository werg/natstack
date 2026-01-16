/**
 * Script to bundle @natstack/* package type definitions for the type checker.
 *
 * Run with: npx tsx scripts/bundle-natstack-types.ts
 *
 * This extracts .d.ts files from all @natstack/* packages (except runtime,
 * which has its own bundled types) and generates a TypeScript module that
 * exports them as strings. This allows the TypeCheckService to provide
 * accurate types for internal packages without network or filesystem access.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = path.resolve(__dirname, "../../"); // monorepo packages/
const OUTPUT_FILE = path.resolve(__dirname, "../src/typecheck/lib/natstack-packages.ts");

// Packages to bundle (skip runtime - already has NATSTACK_RUNTIME_TYPES)
// Also skip playwright-injected as it has no exported types
const PACKAGES_TO_BUNDLE = [
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
];

interface PackageExports {
  [subpath: string]: {
    types?: string;
    default?: string;
  } | string;
}

interface PackageJson {
  name: string;
  types?: string;
  typings?: string;
  exports?: PackageExports;
}

/**
 * Read all .d.ts files from a directory recursively.
 */
function readDtsFiles(dir: string, baseDir: string = dir): Map<string, string> {
  const files = new Map<string, string>();

  if (!fs.existsSync(dir)) {
    return files;
  }

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

/**
 * Bundle a single package's type definitions.
 */
function bundlePackage(pkgName: string): { files: Record<string, string>; subpaths: Record<string, string> } | null {
  const pkgDir = path.join(PACKAGES_DIR, pkgName);
  const pkgJsonPath = path.join(pkgDir, "package.json");

  if (!fs.existsSync(pkgJsonPath)) {
    console.warn(`  Warning: ${pkgName} package.json not found, skipping`);
    return null;
  }

  const pkgJson: PackageJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  const distDir = path.join(pkgDir, "dist");

  if (!fs.existsSync(distDir)) {
    console.warn(`  Warning: ${pkgName}/dist not found, skipping`);
    return null;
  }

  // Read all .d.ts files from dist/
  const dtsFiles = readDtsFiles(distDir);

  if (dtsFiles.size === 0) {
    console.warn(`  Warning: No .d.ts files found in ${pkgName}/dist, skipping`);
    return null;
  }

  const files: Record<string, string> = {};
  for (const [filePath, content] of dtsFiles) {
    files[filePath] = content;
  }

  // Parse exports to map subpaths to their entry files
  const subpaths: Record<string, string> = {};

  if (pkgJson.exports) {
    for (const [exportPath, exportConfig] of Object.entries(pkgJson.exports)) {
      if (exportPath === ".") continue; // Main export handled by index.d.ts

      let typesPath: string | undefined;
      if (typeof exportConfig === "string") {
        typesPath = exportConfig;
      } else if (exportConfig.types) {
        typesPath = exportConfig.types;
      }

      if (typesPath) {
        // Convert ./dist/foo.d.ts to foo.d.ts
        const relativePath = typesPath.replace(/^\.\/dist\//, "");
        // Map subpath (e.g., "/broker") to entry file
        subpaths[exportPath] = relativePath;
      }
    }
  }

  return { files, subpaths };
}

function main(): void {
  console.log("Bundling @natstack/* package types...\n");

  const result: Record<string, { files: Record<string, string>; subpaths: Record<string, string> }> = {};
  let totalFiles = 0;
  let totalSize = 0;

  for (const pkgName of PACKAGES_TO_BUNDLE) {
    const bundled = bundlePackage(pkgName);

    if (bundled) {
      const fullPkgName = `@natstack/${pkgName}`;
      result[fullPkgName] = bundled;

      const fileCount = Object.keys(bundled.files).length;
      const pkgSize = Object.values(bundled.files).reduce((sum, content) => sum + content.length, 0);
      totalFiles += fileCount;
      totalSize += pkgSize;

      const subpathInfo = Object.keys(bundled.subpaths).length > 0
        ? ` (subpaths: ${Object.keys(bundled.subpaths).join(", ")})`
        : "";

      console.log(`  ${fullPkgName}: ${fileCount} files, ${(pkgSize / 1024).toFixed(1)}KB${subpathInfo}`);
    }
  }

  // Generate TypeScript file
  const outputLines: string[] = [
    "/**",
    " * Bundled @natstack/* package type definitions for the type checker.",
    " *",
    " * AUTO-GENERATED by scripts/bundle-natstack-types.ts",
    " * Do not edit manually.",
    " *",
    " * Run: pnpm run bundle-types to regenerate",
    " */",
    "",
    "export interface NatstackPackageTypes {",
    "  /** Map of file paths to their contents */",
    "  files: Record<string, string>;",
    "  /** Map of subpath exports (e.g., '/broker') to their entry .d.ts file */",
    "  subpaths: Record<string, string>;",
    "}",
    "",
    "export const NATSTACK_PACKAGE_TYPES: Record<string, NatstackPackageTypes> = ",
  ];

  // Use JSON.stringify with proper formatting
  outputLines.push(JSON.stringify(result, null, 2) + ";");
  outputLines.push("");

  fs.writeFileSync(OUTPUT_FILE, outputLines.join("\n"));

  console.log(`\nGenerated ${OUTPUT_FILE}`);
  console.log(`Total: ${totalFiles} files, ${(totalSize / 1024).toFixed(1)}KB bundled`);
  console.log(`Bundled ${Object.keys(result).length} packages`);
}

main();
