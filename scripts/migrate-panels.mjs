#!/usr/bin/env node
/**
 * Migration script: panel.json → package.json with natstack field
 *
 * Converts all panels from the old panel.json format to package.json
 * with the natstack configuration field.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PANELS_DIR = path.resolve(__dirname, "../panels");

function migratePanelJson(panelDir) {
  const panelJsonPath = path.join(panelDir, "panel.json");
  const packageJsonPath = path.join(panelDir, "package.json");

  if (!fs.existsSync(panelJsonPath)) {
    console.log(`⏭️  Skipping ${path.basename(panelDir)} - no panel.json found`);
    return;
  }

  if (fs.existsSync(packageJsonPath)) {
    console.log(`⚠️  ${path.basename(panelDir)} - package.json already exists, skipping`);
    return;
  }

  const panelJson = JSON.parse(fs.readFileSync(panelJsonPath, "utf-8"));
  const panelName = path.basename(panelDir);

  // Extract dependencies and natstack-specific config
  const { dependencies = {}, ...natstackConfig } = panelJson;

  // Add workspace packages to dependencies
  const packageDependencies = {
    "@natstack/core": "workspace:*",
    "@natstack/react": "workspace:*",
    ...dependencies,
  };

  // Check if panel uses AI SDK
  const panelFiles = fs.readdirSync(panelDir);
  const hasAiImports = panelFiles.some((file) => {
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) return false;
    const content = fs.readFileSync(path.join(panelDir, file), "utf-8");
    return content.includes("@natstack/ai") || content.includes("natstack/ai");
  });

  if (hasAiImports) {
    packageDependencies["@natstack/ai"] = "workspace:*";
  }

  const packageJson = {
    name: `@natstack-panels/${panelName}`,
    version: "0.1.0",
    private: true,
    type: "module",
    natstack: natstackConfig,
    dependencies: packageDependencies,
  };

  // Write package.json
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");

  // Delete panel.json
  fs.unlinkSync(panelJsonPath);

  console.log(`✅ Migrated ${panelName}`);
  console.log(`   - Title: ${natstackConfig.title}`);
  console.log(`   - Entry: ${natstackConfig.entry || "(auto-detect)"}`);
  console.log(`   - Dependencies: ${Object.keys(packageDependencies).join(", ")}`);
}

function main() {
  console.log("🔄 Migrating panels from panel.json to package.json...\n");

  if (!fs.existsSync(PANELS_DIR)) {
    console.error(`❌ Panels directory not found: ${PANELS_DIR}`);
    process.exit(1);
  }

  const panels = fs.readdirSync(PANELS_DIR).filter((name) => {
    const panelPath = path.join(PANELS_DIR, name);
    return fs.statSync(panelPath).isDirectory();
  });

  if (panels.length === 0) {
    console.log("No panels found to migrate.");
    return;
  }

  for (const panelName of panels) {
    const panelDir = path.join(PANELS_DIR, panelName);
    migratePanelJson(panelDir);
  }

  console.log("\n✨ Migration complete!");
}

main();
