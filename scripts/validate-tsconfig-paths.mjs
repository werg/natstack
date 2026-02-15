#!/usr/bin/env node
/**
 * Validates that all workspace package exports have corresponding
 * tsconfig.json path mappings pointing to source files.
 *
 * Catches the class of bug where a new package or subpath export is added
 * but the root tsconfig.json "paths" block is not updated, causing
 * type-check failures like TS2307 "Cannot find module".
 *
 * Usage:
 *   node scripts/validate-tsconfig-paths.mjs          # check mode (exit 1 on errors)
 *   node scripts/validate-tsconfig-paths.mjs --fix     # auto-add missing entries
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const fix = process.argv.includes("--fix");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Given an export condition value (e.g. "./dist/index.js" or "./dist/index.d.ts"),
 * try to find the corresponding source .ts/.tsx file in the package directory.
 */
function resolveSourceFile(pkgDir, exportValue) {
  if (!exportValue || typeof exportValue !== "string") return null;

  // Normalize: strip leading ./
  let rel = exportValue.replace(/^\.\//, "");

  // Pattern 1: dist/X.{js,d.ts} → src/X.ts
  if (rel.startsWith("dist/")) {
    rel = rel.replace(/^dist\//, "src/");
  }

  // Strip type declaration extension
  rel = rel.replace(/\.d\.ts$/, ".ts").replace(/\.js$/, ".ts");

  for (const ext of ["", "x"]) {
    // Try .ts and .tsx
    const candidate = path.join(pkgDir, rel + ext);
    if (fs.existsSync(candidate)) return candidate;
  }

  // Pattern 2: some packages put sources at root (no src/ dir)
  // Try stripping src/ prefix if the file wasn't found
  const rootRel = rel.replace(/^src\//, "");
  for (const ext of ["", "x"]) {
    const candidate = path.join(pkgDir, rootRel + ext);
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Extract the "types" or "default" value from an export condition.
 * Handles both string exports and conditional exports objects.
 */
function getExportTarget(condition) {
  if (typeof condition === "string") return condition;
  if (typeof condition === "object" && condition !== null) {
    // Prefer types field for finding source
    return condition.types || condition.default || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// 1. Read workspace globs
const wsConfig = fs.readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf-8");
const globs = [...wsConfig.matchAll(/- '([^']+)'/g)].map((m) => m[1]);

// 2. Discover all workspace packages
const pkgDirs = globs.flatMap(expandWorkspaceGlob);

// 3. Packages excluded from type-checking (tsconfig exclude patterns)
const tsconfig = readJson(path.join(ROOT, "tsconfig.json"));
const excludePatterns = (tsconfig.exclude || [])
  .filter((e) => e.startsWith("workspace/packages/"))
  .map((e) => e.replace("workspace/packages/", "").replace("*", ""));

function isExcluded(pkgDirName) {
  return excludePatterns.some((p) => pkgDirName.startsWith(p));
}

// 4. Read current tsconfig paths
const currentPaths = tsconfig.compilerOptions?.paths || {};

// 5. Scan packages and check exports
const missing = [];
const stale = [];
const warnings = [];

for (const pkgDir of pkgDirs) {
  const dirName = path.basename(pkgDir);
  if (isExcluded(dirName)) continue;

  const pkg = readJson(path.join(pkgDir, "package.json"));
  const pkgName = pkg.name;
  if (!pkgName) continue;

  const exports = pkg.exports;
  if (!exports || typeof exports !== "object") {
    // No exports field — check if there's a main/types we should map
    // Skip for now; packages without exports are handled differently
    continue;
  }

  for (const [subpath, condition] of Object.entries(exports)) {
    const target = getExportTarget(condition);
    if (!target) continue;

    // Skip non-JS/TS exports (e.g. "./styles.css")
    if (!target.endsWith(".js") && !target.endsWith(".ts") && !target.endsWith(".d.ts")) continue;

    // Build the import specifier: "@workspace/foo" + "./bar" → "@workspace/foo/bar"
    let specifier;
    if (subpath === ".") {
      specifier = pkgName;
    } else {
      specifier = pkgName + "/" + subpath.replace(/^\.\//, "");
    }

    // Check if tsconfig has this path
    if (currentPaths[specifier]) {
      // Verify the target file exists
      const mapped = currentPaths[specifier][0];
      if (mapped && !fs.existsSync(path.join(ROOT, mapped))) {
        stale.push({ specifier, mapped });
      }
      continue;
    }

    // Missing — try to find the source file
    const sourceFile = resolveSourceFile(pkgDir, target);
    if (sourceFile) {
      const relSource = path.relative(ROOT, sourceFile);
      missing.push({ specifier, source: relSource, pkgDir: path.relative(ROOT, pkgDir) });
    } else {
      // No source file found — this export is likely generated/bundled at build time.
      // Warn but don't fail, since it can't be type-checked from source anyway.
      warnings.push({ specifier, target, pkgDir: path.relative(ROOT, pkgDir) });
    }
  }
}

// 6. Report
let exitCode = 0;

if (stale.length > 0) {
  console.error("\n  Stale tsconfig paths (target file does not exist):\n");
  for (const { specifier, mapped } of stale) {
    console.error(`    "${specifier}" → ${mapped}`);
  }
  exitCode = 1;
}

if (missing.length > 0) {
  if (fix) {
    // Auto-fix: insert missing entries into tsconfig.json preserving format.
    // We insert new lines before the closing "}" of the "paths" block by
    // finding the last existing entry and appending after it.
    const tsconfigPath = path.join(ROOT, "tsconfig.json");
    let content = fs.readFileSync(tsconfigPath, "utf-8");

    // Group entries by parent package so they're inserted near siblings
    for (const { specifier, source } of missing) {
      const newLine = `      "${specifier}": ["${source}"]`;
      // Find the last entry in paths (line before the closing brace of paths)
      const pathsClose = content.indexOf("    }\n  },");
      if (pathsClose === -1) {
        console.error("  Could not find paths closing brace in tsconfig.json");
        process.exit(1);
      }
      // Find the last newline before the closing brace
      const insertPos = content.lastIndexOf("\n", pathsClose - 1);
      // The line at insertPos needs a trailing comma if it doesn't have one
      const lineEnd = content.lastIndexOf("\n", insertPos - 1);
      const lastLine = content.slice(lineEnd + 1, insertPos);
      if (lastLine.trim() && !lastLine.trimEnd().endsWith(",")) {
        content = content.slice(0, insertPos) + "," + content.slice(insertPos);
      }
      // Re-find insertPos after potential comma insertion
      const updatedPathsClose = content.indexOf("    }\n  },");
      const updatedInsertPos = content.lastIndexOf("\n", updatedPathsClose - 1);
      content = content.slice(0, updatedInsertPos) + ",\n" + newLine + content.slice(updatedInsertPos);
    }

    fs.writeFileSync(tsconfigPath, content);
    console.log(`\n  Fixed ${missing.length} missing tsconfig path(s):\n`);
    for (const { specifier, source } of missing) {
      console.log(`    + "${specifier}" → ${source}`);
    }
  } else {
    console.error(`\n  Missing tsconfig path mappings (${missing.length}):\n`);
    for (const { specifier, source } of missing) {
      console.error(`    "${specifier}" → ${source}`);
    }
    console.error("\n  Run with --fix to auto-add missing entries.\n");
    exitCode = 1;
  }
}

if (warnings.length > 0) {
  console.warn(`\n  Skipped ${warnings.length} export(s) with no source file (built/generated):\n`);
  for (const { specifier, target, pkgDir } of warnings) {
    console.warn(`    "${specifier}" (exports: ${target}) in ${pkgDir}`);
  }
}

if (exitCode === 0) {
  const total = Object.keys(currentPaths).length;
  console.log(`\n  All ${total} tsconfig path mappings are valid.\n`);
}

process.exit(exitCode);
