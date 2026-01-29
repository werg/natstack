#!/usr/bin/env node
/**
 * Verify native modules are properly built for the current platform.
 * Run: node scripts/verify-native-modules.mjs
 */

import { createRequire } from "module";
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

const require = createRequire(import.meta.url);

console.log("Native Module Verification");
console.log("=".repeat(50));
console.log(`Platform: ${process.platform}`);
console.log(`Architecture: ${process.arch}`);
console.log(`Node.js: ${process.version}`);

// Get Electron version
let electronVersion = "unknown";
try {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
  electronVersion = pkg.devDependencies?.electron || pkg.dependencies?.electron || "unknown";
  console.log(`Electron: ${electronVersion}`);
} catch {
  // ignore
}

// Get Electron's node version
try {
  const electronNodeVersion = execSync(`npx electron -e "console.log(process.versions.node)"`, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  console.log(`Electron Node.js: v${electronNodeVersion}`);
} catch (e) {
  console.log(`Electron Node.js: (could not determine)`);
}

console.log("=".repeat(50));
console.log("");

const modules = [
  {
    name: "better-sqlite3",
    test: (mod) => {
      const db = new mod(":memory:");
      db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY)");
      db.exec("INSERT INTO test VALUES (1)");
      const row = db.prepare("SELECT * FROM test").get();
      db.close();
      return row && row.id === 1;
    },
  },
  {
    name: "esbuild",
    test: async (mod) => {
      const result = await mod.transform("const x = 1", { loader: "js" });
      return result && result.code.includes("x");
    },
  },
];

let allPassed = true;

for (const { name, test } of modules) {
  process.stdout.write(`Testing ${name}... `);
  try {
    const mod = require(name);
    const result = await test(mod);
    if (result) {
      console.log("\x1b[32mOK\x1b[0m");
    } else {
      console.log("\x1b[31mFAILED\x1b[0m (test returned false)");
      allPassed = false;
    }
  } catch (error) {
    console.log("\x1b[31mFAILED\x1b[0m");
    console.log(`  Error: ${error.message}`);
    if (error.message.includes("was compiled against a different Node.js version")) {
      console.log("  \x1b[33mHint: Run 'pnpm postinstall' or 'npx electron-rebuild -f'\x1b[0m");
    }
    allPassed = false;
  }
}

console.log("");
console.log("=".repeat(50));

if (allPassed) {
  console.log("\x1b[32mAll native modules OK!\x1b[0m");
  process.exit(0);
} else {
  console.log("\x1b[31mSome native modules failed.\x1b[0m");
  console.log("");
  console.log("To fix, try:");
  console.log("  1. pnpm postinstall");
  console.log("  2. npx electron-rebuild -f");
  console.log("  3. rm -rf node_modules && pnpm install");
  process.exit(1);
}
