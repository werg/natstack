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

// Redirect better-sqlite3 to the server-native copy (compiled for system Node, not Electron).
// Path is relative to outfile (dist/server.mjs) so the build artifact is portable.
const serverNativeSqlitePath = path.relative(
  path.dirname("dist/server.mjs"),
  "server-native/node_modules/better-sqlite3/lib/index.js"
).replace(/\\/g, "/");  // ESM import specifiers must use forward slashes
const serverNativePlugin = {
  name: "server-native-redirect",
  setup(build) {
    build.onResolve({ filter: /^better-sqlite3$/ }, () => ({
      path: serverNativeSqlitePath.startsWith(".") ? serverNativeSqlitePath : "./" + serverNativeSqlitePath,
      external: true,
    }));
  },
};

const serverNativeReady = fs.existsSync("server-native/node_modules/better-sqlite3");

// CJS build for utilityProcess.fork() from Electron — uses Electron's built-in better-sqlite3
const serverElectronConfig = {
  entryPoints: ["src/server/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/server-electron.cjs",
  external: ["electron", "esbuild", "@npmcli/arborist", "better-sqlite3",
             "node-git-server"],
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
};

// Stub out 'electron' for the standalone ESM server build.
//
// Problem: Shared code in src/main/ contains `try { require("electron") } catch`
// guards that esbuild hoists to top-level ESM `import` statements. These fail
// at module load time when electron isn't installed.
//
// Solution: Two-tier stub.  `app` throws on method calls so the try/catch
// guards in envPaths.ts and paths.ts fall through to headless fallbacks.
// Everything else (protocol, session, etc.) is a silent no-op Proxy for code
// that runs at module scope.
const electronStubPlugin = {
  name: "electron-stub",
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({
      path: "electron",
      namespace: "electron-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "electron-stub" }, () => ({
      contents: `
        const notElectron = new Error("Not running in Electron");

        // app: throws on method calls so try/catch guards trigger fallbacks
        const app = new Proxy({}, {
          get(_, prop) {
            if (prop === Symbol.toPrimitive) return () => "";
            if (prop === "then") return undefined;
            return function() { throw notElectron; };
          },
        });

        // Silent no-op proxy for everything else
        function noopFn() {}
        const silentHandler = {
          get(_, prop) {
            if (prop === Symbol.toPrimitive) return () => "";
            if (prop === "then") return undefined;
            return new Proxy(noopFn, silentHandler);
          },
          apply() { return undefined; },
        };
        const silentProxy = new Proxy(noopFn, silentHandler);

        export { app };
        export const session = silentProxy;
        export const protocol = silentProxy;
        export const ipcMain = silentProxy;
        export const nativeTheme = silentProxy;
        export const dialog = silentProxy;
        export const Menu = silentProxy;
        export const WebContentsView = silentProxy;
        export const webContents = silentProxy;
        export const BaseWindow = silentProxy;
        export default silentProxy;
      `,
      loader: "js",
    }));
  },
};

const serverConfig = {
  entryPoints: ["src/server/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/server.mjs",
  external: ["esbuild", "@npmcli/arborist",
             "node-git-server"],
  plugins: [serverNativePlugin, electronStubPlugin],
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
  banner: {
    js: `#!/usr/bin/env node
import { createRequire as __createRequire } from "module";
import { fileURLToPath as __fileURLToPath } from "url";
import { dirname as __pathDirname } from "path";
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __pathDirname(__filename);
`.trim(),
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
  // Inject __dirname and __filename for CJS compatibility
  // esbuild should do this automatically for CJS output, but we ensure it explicitly
  banner: {
    js: `
const __injected_filename__ = typeof __filename !== 'undefined' ? __filename : '';
const __injected_dirname__ = typeof __dirname !== 'undefined' ? __dirname : (typeof __filename !== 'undefined' ? require('path').dirname(__filename) : '');
`.trim(),
  },
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

// Browser transport IIFE — used by PanelHttpServer to inject into panel HTML.
// Reuses createWsTransport from the preload, compiled for the browser.
const browserTransportConfig = {
  entryPoints: ["src/server/browserTransportEntry.ts"],
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "iife",
  outfile: "dist/browserTransport.js",
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
};

// Plugin to rewrite bare Node builtin imports to node: prefix and mark electron as external.
// Required for ESM splitting: esbuild can't bundle builtins but the renderer runs with
// nodeIntegration: true, so node:-prefixed imports work at runtime.
const rendererExternalsPlugin = {
  name: "renderer-externals",
  setup(build) {
    // Hardcoded set of Node builtin module names (covers all common ones)
    const builtins = new Set([
      "assert", "buffer", "child_process", "cluster", "console", "constants",
      "crypto", "dgram", "dns", "domain", "events", "fs", "fs/promises",
      "http", "http2", "https", "module", "net", "os", "path", "perf_hooks",
      "process", "punycode", "querystring", "readline", "repl", "stream",
      "string_decoder", "sys", "timers", "tls", "tty", "url", "util", "v8",
      "vm", "worker_threads", "zlib",
    ]);

    // Mark electron as external
    build.onResolve({ filter: /^electron$/ }, (args) => ({
      path: args.path,
      external: true,
    }));

    // Rewrite bare builtin imports to node: prefix
    build.onResolve({ filter: /.*/ }, (args) => {
      if (builtins.has(args.path)) {
        return { path: `node:${args.path}`, external: true };
      }
      // Already node:-prefixed — pass through as external
      if (args.path.startsWith("node:")) {
        return { path: args.path, external: true };
      }
      return undefined;
    });
  },
};

const rendererConfig = {
  entryPoints: ["src/renderer/index.tsx"],
  bundle: true,
  // Shell has nodeIntegration enabled, so we can use Node.js platform
  platform: "node",
  target: "node20",
  format: "esm",
  outdir: "dist/renderer",
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  splitting: true,
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
  plugins: [rendererExternalsPlugin],
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
  console.log("Building @workspace/playwright-core (browser bundle)...");
  try {
    execSync('pnpm --filter "@workspace/playwright-core" build', { stdio: 'inherit' });
    console.log("@workspace/playwright-core built successfully!");
  } catch (error) {
    console.error("Failed to build @workspace/playwright-core:", error);
    throw error;
  }
}

async function buildNatstackPackages() {
  console.log("Building @natstack/* infrastructure packages...");
  try {
    execSync('pnpm --filter "@natstack/*" build', { stdio: 'inherit' });
    console.log("@natstack/* packages built successfully!");
  } catch (error) {
    console.error("Failed to build @natstack/* packages:", error);
    throw error;
  }
}

async function buildWorkspacePackages() {
  console.log("Building @workspace/* packages...");
  try {
    // Build all packages except playwright-core (already built separately)
    // Note: We intentionally do NOT use --parallel here because packages have
    // inter-dependencies (e.g., @workspace/ai depends on @workspace/runtime).
    // pnpm will automatically build in topological order (dependencies first).
    execSync('pnpm --filter "!@workspace/playwright-core" --filter "@workspace/*" build', { stdio: 'inherit' });
    console.log("@workspace/* packages built successfully!");
  } catch (error) {
    console.error("Failed to build @workspace/* packages:", error);
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
    // STEP 0.75: Build @natstack/* infrastructure packages
    // ========================================================================
    // Must be built before @workspace/* packages since they depend on @natstack/*
    // Dependencies: generateProtocolFiles
    await buildNatstackPackages();

    // ========================================================================
    // STEP 1: Build @workspace/* packages
    // ========================================================================
    // These must be built as they are consumed by later steps
    // Dependencies: buildNatstackPackages, buildPlaywrightCore
    await buildWorkspacePackages();

    // ========================================================================
    // STEP 2: Build main application
    // ========================================================================
    // These can run in parallel as they don't depend on each other
    // Dependencies: buildWorkspacePackages
    // Required by: None (final outputs)
    await esbuild.build(mainConfig);
    await esbuild.build(preloadConfig);
    await esbuild.build(adblockPreloadConfig);
    await esbuild.build(browserTransportConfig);
    // Clean stale renderer artifacts before ESM build (prevents accidental loading of old CJS bundle)
    try { fs.unlinkSync("dist/renderer.js"); } catch {}
    try { fs.unlinkSync("dist/renderer.css"); } catch {}
    await esbuild.build(rendererConfig);
    await esbuild.build(serverElectronConfig);
    if (serverNativeReady) {
      await esbuild.build(serverConfig);
    } else {
      // Remove stale artifact so bin/script don't point at an outdated bundle
      try { fs.unlinkSync("dist/server.mjs"); } catch {}
      console.warn("[build] Skipping standalone server build — run 'pnpm server:install' first");
    }
    await buildDependencyWorkers();

    // ========================================================================
    // STEP 3: Copy static assets
    // ========================================================================
    // Dependencies: None (just copying files)
    // Required by: None
    copyAssets();
    // Copy opfsBootstrap.js — plain JS loaded at runtime by PanelHttpServer
    fs.copyFileSync("src/server/opfsBootstrap.js", "dist/opfsBootstrap.js");

    console.log("Build successful!");
  } catch (error) {
    console.error("Build failed:", error);
    // Cleanup contexts on error
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
    process.exit(1);
  }
}

build();
