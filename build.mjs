import * as esbuild from "esbuild";
import typiaPlugin from "@ryoppippi/unplugin-typia/esbuild";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const isDev = process.env.NODE_ENV === "development";

const typiaPlugins = [
  typiaPlugin({
    tsconfig: "tsconfig.json",
    cache: true,
    log: false,
  }),
];

const logOverride = {
  "suspicious-logical-operator": "silent",
};

const mainConfig = {
  entryPoints: ["src/main/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/main.cjs",
  external: ["electron", "esbuild", "@npmcli/arborist", "isolated-vm", "better-sqlite3"],
  sourcemap: isDev,
  minify: !isDev,
  plugins: typiaPlugins,
  logOverride,
};

const preloadConfig = {
  entryPoints: ["src/preload/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/preload.cjs",
  external: ["electron"],
  sourcemap: isDev,
  minify: !isDev,
  plugins: typiaPlugins,
  logOverride,
};

const panelPreloadConfig = {
  entryPoints: ["src/preload/panelPreload.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/panelPreload.cjs",
  external: ["electron"],
  sourcemap: isDev,
  minify: !isDev,
  plugins: typiaPlugins,
  logOverride,
};

const rendererConfig = {
  entryPoints: ["src/renderer/index.tsx"],
  bundle: true,
  platform: "browser",
  target: "es2020",
  outfile: "dist/renderer.js",
  sourcemap: isDev,
  minify: !isDev,
  plugins: typiaPlugins,
  logOverride,
  loader: {
    ".html": "text",
    ".css": "css",
  },
};

// =============================================================================
// Worker-related build configs
// =============================================================================

// Utility process that hosts isolated-vm isolates
const utilityProcessConfig = {
  entryPoints: ["src/workers/utilityEntry.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/utilityProcess.cjs",
  external: ["electron", "isolated-vm"],
  sourcemap: isDev,
  minify: !isDev,
  plugins: typiaPlugins,
  logOverride,
};

// Worker runtime shim that gets bundled into worker code
// This is built from the packages/runtime worker entry
const workerRuntimeConfig = {
  entryPoints: ["packages/runtime/src/worker/index.ts"],
  bundle: true,
  platform: "browser",  // isolated-vm runs V8 without Node APIs
  target: "es2022",
  format: "esm",
  outfile: "dist/workerRuntime.js",
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
  // Mark fs as external - it will be resolved at worker bundle time by the scoped fs shim plugin
  external: ["fs", "node:fs", "fs/promises", "node:fs/promises"],
};

function copyAssets() {
  fs.copyFileSync("src/renderer/index.html", "dist/index.html");
}

function copyDirectoryRecursive(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function generateProtocolFiles() {
  console.log("Generating protocol files...");
  try {
    execSync('node scripts/generate-channels.mjs', { stdio: 'inherit' });
    execSync('node scripts/generate-injected.mjs', { stdio: 'inherit' });
    console.log("Protocol files generated successfully!");
  } catch (error) {
    console.error("Failed to generate protocol files:", error);
    throw error;
  }
}

async function buildPlaywrightCore() {
  console.log("Building @natstack/playwright-core (browser bundle)...");
  try {
    execSync('pnpm --filter "@natstack/playwright-core" build', { stdio: 'inherit' });
    console.log("@natstack/playwright-core built successfully!");
  } catch (error) {
    console.error("Failed to build @natstack/playwright-core:", error);
    throw error;
  }
}

async function buildWorkspacePackages() {
  console.log("Building other workspace packages...");
  try {
    // Build all packages except playwright-core (already built separately)
    execSync('pnpm --filter "!@natstack/playwright-core" --filter "@natstack/*" build', { stdio: 'inherit' });
    console.log("Workspace packages built successfully!");
  } catch (error) {
    console.error("Failed to build workspace packages:", error);
    throw error;
  }
}

/**
 * Build dependency graph
 * Defines explicit dependencies between build steps to ensure correct ordering
 */
async function build() {
  let contexts = [];

  try {
    fs.mkdirSync("dist", { recursive: true });

    // ========================================================================
    // STEP 0: Generate protocol files from definitions
    // ========================================================================
    // These must be generated first as they are used by workspace packages
    // Dependencies: None
    await generateProtocolFiles();

    // ========================================================================
    // STEP 0.5: Build Playwright Core (browser bundle)
    // ========================================================================
    // Must be built before other packages since playwright-client depends on it
    // Dependencies: generateProtocolFiles
    await buildPlaywrightCore();

    // ========================================================================
    // STEP 1: Build other workspace packages
    // ========================================================================
    // These must be built as they are consumed by later steps
    // Dependencies: generateProtocolFiles, buildPlaywrightCore
    await buildWorkspacePackages();

    // ========================================================================
    // STEP 2: Build main application
    // ========================================================================
    // These can run in parallel as they don't depend on each other
    // Dependencies: buildWorkspacePackages
    // Required by: None (final outputs)
    await esbuild.build(mainConfig);
    await esbuild.build(preloadConfig);
    await esbuild.build(panelPreloadConfig);
    await esbuild.build(rendererConfig);
    await esbuild.build(utilityProcessConfig);
    await esbuild.build(workerRuntimeConfig);

    // ========================================================================
    // STEP 3: Copy static assets
    // ========================================================================
    // Dependencies: None (just copying files)
    // Required by: None
    copyAssets();

    console.log("Build successful!");
  } catch (error) {
    console.error("Build failed:", error);
    // Cleanup contexts on error
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
    process.exit(1);
  }
}

build();
