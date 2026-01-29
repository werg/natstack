import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { createRequire } from "module";
import { collectWorkersFromDependencies, workersToArray } from "./src/shared/collectWorkers.mjs";

const isDev = process.env.NODE_ENV === "development";

const logOverride = {
  "suspicious-logical-operator": "silent",
};


// Plugin to mark node: prefixed imports as external (for browser platform builds)
const nodeBuiltinsExternalPlugin = {
  name: "node-builtins-external",
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => {
      return { path: args.path, external: true };
    });
  },
};

const mainConfig = {
  entryPoints: ["src/main/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/main.cjs",
  external: ["electron", "esbuild", "@npmcli/arborist", "better-sqlite3"],
  sourcemap: isDev,
  minify: !isDev,
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
  logOverride,
};

const safePreloadConfig = {
  entryPoints: ["src/preload/safePreload.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/safePreload.cjs",
  external: ["electron"],
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
};

const unsafePreloadConfig = {
  entryPoints: ["src/preload/unsafePreload.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/unsafePreload.cjs",
  external: ["electron"],
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
};

const adblockPreloadConfig = {
  entryPoints: ["src/preload/adblockPreload.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/adblockPreload.cjs",
  external: ["electron"],
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
};

const rendererConfig = {
  entryPoints: ["src/renderer/index.tsx"],
  bundle: true,
  // Shell has nodeIntegration enabled, so we can use Node.js platform
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/renderer.js",
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
  loader: {
    ".html": "text",
    ".css": "css",
    // Monaco editor assets
    ".ttf": "dataurl",
    ".woff": "dataurl",
    ".woff2": "dataurl",
    ".eot": "dataurl",
    ".svg": "dataurl",
  },
  // Define process.env.NODE_ENV at build time (React checks this before Node globals are available)
  define: {
    "process.env.NODE_ENV": isDev ? '"development"' : '"production"',
  },
  // Electron is external; fs modules are external since DirtyRepoView uses direct Node.js fs
  external: ["electron", "fs", "fs/promises", "path"],
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
    // Use --parallel for concurrent builds to speed up the process
    execSync('pnpm --filter "!@natstack/playwright-core" --filter "@natstack/*" --parallel build', { stdio: 'inherit' });
    console.log("Workspace packages built successfully!");
  } catch (error) {
    console.error("Failed to build workspace packages:", error);
    throw error;
  }
}

/**
 * Build web workers declared by dependencies via natstack.workers in package.json.
 * Scans node_modules for worker declarations and bundles them.
 */
async function buildDependencyWorkers() {
  const req = createRequire(import.meta.url);
  const nodeModulesDir = path.join(process.cwd(), "node_modules");

  // Collect workers from dependencies (workspace packages are symlinked here)
  const workers = collectWorkersFromDependencies(nodeModulesDir, {
    log: (msg) => console.warn(`[build] ${msg}`),
  });

  const workerEntries = workersToArray(workers);
  if (workerEntries.length === 0) {
    return;
  }

  let builtCount = 0;
  for (const entry of workerEntries) {
    let entryPath;
    try {
      entryPath = req.resolve(entry.specifier);
    } catch {
      console.warn(`[build] Could not resolve worker: ${entry.specifier} (declared by ${entry.declaredBy})`);
      continue;
    }

    // Create output directory based on worker path (e.g., "monaco/editor.worker.js" -> "dist/monaco/")
    const outfile = path.join("dist", entry.name);
    fs.mkdirSync(path.dirname(outfile), { recursive: true });

    await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      platform: "browser",
      target: "es2022",
      format: "esm",
      outfile,
      sourcemap: isDev,
      minify: !isDev,
      logLevel: "silent",
    });
    builtCount += 1;
  }

  if (builtCount > 0) {
    const packages = [...new Set(workerEntries.map((e) => e.declaredBy))];
    console.log(`[build] Bundled ${builtCount} worker assets from: ${packages.join(", ")}`);
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
    await esbuild.build(safePreloadConfig);
    await esbuild.build(unsafePreloadConfig);
    await esbuild.build(adblockPreloadConfig);
    await esbuild.build(rendererConfig);
    await buildDependencyWorkers();

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
