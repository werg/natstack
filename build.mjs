import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { createRequire } from "module";
import { collectWorkersFromDependencies, workersToArray } from "./scripts/collectWorkers.mjs";

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

// CJS build for utilityProcess.fork() from Electron.
const serverElectronConfig = {
  entryPoints: ["src/server/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/server-electron.cjs",
  external: [
    "electron",
    "esbuild",
    "@npmcli/arborist",
    "node-datachannel",
    "@natstack/extension-host",
    "vitest",
    "vitest/node",
    "vite",
    // Agent SDKs: must stay external — they use import.meta.url at module scope
    // to locate config files, which breaks when bundled into CJS.
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
  ],
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
  external: [
    "esbuild",
    "@npmcli/arborist",
    "@natstack/extension-host",
    "vitest",
    "vitest/node",
    "vite",
    // Agent SDKs: must stay external — they use import.meta.url at module scope
    // to locate config files relative to their install path.
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
  ],
  plugins: [electronStubPlugin],
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

const clientConfig = {
  entryPoints: ["src/cli/client.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/cli/client.mjs",
  external: ["ws", "node-datachannel"],
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
};

const mainConfig = {
  entryPoints: ["src/main/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/main.cjs",
  external: ["electron", "esbuild", "@npmcli/arborist", "node-datachannel"],
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

const bootstrapPreloadConfig = {
  entryPoints: ["src/preload/bootstrapPreload.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/bootstrapPreload.cjs",
  external: ["electron"],
  sourcemap: isDev,
  minify: !isDev,
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
  logOverride,
};

const appPreloadConfig = {
  entryPoints: ["src/preload/appPreload.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/appPreload.cjs",
  external: ["electron"],
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
};

const browserPreloadConfig = {
  entryPoints: ["src/preload/browserPreload.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/browserPreload.cjs",
  external: ["electron"],
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
};

const autofillPreloadConfig = {
  entryPoints: ["src/preload/autofillPreload.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/autofillPreload.cjs",
  external: ["electron"],
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
};

const autofillOverlayPreloadConfig = {
  entryPoints: ["src/preload/autofillOverlayPreload.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/autofillOverlayPreload.cjs",
  external: ["electron"],
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
};

const shellOverlayPreloadConfig = {
  entryPoints: ["src/preload/shellOverlayPreload.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/shellOverlayPreload.cjs",
  external: ["electron"],
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
};

const contentOverlayPreloadConfig = {
  entryPoints: ["src/preload/contentOverlayPreload.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/contentOverlayPreload.cjs",
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

const internalDoBundleConfig = {
  entryPoints: ["src/server/internalDOs/index.ts"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  outfile: "dist/internal-do.bundle.mjs",
  conditions: ["worker", "browser"],
  external: ["node:*", "electron"],
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
};

// Plugin to rewrite bare Node builtin imports to node: prefix and mark electron
// as external for the shipped bootstrap/recovery UI bundle.
const bootstrapExternalsPlugin = {
  name: "bootstrap-externals",
  setup(build) {
    // Hardcoded set of Node builtin module names (covers all common ones)
    const builtins = new Set([
      "assert",
      "buffer",
      "child_process",
      "cluster",
      "console",
      "constants",
      "crypto",
      "dgram",
      "dns",
      "domain",
      "events",
      "fs",
      "fs/promises",
      "http",
      "http2",
      "https",
      "module",
      "net",
      "os",
      "path",
      "perf_hooks",
      "process",
      "punycode",
      "querystring",
      "readline",
      "repl",
      "stream",
      "string_decoder",
      "sys",
      "timers",
      "tls",
      "tty",
      "url",
      "util",
      "v8",
      "vm",
      "worker_threads",
      "zlib",
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

const bootstrapConfig = {
  entryPoints: ["src/bootstrap/index.ts"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  outdir: "dist/bootstrap",
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
  // Force react/react-dom to a single absolute path. Required because pnpm
  // (node-linker=hoisted) leaves the root node_modules/react as a real directory
  // while workspace packages keep symlinks into .pnpm/react@.../... — esbuild then
  // bundles two physically distinct copies, breaking the React dispatcher
  // (e.g. `useSyncExternalStore` returns null inside @workspace/react/responsive).
  alias: {
    react: path.resolve("node_modules/react"),
    "react-dom": path.resolve("node_modules/react-dom"),
  },
  plugins: [bootstrapExternalsPlugin],
};

function copyAssets() {
  fs.copyFileSync("src/bootstrap/index.html", "dist/index.html");
  fs.mkdirSync("dist/baked-app", { recursive: true });
  copyDirectoryRecursive(
    "workspace/extensions/shell/vscode-shell-integration",
    "dist/vscode-shell-integration"
  );
  // Bundled agent skill consumed by `natstack agent skill install|print`
  // (resolved as a sibling of dist/cli/client.mjs).
  copyDirectoryRecursive("skills/natstack-agent", "dist/cli/skills/natstack-agent");
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

async function buildNatstackPackages() {
  console.log("Building @natstack/* infrastructure packages...");
  try {
    execSync('pnpm --filter "!@natstack/headless-host" --filter "@natstack/*" build', {
      stdio: "inherit",
    });
    console.log("@natstack/* packages built successfully!");
  } catch (error) {
    console.error("Failed to build @natstack/* packages:", error);
    throw error;
  }
}

async function buildWorkspacePackages() {
  console.log("Building @workspace/* packages...");
  try {
    // Note: We intentionally do NOT use --parallel here because packages have
    // inter-dependencies (e.g., @workspace/ai depends on @workspace/runtime).
    // pnpm will automatically build in topological order (dependencies first).
    execSync('pnpm --filter "@workspace/*" build', {
      stdio: "inherit",
    });
    console.log("@workspace/* packages built successfully!");
  } catch (error) {
    console.error("Failed to build @workspace/* packages:", error);
    throw error;
  }
}

async function buildHeadlessHost() {
  console.log("Building @natstack/headless-host...");
  try {
    execSync('pnpm --filter "@natstack/headless-host" build', { stdio: "inherit" });
    fs.rmSync("dist/headless-host", { recursive: true, force: true });
    copyDirectoryRecursive("apps/headless-host/dist", "dist/headless-host");
    console.log("@natstack/headless-host built successfully!");
  } catch (error) {
    console.error("Failed to build @natstack/headless-host:", error);
    throw error;
  }
}

async function checkBuildArtifacts() {
  console.log("Checking build artifact contracts...");
  try {
    execSync("node scripts/check-build-artifacts.mjs", { stdio: "inherit" });
  } catch (error) {
    console.error("Build artifact contract check failed:", error);
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
      console.warn(
        `[build] Could not resolve worker: ${entry.specifier} (declared by ${entry.declaredBy})`
      );
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
    // STEP 0.75: Build @natstack/* infrastructure packages
    // ========================================================================
    // Must be built before @workspace/* packages since they depend on @natstack/*
    // Dependencies: none
    await buildNatstackPackages();

    // ========================================================================
    // STEP 1: Build @workspace/* packages
    // ========================================================================
    // These must be built as they are consumed by later steps
    // Dependencies: buildNatstackPackages
    await buildWorkspacePackages();

    // ========================================================================
    // STEP 1.5: Build standalone headless panel host
    // ========================================================================
    // The server auto-spawns this bundle as a child process when no desktop
    // CDP host is connected; copy it under dist/ so packaged CLIs can find it.
    // Dependencies: buildNatstackPackages, buildWorkspacePackages
    await buildHeadlessHost();

    // ========================================================================
    // STEP 2: Build main application
    // ========================================================================
    // These can run in parallel as they don't depend on each other
    // Dependencies: buildWorkspacePackages
    // Required by: None (final outputs)
    await esbuild.build(mainConfig);
    await esbuild.build(bootstrapPreloadConfig);
    await esbuild.build(panelPreloadConfig);
    await esbuild.build(appPreloadConfig);
    await esbuild.build(browserPreloadConfig);
    await esbuild.build(autofillPreloadConfig);
    await esbuild.build(autofillOverlayPreloadConfig);
    await esbuild.build(shellOverlayPreloadConfig);
    await esbuild.build(contentOverlayPreloadConfig);
    await esbuild.build(browserTransportConfig);
    await esbuild.build(internalDoBundleConfig);
    // Read the internal-DO bundle output and inline it as a string into the
    // server builds via `define`. This eliminates the runtime file lookup
    // performed by `internalDoLoader.ts` — the bundle ships embedded in the
    // server output instead of as a sibling file. Falls back to the file
    // lookup if the define is absent (test/dev paths run from source).
    const internalDoBundleContent = fs.readFileSync("dist/internal-do.bundle.mjs", "utf8");
    const internalDoBundleDefine = {
      "globalThis.__NATSTACK_INTERNAL_DO_BUNDLE__": JSON.stringify(internalDoBundleContent),
    };
    const serverElectronWithBundle = {
      ...serverElectronConfig,
      define: { ...(serverElectronConfig.define ?? {}), ...internalDoBundleDefine },
    };
    const serverWithBundle = {
      ...serverConfig,
      define: { ...(serverConfig.define ?? {}), ...internalDoBundleDefine },
    };
    // Clean stale renderer/bootstrap artifacts before ESM build.
    try {
      fs.unlinkSync("dist/renderer.js");
    } catch {}
    try {
      fs.unlinkSync("dist/renderer.css");
    } catch {}
    try {
      fs.unlinkSync("dist/preload.cjs");
    } catch {}
    try {
      fs.unlinkSync("dist/preload.cjs.map");
    } catch {}
    fs.rmSync("dist/renderer", { recursive: true, force: true });
    fs.rmSync("dist/bootstrap", { recursive: true, force: true });
    await esbuild.build(bootstrapConfig);
    await esbuild.build(serverElectronWithBundle);
    await esbuild.build(serverWithBundle);
    await esbuild.build(clientConfig);
    await buildDependencyWorkers();

    // ========================================================================
    // STEP 3: Copy static assets
    // ========================================================================
    // Dependencies: None (just copying files)
    // Required by: None
    copyAssets();

    await checkBuildArtifacts();

    console.log("Build successful!");
  } catch (error) {
    console.error("Build failed:", error);
    // Cleanup contexts on error
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
    process.exit(1);
  }
}

build();
