#!/usr/bin/env node
/**
 * Type-check all panel projects
 *
 * This script validates TypeScript in each panel directory, similar to how the IDE
 * would check them. It ensures panel code is type-correct before runtime.
 *
 * Usage:
 *   pnpm type-check:panels              # Check all panels
 *   node scripts/type-check-panels.mjs   # Direct invocation
 *
 * Note: This is separate from the main build process, which already catches esbuild
 * errors but may not provide full type information. This script provides stricter
 * validation during development.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const panelsDir = path.join(__dirname, "../panels");

// Find all panel directories with tsconfig.json
const panelDirs = fs
  .readdirSync(panelsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => {
    const tsconfigPath = path.join(panelsDir, name, "tsconfig.json");
    return fs.existsSync(tsconfigPath);
  });

if (panelDirs.length === 0) {
  console.log("✓ No panels with tsconfig.json found");
  process.exit(0);
}

console.log(`Type-checking ${panelDirs.length} panel(s)...\n`);

let hasErrors = false;
const results = [];

for (const panelName of panelDirs) {
  const panelPath = path.join(panelsDir, panelName);
  const tsconfigPath = path.join(panelPath, "tsconfig.json");

  try {
    console.log(`Checking: ${panelName}...`);
    execSync(`tsc --noEmit --project "${tsconfigPath}"`, {
      stdio: "pipe",
      encoding: "utf-8",
    });
    console.log(`  ✓ OK\n`);
    results.push({ panel: panelName, status: "pass" });
  } catch (error) {
    hasErrors = true;
    console.log(`  ✗ FAILED\n`);
    if (error.stdout) console.log(error.stdout);
    if (error.stderr) console.error(error.stderr);
    results.push({ panel: panelName, status: "fail" });
  }
}

// Summary
console.log("━".repeat(50));
const passCount = results.filter((r) => r.status === "pass").length;
const failCount = results.filter((r) => r.status === "fail").length;
console.log(`Results: ${passCount} passed, ${failCount} failed out of ${results.length}`);
console.log("━".repeat(50));

if (hasErrors) {
  process.exit(1);
}

console.log("\n✓ All panels type-check passed!");
