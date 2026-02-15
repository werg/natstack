#!/usr/bin/env node
/**
 * Validates that all workspace packages used in the codebase are declared
 * as root dependencies so pnpm creates symlinks in node_modules/.
 *
 * With the build-before-check approach, TypeScript resolves workspace packages
 * through pnpm symlinks → package.json exports → dist/ type declarations.
 * If a workspace package isn't a root dependency, the symlink won't exist and
 * tsc will fail with TS2307 "Cannot find module".
 *
 * Usage:
 *   node scripts/validate-tsconfig-paths.mjs          # check mode (exit 1 on errors)
 *   node scripts/validate-tsconfig-paths.mjs --fix     # auto-add missing root deps
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const fix = process.argv.includes("--fix");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

/** Expand a simple glob like "packages/*" into directories that contain package.json. */
function expandWorkspaceGlob(pattern) {
  const base = pattern.replace("/*", "");
  const dir = path.join(ROOT, base);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(dir, d.name))
    .filter((d) => fs.existsSync(path.join(d, "package.json")));
}

// ---------------------------------------------------------------------------
// 1. Discover all workspace packages
// ---------------------------------------------------------------------------
const wsConfig = fs.readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf-8");
const globs = [...wsConfig.matchAll(/- '([^']+)'/g)].map((m) => m[1]);
const pkgDirs = globs.flatMap(expandWorkspaceGlob);

// Packages excluded from type-checking
const tsconfig = readJson(path.join(ROOT, "tsconfig.json"));
const excludePatterns = (tsconfig.exclude || [])
  .filter((e) => e.startsWith("workspace/packages/"))
  .map((e) => e.replace("workspace/packages/", "").replace("*", ""));

// Map package names to their directories
const workspacePackages = new Map();
for (const pkgDir of pkgDirs) {
  const dirName = path.basename(pkgDir);
  if (excludePatterns.some((p) => dirName.startsWith(p))) continue;
  const pkg = readJson(path.join(pkgDir, "package.json"));
  if (pkg.name) workspacePackages.set(pkg.name, pkgDir);
}

// ---------------------------------------------------------------------------
// 2. Check which workspace packages are declared as root dependencies
// ---------------------------------------------------------------------------
const rootPkg = readJson(path.join(ROOT, "package.json"));
const rootDeps = {
  ...rootPkg.dependencies,
  ...rootPkg.devDependencies,
};

const missing = [];
for (const [pkgName, pkgDir] of workspacePackages) {
  if (!rootDeps[pkgName]) {
    missing.push({ name: pkgName, dir: path.relative(ROOT, pkgDir) });
  }
}

// ---------------------------------------------------------------------------
// 3. Also verify symlinks exist for declared deps
// ---------------------------------------------------------------------------
const brokenSymlinks = [];
for (const [pkgName] of workspacePackages) {
  if (!rootDeps[pkgName]) continue; // already reported as missing
  const scope = pkgName.startsWith("@") ? pkgName.split("/")[0] : null;
  const bareName = pkgName.startsWith("@") ? pkgName.split("/")[1] : pkgName;
  const symlinkPath = scope
    ? path.join(ROOT, "node_modules", scope, bareName)
    : path.join(ROOT, "node_modules", bareName);
  if (!fs.existsSync(symlinkPath)) {
    brokenSymlinks.push({ name: pkgName, expected: path.relative(ROOT, symlinkPath) });
  }
}

// ---------------------------------------------------------------------------
// 4. Report
// ---------------------------------------------------------------------------
let exitCode = 0;

if (brokenSymlinks.length > 0) {
  console.error("\n  Missing symlinks (run pnpm install):\n");
  for (const { name, expected } of brokenSymlinks) {
    console.error(`    ${name} → ${expected}`);
  }
  exitCode = 1;
}

if (missing.length > 0) {
  if (fix) {
    const rootPkgPath = path.join(ROOT, "package.json");
    let content = fs.readFileSync(rootPkgPath, "utf-8");
    const deps = rootPkg.dependencies || {};
    for (const { name } of missing) {
      deps[name] = "workspace:*";
    }
    // Sort dependencies
    const sorted = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
    rootPkg.dependencies = sorted;
    fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n");
    console.log(`\n  Added ${missing.length} missing root dependency(ies):\n`);
    for (const { name, dir } of missing) {
      console.log(`    + "${name}": "workspace:*"  (${dir})`);
    }
    console.log("\n  Run 'pnpm install' to create symlinks.\n");
  } else {
    console.error(`\n  Workspace packages missing from root dependencies (${missing.length}):\n`);
    for (const { name, dir } of missing) {
      console.error(`    ${name}  (${dir})`);
    }
    console.error("\n  These packages won't have symlinks in node_modules/, causing TS2307 errors.");
    console.error("  Run with --fix to auto-add them, then 'pnpm install'.\n");
    exitCode = 1;
  }
}

if (exitCode === 0) {
  const total = workspacePackages.size;
  console.log(`\n  All ${total} workspace packages are declared as root dependencies.\n`);
}

process.exit(exitCode);
