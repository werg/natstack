#!/usr/bin/env node
/**
 * Verify native modules work within Electron's Node.js environment.
 * Run: node scripts/verify-electron-native.mjs
 */

import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

// Create a temporary script file in the project directory so require() works
const tempScript = path.join(rootDir, `.verify-native-temp-${Date.now()}.cjs`);

const scriptContent = `
const { app } = require("electron");

async function main() {
  console.log("Native Module Verification (Electron)");
  console.log("==================================================");
  console.log("Platform:", process.platform);
  console.log("Architecture:", process.arch);
  console.log("Electron:", process.versions.electron);
  console.log("Node.js:", process.versions.node);
  console.log("==================================================");
  console.log("");

  const modules = [
    {
      name: "better-sqlite3",
      test: async () => {
        const Database = require("better-sqlite3");
        const db = new Database(":memory:");
        db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY)");
        db.exec("INSERT INTO test VALUES (1)");
        const row = db.prepare("SELECT * FROM test").get();
        db.close();
        return row && row.id === 1;
      },
    },
    {
      name: "esbuild",
      test: async () => {
        const esbuild = require("esbuild");
        const result = await esbuild.transform("const x = 1", { loader: "js" });
        return result && result.code.includes("x");
      },
    },
  ];

  let allPassed = true;

  for (const { name, test } of modules) {
    process.stdout.write("Testing " + name + "... ");
    try {
      const result = await test();
      if (result) {
        console.log("\\x1b[32mOK\\x1b[0m");
      } else {
        console.log("\\x1b[31mFAILED\\x1b[0m (test returned false)");
        allPassed = false;
      }
    } catch (error) {
      console.log("\\x1b[31mFAILED\\x1b[0m");
      console.log("  Error:", error.message);
      allPassed = false;
    }
  }

  console.log("");
  console.log("==================================================");

  if (allPassed) {
    console.log("\\x1b[32mAll native modules OK!\\x1b[0m");
    app.exit(0);
  } else {
    console.log("\\x1b[31mSome native modules failed.\\x1b[0m");
    console.log("");
    console.log("To fix, try:");
    console.log("  pnpm postinstall");
    app.exit(1);
  }
}

app.whenReady().then(main).catch((e) => {
  console.error("Error:", e);
  app.exit(1);
});
`;

// Write the temporary script
fs.writeFileSync(tempScript, scriptContent, "utf-8");

// Run the script with Electron
const electron = spawn("npx", ["electron", tempScript], {
  cwd: rootDir,
  stdio: "inherit",
});

electron.on("close", (code) => {
  // Clean up temp file
  try {
    fs.unlinkSync(tempScript);
  } catch {
    // ignore
  }
  process.exit(code || 0);
});

electron.on("error", (err) => {
  console.error("Failed to start Electron:", err.message);
  console.log("");
  console.log("Make sure Electron is installed: pnpm install");
  try {
    fs.unlinkSync(tempScript);
  } catch {
    // ignore
  }
  process.exit(1);
});
