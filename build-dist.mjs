/**
 * Production Distribution Build Script
 *
 * This script prepares NatStack for distribution by:
 * 1. Running the standard build (build.mjs)
 * 2. Pre-compiling shipped panels from workspace/panels/
 * 3. Pre-compiling about pages from src/about-pages/
 * 4. Pre-compiling builtin workers from src/builtin-workers/
 *
 * The pre-compiled assets are stored in dist/ and will be bundled
 * with the Electron app via electron-builder extraResources.
 */

import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// Output directories for pre-compiled assets
const DIST_DIR = path.join(__dirname, "dist");
const SHIPPED_PANELS_DIR = path.join(DIST_DIR, "shipped-panels");
const ABOUT_PAGES_DIR = path.join(DIST_DIR, "about-pages");
const BUILTIN_WORKERS_DIR = path.join(DIST_DIR, "builtin-workers");

// Source directories
const WORKSPACE_PANELS_DIR = path.join(__dirname, "workspace", "panels");
const SRC_ABOUT_PAGES_DIR = path.join(__dirname, "src", "about-pages");
const SRC_BUILTIN_WORKERS_DIR = path.join(__dirname, "src", "builtin-workers");
const PACKAGES_DIR = path.join(__dirname, "packages");
const NODE_MODULES_DIR = path.join(__dirname, "node_modules");

// Panels that ship with the app
const SHIPPED_PANELS = [
  "chat",
  "chat-launcher",
  "code-editor",
  "project-launcher",
  "project-panel",
];

// About pages that ship with the app
const ABOUT_PAGES = [
  "about",
  "adblock",
  "agents",
  "help",
  "keyboard-shortcuts",
  "model-provider-config",
  "new",
];

// Builtin workers that ship with the app
const BUILTIN_WORKERS = ["template-builder"];

// CSP meta tag for panels (copied from src/shared/constants.ts)
const PANEL_CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:; connect-src 'self' blob: data: https: http://localhost:* ws://localhost:* wss://localhost:*; img-src 'self' blob: data: https:; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:; frame-src 'self' blob: data: https:">`;

/**
 * Generate the module map banner for panel bundles
 */
function generateModuleMapBanner() {
  return `
// === NatStack Module Map (runs before all module code) ===
globalThis.__natstackModuleMap__ = globalThis.__natstackModuleMap__ || {};
globalThis.__natstackModuleLoadingPromises__ = globalThis.__natstackModuleLoadingPromises__ || {};

globalThis.__natstackRequire__ = function(id) {
  var mod = globalThis.__natstackModuleMap__[id];
  if (mod) return mod;
  throw new Error('Module "' + id + '" not available via require().');
};

globalThis.__natstackRequireAsync__ = async function(id) {
  if (globalThis.__natstackModuleMap__[id]) {
    return globalThis.__natstackModuleMap__[id];
  }
  if (globalThis.__natstackModuleLoadingPromises__[id]) {
    return globalThis.__natstackModuleLoadingPromises__[id];
  }
  var loadPromise = (async function() {
    var timeoutMs = 30000;
    var timeoutPromise = new Promise(function(_, reject) {
      setTimeout(function() { reject(new Error('Timeout loading "' + id + '"')); }, timeoutMs);
    });
    try {
      var mod = await Promise.race([
        import('https://esm.sh/' + id + '?external=react,react-dom'),
        timeoutPromise
      ]);
      globalThis.__natstackModuleMap__[id] = mod;
      return mod;
    } catch (err) {
      delete globalThis.__natstackModuleLoadingPromises__[id];
      throw err;
    }
  })();
  globalThis.__natstackModuleLoadingPromises__[id] = loadPromise;
  return loadPromise;
};

globalThis.__natstackPreloadModules__ = async function(moduleIds) {
  return Promise.all(moduleIds.map(function(id) {
    return globalThis.__natstackRequireAsync__(id);
  }));
};
// === End Module Map ===
`;
}

/**
 * Generate the async tracking banner for panel bundles
 */
function generateAsyncTrackingBanner() {
  return `
// === NatStack Async Tracking ===
(function() {
  "use strict";
  var globalObj = typeof globalThis !== "undefined" ? globalThis : window;
  var OriginalPromise = globalObj.Promise;
  var originalThen = OriginalPromise.prototype.then;
  var __ignoredPromises__ = new WeakSet();
  var __promiseContext__ = new WeakMap();
  var __contexts__ = new Map();
  var __nextContextId__ = 1;
  var __currentContext__ = null;

  function createContext(options) {
    options = options || {};
    var id = __nextContextId__++;
    var ctx = { id: id, promises: new Set(), pauseCount: 0, timeoutId: null };
    if (options.maxTimeout > 0) {
      ctx.timeoutId = setTimeout(function() { destroyContext(id); }, options.maxTimeout);
    }
    __contexts__.set(id, ctx);
    return ctx;
  }

  function destroyContext(contextId) {
    var ctx = __contexts__.get(contextId);
    if (!ctx) return;
    if (ctx.timeoutId) clearTimeout(ctx.timeoutId);
    ctx.promises.clear();
    __contexts__.delete(contextId);
    if (__currentContext__ && __currentContext__.id === contextId) __currentContext__ = null;
  }

  function trackInContext(ctx, p) {
    if (!p || typeof p.then !== "function") return p;
    if (__ignoredPromises__.has(p)) return p;
    var promiseCtx = __promiseContext__.get(p);
    if (promiseCtx !== ctx) return p;
    ctx.promises.add(p);
    originalThen.call(p, function(v) { ctx.promises.delete(p); return v; }, function(e) { ctx.promises.delete(p); throw e; });
    return p;
  }

  globalObj.__natstackAsyncTracking__ = {
    createContext: function(options) { return createContext(options); },
    start: function(options) { var ctx = createContext(options); __currentContext__ = ctx; return ctx; },
    enter: function(ctx) { if (ctx && __contexts__.has(ctx.id)) __currentContext__ = ctx; },
    exit: function() { __currentContext__ = null; },
    stop: function(ctx) { if (ctx) destroyContext(ctx.id); else if (__currentContext__) { destroyContext(__currentContext__.id); __currentContext__ = null; } },
    pause: function(ctx) { ctx = ctx || __currentContext__; if (ctx && __contexts__.has(ctx.id)) ctx.pauseCount += 1; },
    resume: function(ctx) { ctx = ctx || __currentContext__; if (ctx && __contexts__.has(ctx.id)) ctx.pauseCount = Math.max(0, ctx.pauseCount - 1); },
    ignore: function(p) { if (p && typeof p === "object") __ignoredPromises__.add(p); return p; },
    waitAll: function(timeoutMs, ctx) {
      ctx = ctx || __currentContext__;
      if (!ctx || !__contexts__.has(ctx.id)) return OriginalPromise.resolve();
      var deadline = Date.now() + timeoutMs;
      var waitPromise = new OriginalPromise(function(resolve, reject) {
        function check() {
          if (!__contexts__.has(ctx.id) || ctx.promises.size === 0) resolve();
          else if (Date.now() >= deadline) reject(new Error("Async timeout"));
          else setTimeout(check, 50);
        }
        check();
      });
      __ignoredPromises__.add(waitPromise);
      return waitPromise;
    },
    pending: function(ctx) { ctx = ctx || __currentContext__; return ctx && __contexts__.has(ctx.id) ? ctx.promises.size : 0; },
    activeContexts: function() { return Array.from(__contexts__.keys()); }
  };

  function TrackedPromise(executor) {
    var promise = new OriginalPromise(executor);
    var ctx = __currentContext__;
    if (ctx && __contexts__.has(ctx.id) && ctx.pauseCount === 0) {
      __promiseContext__.set(promise, ctx);
      trackInContext(ctx, promise);
    }
    return promise;
  }
  TrackedPromise.prototype = OriginalPromise.prototype;
  Object.setPrototypeOf(TrackedPromise, OriginalPromise);

  function tagAndTrack(p) {
    var ctx = __currentContext__;
    if (ctx && __contexts__.has(ctx.id) && ctx.pauseCount === 0) {
      __promiseContext__.set(p, ctx);
      trackInContext(ctx, p);
    }
    return p;
  }

  TrackedPromise.resolve = function(v) { return tagAndTrack(OriginalPromise.resolve(v)); };
  TrackedPromise.reject = function(v) { return tagAndTrack(OriginalPromise.reject(v)); };
  TrackedPromise.all = function(v) { return tagAndTrack(OriginalPromise.all(v)); };
  TrackedPromise.allSettled = function(v) { return tagAndTrack(OriginalPromise.allSettled(v)); };
  TrackedPromise.race = function(v) { return tagAndTrack(OriginalPromise.race(v)); };
  TrackedPromise.any = function(v) { return tagAndTrack(OriginalPromise.any(v)); };
  globalObj.Promise = TrackedPromise;

  var originalFetch = globalObj.fetch;
  if (originalFetch) globalObj.fetch = function() { return tagAndTrack(originalFetch.apply(this, arguments)); };
})();
// === End Async Tracking ===
`;
}

/**
 * Generate Node.js compatibility patch for unsafe panels
 */
function generateNodeCompatibilityPatch() {
  return `
// === Node.js Compatibility Patch ===
(function() {
  if (typeof require === 'function' && typeof AbortSignal !== 'undefined') {
    try {
      var nodeEvents = require('events');
      if (nodeEvents && typeof nodeEvents.setMaxListeners === 'function') {
        var originalSetMaxListeners = nodeEvents.setMaxListeners;
        nodeEvents.setMaxListeners = function(n) {
          var eventTargets = Array.prototype.slice.call(arguments, 1);
          var compatibleTargets = eventTargets.filter(function(t) {
            return t instanceof nodeEvents.EventEmitter ||
                   (t && t.constructor && t.constructor.name !== 'AbortSignal');
          });
          if (compatibleTargets.length > 0) {
            return originalSetMaxListeners.apply(this, [n].concat(compatibleTargets));
          }
        };
      }
    } catch (e) {}
  }
})();
`;
}

/**
 * Asset loaders for panel builds
 */
const PANEL_ASSET_LOADERS = {
  ".png": "file",
  ".jpg": "file",
  ".jpeg": "file",
  ".gif": "file",
  ".webp": "file",
  ".avif": "file",
  ".svg": "file",
  ".ico": "file",
  ".bmp": "file",
  ".woff": "file",
  ".woff2": "file",
  ".ttf": "file",
  ".otf": "file",
  ".eot": "file",
  ".mp3": "file",
  ".wav": "file",
  ".ogg": "file",
  ".mp4": "file",
  ".webm": "file",
  ".wasm": "file",
  ".pdf": "file",
};

const TEXT_ASSET_EXTENSIONS = new Set([
  ".js",
  ".css",
  ".json",
  ".map",
  ".svg",
  ".txt",
  ".md",
  ".html",
]);

// fs methods that are async and work in ZenFS
const FS_ASYNC_METHODS = [
  "access",
  "appendFile",
  "chmod",
  "chown",
  "copyFile",
  "lchmod",
  "lchown",
  "link",
  "lstat",
  "mkdir",
  "mkdtemp",
  "open",
  "opendir",
  "readdir",
  "readFile",
  "readlink",
  "realpath",
  "rename",
  "rm",
  "rmdir",
  "stat",
  "symlink",
  "truncate",
  "unlink",
  "utimes",
  "writeFile",
  "lutimes",
  "cp",
  "statfs",
  "glob",
];

// fs methods that are sync (not available in browser)
const FS_SYNC_METHODS = [
  "accessSync",
  "appendFileSync",
  "chmodSync",
  "chownSync",
  "copyFileSync",
  "existsSync",
  "lchmodSync",
  "lchownSync",
  "linkSync",
  "lstatSync",
  "mkdirSync",
  "mkdtempSync",
  "opendirSync",
  "openSync",
  "readdirSync",
  "readFileSync",
  "readlinkSync",
  "realpathSync",
  "renameSync",
  "rmdirSync",
  "rmSync",
  "statSync",
  "symlinkSync",
  "truncateSync",
  "unlinkSync",
  "utimesSync",
  "writeFileSync",
  "lutimesSync",
  "cpSync",
  "statfsSync",
  "globSync",
];

const FS_CONSTANTS = {
  COPYFILE_EXCL: 1,
  COPYFILE_FICLONE: 2,
  COPYFILE_FICLONE_FORCE: 4,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 64,
  O_EXCL: 128,
  O_TRUNC: 512,
  O_APPEND: 1024,
  O_SYNC: 4096,
};

/**
 * Generate fs shim code that maps fs imports to @natstack/runtime.
 * This is used for safe mode panels that run in the browser with ZenFS.
 */
function generateFsShimCode(isPromises) {
  const asyncExports = FS_ASYNC_METHODS.map(
    (m) => `export const ${m} = fs.${m}.bind(fs);`
  ).join("\n");

  const syncStubs = FS_SYNC_METHODS.map(
    (m) =>
      `export function ${m}() { throw new Error("Synchronous fs methods (${m}) are not available in NatStack panels. Use the async version instead."); }`
  ).join("\n");

  const fsConstants = `
export const constants = ${JSON.stringify(FS_CONSTANTS, null, 2)};`;

  if (isPromises) {
    // fs/promises - just export async methods
    return `import { fs } from "@natstack/runtime";
export default fs;
${asyncExports}
`;
  } else {
    // fs - export promises, async methods, sync stubs, and constants
    return `import { fs } from "@natstack/runtime";
export default { ...fs, promises: fs };
export const promises = fs;
${asyncExports}
${syncStubs}
${fsConstants}
`;
  }
}

/**
 * Generate path shim code that uses pathe (browser-compatible path).
 */
function generatePathShimCode() {
  return `
export * from "pathe";
import * as pathModule from "pathe";
export default pathModule;
`;
}

/**
 * Create fs shim plugin for esbuild
 */
function createFsShimPlugin(resolveDir) {
  return {
    name: "panel-fs-shim",
    setup(build) {
      build.onResolve(
        { filter: /^(fs|node:fs|fs\/promises|node:fs\/promises)$/ },
        (args) => {
          return { path: args.path, namespace: "natstack-panel-fs-shim" };
        }
      );

      build.onLoad({ filter: /.*/, namespace: "natstack-panel-fs-shim" }, (args) => {
        const isPromises =
          args.path === "fs/promises" || args.path === "node:fs/promises";
        const contents = generateFsShimCode(isPromises);
        return { contents, loader: "js", resolveDir };
      });
    },
  };
}

/**
 * Create path shim plugin for esbuild
 */
function createPathShimPlugin(resolveDir) {
  return {
    name: "panel-path-shim",
    setup(build) {
      build.onResolve(
        { filter: /^(path|node:path|path\/posix|node:path\/posix)$/ },
        (args) => {
          return { path: args.path, namespace: "natstack-panel-path-shim" };
        }
      );

      build.onLoad({ filter: /.*/, namespace: "natstack-panel-path-shim" }, () => {
        const contents = generatePathShimCode();
        return { contents, loader: "js", resolveDir };
      });
    },
  };
}

/**
 * Generate HTML template for a panel
 */
function generatePanelHtml(title, options = {}) {
  const { includeCss = false, unsafe = false, externals = {} } = options;

  const importMap = { imports: externals };
  const importMapScript =
    Object.keys(importMap.imports).length > 0
      ? `<script type="importmap">${JSON.stringify(importMap)}</script>\n  `
      : "";

  const cssLink = includeCss
    ? `\n  <link rel="stylesheet" href="./bundle.css" />`
    : "";
  const scriptType = unsafe ? "" : ' type="module"';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${PANEL_CSP_META}
  <title>${title}</title>
  ${importMapScript}<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@radix-ui/themes@3.2.1/styles.css">
  ${cssLink}
  <style>
    html, body { margin: 0; padding: 0; height: 100%; }
    #root, #root > .radix-themes { min-height: 100vh; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script${scriptType} src="./bundle.js"></script>
</body>
</html>`;
}

/**
 * Generate HTML template for an about page
 */
function generateAboutHtml(title, includeCss = false) {
  const cssLink = includeCss
    ? `\n  <link rel="stylesheet" href="./bundle.css" />`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${PANEL_CSP_META}
  <title>${title}</title>${cssLink}
  <style>
    html, body { margin: 0; padding: 0; height: 100%; }
    #root, #root > .radix-themes { min-height: 100vh; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="./bundle.js"></script>
</body>
</html>`;
}

/**
 * Read manifest from panel package.json
 */
function loadPanelManifest(panelPath) {
  const packageJsonPath = path.join(panelPath, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json not found in ${panelPath}`);
  }

  const content = fs.readFileSync(packageJsonPath, "utf-8");
  const packageJson = JSON.parse(content);

  if (!packageJson.natstack) {
    throw new Error(`package.json in ${panelPath} must include a 'natstack' field`);
  }

  const manifest = packageJson.natstack;
  if (packageJson.dependencies) {
    manifest.dependencies = {
      ...manifest.dependencies,
      ...packageJson.dependencies,
    };
  }

  return manifest;
}

/**
 * Find entry point for a panel or page
 */
function findEntryPoint(dir) {
  const candidates = ["index.tsx", "index.ts", "index.jsx", "index.js"];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(dir, candidate))) {
      return candidate;
    }
  }
  return null;
}

/**
 * Collect assets from esbuild metafile
 */
function collectAssets(metafile, buildDir, bundlePath, cssPath) {
  if (!metafile) return {};

  const outputs = Object.keys(metafile.outputs ?? {});
  if (outputs.length === 0) return {};

  const ignoredOutputs = new Set([
    path.resolve(bundlePath),
    path.resolve(cssPath),
  ]);
  const assets = {};

  for (const output of outputs) {
    const resolvedOutput = path.isAbsolute(output)
      ? output
      : path.join(buildDir, output);
    const absoluteOutput = path.resolve(resolvedOutput);
    if (ignoredOutputs.has(absoluteOutput)) continue;
    if (!fs.existsSync(absoluteOutput)) continue;

    const relative = path.relative(buildDir, absoluteOutput);
    if (relative.startsWith("..")) continue;

    const assetPath = `/${relative.replace(/\\/g, "/")}`;
    const ext = path.extname(relative).toLowerCase();
    const isText = TEXT_ASSET_EXTENSIONS.has(ext);
    const content = isText
      ? fs.readFileSync(absoluteOutput, "utf-8")
      : fs.readFileSync(absoluteOutput).toString("base64");

    assets[assetPath] = isText ? { content } : { content, encoding: "base64" };
  }

  return assets;
}

/**
 * Copy a directory recursively
 */
function copyDirectory(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Get resolution paths for panel dependencies.
 * Uses the root node_modules and packages directories which contain
 * all workspace packages via pnpm's symlinking.
 *
 * @returns Array of node module paths for esbuild resolution
 */
function getPanelResolutionPaths() {
  // pnpm hoists shared deps to root node_modules
  // @natstack/* packages are symlinked from packages/ to node_modules/
  return [NODE_MODULES_DIR, PACKAGES_DIR];
}

/**
 * Build a shipped panel for distribution
 */
async function buildShippedPanel(panelName) {
  console.log(`  Building panel: ${panelName}...`);

  const panelDir = path.join(WORKSPACE_PANELS_DIR, panelName);
  if (!fs.existsSync(panelDir)) {
    console.warn(`  Warning: Panel directory not found: ${panelDir}`);
    return;
  }

  const outputDir = path.join(SHIPPED_PANELS_DIR, panelName);
  fs.mkdirSync(outputDir, { recursive: true });

  // Load manifest
  const manifest = loadPanelManifest(panelDir);
  const entry = manifest.entry || findEntryPoint(panelDir);
  if (!entry) {
    throw new Error(`No entry point found for panel: ${panelName}`);
  }

  // Get resolution paths (uses root node_modules with pnpm-linked workspace packages)
  const nodePaths = getPanelResolutionPaths();

  const entryPath = path.join(panelDir, entry);
  const bundlePath = path.join(outputDir, "bundle.js");
  const unsafe = manifest.unsafe === true;

  // Determine externals
  const externals = { ...(manifest.externals ?? {}) };
  const externalModules = Object.keys(externals);

  // Check if panel uses @natstack/react
  const hasNatstackReact = "@natstack/react" in (manifest.dependencies ?? {});

  // Create wrapper entry
  const buildDir = path.join(outputDir, ".build");
  fs.mkdirSync(buildDir, { recursive: true });

  const tempEntryPath = path.join(buildDir, "_entry.js");
  const relativeUserEntry = path.relative(buildDir, entryPath);

  // Generate expose module code
  const explicitExposeModules = (manifest.exposeModules ?? [])
    .filter((spec) => typeof spec === "string")
    .map((spec) => spec.trim())
    .filter((spec) => spec.length > 0);

  const importLines = explicitExposeModules.map(
    (dep, index) => `import * as __mod${index}__ from ${JSON.stringify(dep)};`
  );
  const registerLines = explicitExposeModules.map(
    (dep, index) =>
      `globalThis.__natstackModuleMap__[${JSON.stringify(dep)}] = __mod${index}__;`
  );

  const exposeCode =
    explicitExposeModules.length > 0
      ? `${importLines.join("\n")}\nglobalThis.__natstackModuleMap__ = globalThis.__natstackModuleMap__ || {};\n${registerLines.join("\n")}\n`
      : "";

  // Build wrapper code
  let wrapperCode;
  if (hasNatstackReact) {
    wrapperCode = `${exposeCode}
import { autoMountReactPanel, shouldAutoMount } from "@natstack/react";
import * as userModule from ${JSON.stringify(relativeUserEntry)};

if (shouldAutoMount(userModule)) {
  autoMountReactPanel(userModule);
}
`;
  } else {
    wrapperCode = `${exposeCode}
import ${JSON.stringify(relativeUserEntry)};
`;
  }

  fs.writeFileSync(tempEntryPath, wrapperCode);

  // Generate banner
  const importMetaUrlShim =
    'var __import_meta_url = require("url").pathToFileURL(__filename).href;';
  const bannerJs = unsafe
    ? [
        importMetaUrlShim,
        generateNodeCompatibilityPatch(),
        generateAsyncTrackingBanner(),
        generateModuleMapBanner(),
      ].join("\n")
    : [generateAsyncTrackingBanner(), generateModuleMapBanner()].join("\n");

  // Create plugins for safe mode panels
  const plugins = [];
  if (!unsafe) {
    // Use fs and path shims for browser-platform panels
    plugins.push(createFsShimPlugin(PACKAGES_DIR));
    plugins.push(createPathShimPlugin(__dirname));
  }

  // Build with esbuild
  const result = await esbuild.build({
    entryPoints: [tempEntryPath],
    bundle: true,
    platform: unsafe ? "node" : "browser",
    target: "es2022",
    conditions: ["natstack-panel"],
    outfile: bundlePath,
    sourcemap: false,
    keepNames: true,
    format: unsafe ? "cjs" : "esm",
    minify: true,
    absWorkingDir: panelDir,
    nodePaths,
    plugins,
    external: externalModules,
    loader: PANEL_ASSET_LOADERS,
    assetNames: "assets/[name]-[hash]",
    banner: { js: bannerJs },
    metafile: true,
    supported: unsafe ? { "dynamic-import": false } : undefined,
    define: unsafe ? { "import.meta.url": "__import_meta_url" } : undefined,
    jsx: "automatic",
    jsxImportSource: "react",
  });

  // Collect CSS
  const cssPath = bundlePath.replace(".js", ".css");
  const hasCss = fs.existsSync(cssPath);

  // Collect assets
  const assets = collectAssets(result.metafile, outputDir, bundlePath, cssPath);

  // Generate HTML
  const html = generatePanelHtml(manifest.title, {
    includeCss: hasCss,
    unsafe,
    externals,
  });
  fs.writeFileSync(path.join(outputDir, "html.html"), html);

  // Write manifest
  fs.writeFileSync(
    path.join(outputDir, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );

  // Write assets if any
  if (Object.keys(assets).length > 0) {
    fs.writeFileSync(
      path.join(outputDir, "assets.json"),
      JSON.stringify(assets, null, 2)
    );
  }

  // Clean up build dir
  fs.rmSync(buildDir, { recursive: true, force: true });

  const bundleSize = fs.statSync(bundlePath).size;
  console.log(
    `    Done: ${manifest.title} (${(bundleSize / 1024).toFixed(1)} KB)`
  );
}

/**
 * Build an about page for distribution
 */
async function buildAboutPage(pageName) {
  console.log(`  Building about page: ${pageName}...`);

  const pageDir = path.join(SRC_ABOUT_PAGES_DIR, pageName);
  if (!fs.existsSync(pageDir)) {
    console.warn(`  Warning: About page directory not found: ${pageDir}`);
    return;
  }

  const outputDir = path.join(ABOUT_PAGES_DIR, pageName);
  fs.mkdirSync(outputDir, { recursive: true });

  const entry = findEntryPoint(pageDir);
  if (!entry) {
    throw new Error(`No entry point found for about page: ${pageName}`);
  }

  const entryPath = path.join(pageDir, entry);
  const bundlePath = path.join(outputDir, "bundle.js");

  // About page titles
  const titles = {
    about: "About NatStack",
    adblock: "Ad Blocking",
    help: "Help",
    "keyboard-shortcuts": "Keyboard Shortcuts",
    "model-provider-config": "Model Provider Config",
    new: "New Panel",
  };
  const title = titles[pageName] || pageName;

  // Generate banner
  const bannerJs = [
    generateNodeCompatibilityPatch(),
    generateAsyncTrackingBanner(),
    generateModuleMapBanner(),
  ].join("\n");

  // Build with esbuild
  await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    platform: "node", // About pages have nodeIntegration
    target: "es2022",
    conditions: ["natstack-panel"],
    outfile: bundlePath,
    sourcemap: false,
    keepNames: true,
    format: "cjs",
    minify: true,
    absWorkingDir: pageDir,
    nodePaths: [NODE_MODULES_DIR, PACKAGES_DIR],
    loader: PANEL_ASSET_LOADERS,
    jsx: "automatic",
    jsxImportSource: "react",
    supported: { "dynamic-import": false },
    banner: { js: bannerJs },
  });

  // Check for CSS
  const cssPath = bundlePath.replace(".js", ".css");
  const hasCss = fs.existsSync(cssPath);

  // Generate HTML
  const html = generateAboutHtml(title, hasCss);
  fs.writeFileSync(path.join(outputDir, "html.html"), html);

  // Write title for runtime use
  fs.writeFileSync(path.join(outputDir, "title.txt"), title);

  const bundleSize = fs.statSync(bundlePath).size;
  console.log(`    Done: ${title} (${(bundleSize / 1024).toFixed(1)} KB)`);
}

/**
 * Build a builtin worker for distribution
 */
async function buildBuiltinWorker(workerName) {
  console.log(`  Building builtin worker: ${workerName}...`);

  const workerDir = path.join(SRC_BUILTIN_WORKERS_DIR, workerName);
  if (!fs.existsSync(workerDir)) {
    console.warn(`  Warning: Builtin worker directory not found: ${workerDir}`);
    return;
  }

  const outputDir = path.join(BUILTIN_WORKERS_DIR, workerName);
  fs.mkdirSync(outputDir, { recursive: true });

  const entry = findEntryPoint(workerDir);
  if (!entry) {
    throw new Error(`No entry point found for builtin worker: ${workerName}`);
  }

  const entryPath = path.join(workerDir, entry);
  const bundlePath = path.join(outputDir, "bundle.js");

  // Generate banner
  const bannerJs = [generateAsyncTrackingBanner(), generateModuleMapBanner()].join(
    "\n"
  );

  // Builtin workers run in browser with ZenFS - use fs and path shims
  const plugins = [
    createFsShimPlugin(PACKAGES_DIR),
    createPathShimPlugin(__dirname),
  ];

  // Build with esbuild (browser platform, ESM for workers)
  await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    platform: "browser",
    target: "es2022",
    conditions: ["natstack-panel"],
    outfile: bundlePath,
    sourcemap: false,
    keepNames: true,
    format: "esm",
    minify: true,
    absWorkingDir: workerDir,
    nodePaths: [NODE_MODULES_DIR, PACKAGES_DIR],
    plugins,
    banner: { js: bannerJs },
  });

  const bundleSize = fs.statSync(bundlePath).size;
  console.log(`    Done: ${workerName} (${(bundleSize / 1024).toFixed(1)} KB)`);
}

/**
 * Main build function
 */
async function build() {
  console.log("=== NatStack Production Build ===\n");

  // Step 1: Run standard build
  console.log("Step 1: Running standard build...");
  try {
    execSync("node build.mjs", {
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "production" },
    });
  } catch (error) {
    console.error("Standard build failed");
    process.exit(1);
  }

  // Create output directories
  fs.mkdirSync(SHIPPED_PANELS_DIR, { recursive: true });
  fs.mkdirSync(ABOUT_PAGES_DIR, { recursive: true });
  fs.mkdirSync(BUILTIN_WORKERS_DIR, { recursive: true });

  // Step 2: Pre-compile shipped panels
  // Note: Shipped panels have complex dependencies (npm packages + workspace packages)
  // that require runtime Verdaccio to resolve. For now, skip failed panels and they
  // will be compiled on first launch (with caching).
  console.log("\nStep 2: Pre-compiling shipped panels...");
  console.log("  Note: Panels with complex deps will be built at first launch");
  let panelsBuilt = 0;
  let panelsFailed = 0;
  for (const panel of SHIPPED_PANELS) {
    try {
      await buildShippedPanel(panel);
      panelsBuilt++;
    } catch (error) {
      panelsFailed++;
      console.error(`  Error building panel ${panel}: ${error.message.split("\n")[0]}`);
      // Continue with other panels - they'll be built at first launch
    }
  }
  console.log(`  Summary: ${panelsBuilt} panels pre-built, ${panelsFailed} will build at first launch`);

  // Step 3: Pre-compile about pages
  console.log("\nStep 3: Pre-compiling about pages...");
  for (const page of ABOUT_PAGES) {
    try {
      await buildAboutPage(page);
    } catch (error) {
      console.error(`  Error building about page ${page}:`, error.message);
    }
  }

  // Step 4: Pre-compile builtin workers
  console.log("\nStep 4: Pre-compiling builtin workers...");
  for (const worker of BUILTIN_WORKERS) {
    try {
      await buildBuiltinWorker(worker);
    } catch (error) {
      console.error(`  Error building builtin worker ${worker}:`, error.message);
    }
  }

  console.log("\n=== Production build complete! ===");
  console.log(`\nOutput directories:`);
  console.log(`  Shipped panels: ${SHIPPED_PANELS_DIR}`);
  console.log(`  About pages:    ${ABOUT_PAGES_DIR}`);
  console.log(`  Builtin workers: ${BUILTIN_WORKERS_DIR}`);
}

build().catch((error) => {
  console.error("Build failed:", error);
  process.exit(1);
});
