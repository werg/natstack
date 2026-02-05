/**
 * Panel Build Strategy
 *
 * Implements BuildStrategy for panel builds with browser-specific configuration:
 * - Platform: browser (node if unsafe)
 * - Target: es2022
 * - Format: esm (cjs if unsafe)
 * - Code splitting (unless unsafe)
 * - fs/path shims for safe mode
 * - React dedupe plugin
 * - ESM externals pinning
 * - HTML/CSS generation
 * - Asset collection
 */

import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";

import type {
  BuildStrategy,
  BuildContext,
  PanelBuildOptions,
  PlatformConfig,
  PanelArtifacts,
  PanelAssetMap,
} from "../types.js";
import type { PanelManifest } from "../../panelTypes.js";
import {
  isFsModule,
  isFsPromisesModule,
  generateFsShimCode,
  isPathModule,
  generatePathShimCode,
  isBareSpecifier,
  packageToRegex,
  DEFAULT_DEDUPE_PACKAGES,
} from "@natstack/typecheck";
import { isDev } from "../../utils.js";
import { ESM_SAFE_PACKAGES } from "../../lazyBuild/esmTransformer.js";
import { isVerdaccioServerInitialized } from "../../verdaccioServer.js";
import { getPackagesDir, getAppRoot } from "../../paths.js";
import { isVerbose } from "../../devLog.js";
import { PANEL_CSP_META } from "../../../shared/constants.js";
import { collectWorkersFromDependencies, workersToArray } from "../../../shared/collectWorkers.js";
import { analyzeBundleSize } from "../bundleAnalysis.js";

// ===========================================================================
// Constants
// ===========================================================================

const defaultPanelDependencies: Record<string, string> = {
  "@types/node": "^22.9.0",
  pathe: "^2.0.0",
};

const PANEL_ASSET_LOADERS: Record<string, esbuild.Loader> = {
  ".png": "file",
  ".jpg": "file",
  ".jpeg": "file",
  ".gif": "file",
  ".webp": "file",
  ".avif": "file",
  ".svg": "file",
  ".ico": "file",
  ".bmp": "file",
  ".tif": "file",
  ".tiff": "file",
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

// ===========================================================================
// Helper Functions
// ===========================================================================

/**
 * Get React dependencies from @natstack/react's peerDependencies.
 */
function getReactDependenciesFromNatstackReact(): Record<string, string> | null {
  try {
    const packagesDir = getPackagesDir();
    if (!packagesDir) return null;
    const natstackReactPkgPath = path.join(packagesDir, "react", "package.json");
    if (!fs.existsSync(natstackReactPkgPath)) {
      return null;
    }
    const pkg = JSON.parse(fs.readFileSync(natstackReactPkgPath, "utf-8")) as {
      peerDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const peerDeps = pkg.peerDependencies ?? {};
    const devDeps = pkg.devDependencies ?? {};
    const result: Record<string, string> = {};
    if (peerDeps["react"]) result["react"] = peerDeps["react"];
    if (peerDeps["react-dom"]) result["react-dom"] = peerDeps["react-dom"];
    if (devDeps["@types/react"]) result["@types/react"] = devDeps["@types/react"];
    if (devDeps["@types/react-dom"]) result["@types/react-dom"] = devDeps["@types/react-dom"];
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

/**
 * Create panel fs shim plugin.
 */
function createPanelFsShimPlugin(resolveDir: string): esbuild.Plugin {
  return {
    name: "panel-fs-shim",
    setup(build) {
      build.onResolve({ filter: /^(fs|node:fs|fs\/promises|node:fs\/promises)$/ }, (args) => {
        if (!isFsModule(args.path)) return null;
        return { path: args.path, namespace: "natstack-panel-fs-shim" };
      });

      build.onLoad({ filter: /.*/, namespace: "natstack-panel-fs-shim" }, (args) => {
        const isPromises = isFsPromisesModule(args.path);
        const contents = generateFsShimCode(isPromises);
        return { contents, loader: "js", resolveDir };
      });
    },
  };
}

/**
 * Create panel path shim plugin.
 */
function createPanelPathShimPlugin(resolveDir: string): esbuild.Plugin {
  return {
    name: "panel-path-shim",
    setup(build) {
      build.onResolve({ filter: /^(path|node:path|path\/posix|node:path\/posix)$/ }, (args) => {
        if (!isPathModule(args.path)) return null;
        return { path: args.path, namespace: "natstack-panel-path-shim" };
      });

      build.onLoad({ filter: /.*/, namespace: "natstack-panel-path-shim" }, () => {
        const contents = generatePathShimCode();
        return { contents, loader: "js", resolveDir };
      });
    },
  };
}

/**
 * Create a dedupe plugin for React and other singleton packages.
 */
function createDedupePlugin(
  runtimeNodeModules: string,
  additionalPackages: string[] = []
): esbuild.Plugin {
  const resolvedRuntimeNodeModules = path.resolve(runtimeNodeModules);
  const allPackages = [...DEFAULT_DEDUPE_PACKAGES, ...additionalPackages];

  const seen = new Set<string>();
  const patterns: RegExp[] = [];
  for (const pkg of allPackages) {
    if (!seen.has(pkg)) {
      seen.add(pkg);
      patterns.push(packageToRegex(pkg));
    }
  }

  return {
    name: "module-dedupe",
    setup(build) {
      for (const pattern of patterns) {
        build.onResolve({ filter: pattern }, async (args) => {
          if (path.resolve(args.resolveDir).startsWith(resolvedRuntimeNodeModules)) {
            return null;
          }
          try {
            const result = await build.resolve(args.path, {
              kind: args.kind,
              resolveDir: resolvedRuntimeNodeModules,
            });
            if (!result.errors || result.errors.length === 0) {
              return result;
            }
          } catch {
            // Resolution failed, fall back to default resolver
          }
          return null;
        });
      }
    },
  };
}

// ===========================================================================
// Banner Generation (imported from panelBuilder)
// ===========================================================================

/**
 * Generate the module map banner for runtime require.
 */
export function generateModuleMapBanner(): string {
  return `
// === NatStack Module Map (runs before all module code) ===
globalThis.__natstackModuleMap__ = globalThis.__natstackModuleMap__ || {};
globalThis.__natstackModuleLoadingPromises__ = globalThis.__natstackModuleLoadingPromises__ || {};

// Synchronous require - only works for pre-bundled modules
globalThis.__natstackRequire__ = function(id) {
  var mod = globalThis.__natstackModuleMap__[id];
  if (mod) return mod;
  throw new Error('Module "' + id + '" not available via require(). Use __natstackRequireAsync__ for dynamic loading or add it to exposeModules.');
};

// Async require - loads from CDN if not pre-bundled
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
      setTimeout(function() {
        reject(new Error('Timeout loading module "' + id + '" from CDN after ' + timeoutMs + 'ms'));
      }, timeoutMs);
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
      var message = err && typeof err === 'object' && 'message' in err ? err.message : String(err);
      throw new Error('Failed to load module "' + id + '" from CDN: ' + message);
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
 * Generate Node.js compatibility patch for hybrid environments.
 */
export function generateNodeCompatibilityPatch(): string {
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
          return;
        };
      }
    } catch (e) {}
  }
})();
`;
}

/**
 * Generate the async tracking banner for browser panels.
 */
export function generateAsyncTrackingBanner(): string {
  return generateAsyncTrackingBannerCore({
    label: "NatStack Async Tracking",
    globalObjExpr: 'typeof globalThis !== "undefined" ? globalThis : window',
    includeBrowserApis: true,
  });
}

interface AsyncTrackingBannerOptions {
  label: string;
  globalObjExpr: string;
  includeBrowserApis: boolean;
}

function generateAsyncTrackingBannerCore(options: AsyncTrackingBannerOptions): string {
  const { label, globalObjExpr, includeBrowserApis } = options;

  const browserApiWrappers = includeBrowserApis
    ? `
  if (globalObj.navigator && globalObj.navigator.clipboard) {
    ["read", "readText", "write", "writeText"].forEach(function(method) {
      var orig = globalObj.navigator.clipboard[method];
      if (orig) {
        globalObj.navigator.clipboard[method] = function() {
          return tagAndTrack(orig.apply(this, arguments));
        };
      }
    });
  }

  var originalCreateImageBitmap = globalObj.createImageBitmap;
  if (originalCreateImageBitmap) {
    globalObj.createImageBitmap = function() {
      return tagAndTrack(originalCreateImageBitmap.apply(this, arguments));
    };
  }`
    : "";

  return `
// === ${label} (runs before all module code) ===
(function() {
  "use strict";
  var globalObj = ${globalObjExpr};
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
    var ctx = {
      id: id,
      promises: new Set(),
      pauseCount: 0,
      timeoutId: null,
      maxTimeoutMs: options.maxTimeout || 0,
      createdAt: Date.now()
    };

    if (ctx.maxTimeoutMs > 0) {
      ctx.timeoutId = setTimeout(function() {
        destroyContext(id);
      }, ctx.maxTimeoutMs);
    }

    __contexts__.set(id, ctx);
    return ctx;
  }

  function destroyContext(contextId) {
    var ctx = __contexts__.get(contextId);
    if (!ctx) return;

    if (ctx.timeoutId) {
      clearTimeout(ctx.timeoutId);
      ctx.timeoutId = null;
    }

    ctx.promises.clear();
    __contexts__.delete(contextId);

    if (__currentContext__ && __currentContext__.id === contextId) {
      __currentContext__ = null;
    }
  }

  function trackInContext(ctx, p) {
    if (!p || typeof p.then !== "function") return p;
    if (__ignoredPromises__.has(p)) return p;

    var promiseCtx = __promiseContext__.get(p);
    if (promiseCtx !== ctx) return p;

    ctx.promises.add(p);

    originalThen.call(
      p,
      function(value) { ctx.promises.delete(p); return value; },
      function(err) { ctx.promises.delete(p); throw err; }
    );
    return p;
  }

  globalObj.__natstackAsyncTracking__ = {
    createContext: function(options) { return createContext(options); },
    start: function(options) {
      var ctx = createContext(options);
      __currentContext__ = ctx;
      return ctx;
    },
    enter: function(ctx) {
      if (ctx && __contexts__.has(ctx.id)) {
        __currentContext__ = ctx;
      }
    },
    exit: function() { __currentContext__ = null; },
    stop: function(ctx) {
      if (ctx) {
        destroyContext(ctx.id);
      } else if (__currentContext__) {
        destroyContext(__currentContext__.id);
        __currentContext__ = null;
      }
    },
    pause: function(ctx) {
      ctx = ctx || __currentContext__;
      if (ctx && __contexts__.has(ctx.id)) {
        ctx.pauseCount += 1;
      }
    },
    resume: function(ctx) {
      ctx = ctx || __currentContext__;
      if (ctx && __contexts__.has(ctx.id)) {
        ctx.pauseCount = Math.max(0, ctx.pauseCount - 1);
      }
    },
    ignore: function(p) {
      if (p && typeof p === "object") {
        __ignoredPromises__.add(p);
      }
      return p;
    },
    waitAll: function(timeoutMs, ctx) {
      ctx = ctx || __currentContext__;
      if (!ctx || !__contexts__.has(ctx.id)) {
        return OriginalPromise.resolve();
      }

      var deadline = Date.now() + timeoutMs;
      var waitPromise = new OriginalPromise(function(resolve, reject) {
        function check() {
          if (!__contexts__.has(ctx.id)) {
            resolve();
            return;
          }
          if (ctx.promises.size === 0) {
            resolve();
          } else if (Date.now() >= deadline) {
            reject(new Error("Async timeout: " + ctx.promises.size + " promises still pending"));
          } else {
            setTimeout(check, 50);
          }
        }
        check();
      });
      __ignoredPromises__.add(waitPromise);
      return waitPromise;
    },
    pending: function(ctx) {
      ctx = ctx || __currentContext__;
      if (!ctx || !__contexts__.has(ctx.id)) return 0;
      return ctx.promises.size;
    },
    activeContexts: function() {
      return Array.from(__contexts__.keys());
    }
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

  OriginalPromise.prototype.then = function(onFulfilled, onRejected) {
    if (__ignoredPromises__.has(this)) {
      var ignoredResult = originalThen.call(this, onFulfilled, onRejected);
      __ignoredPromises__.add(ignoredResult);
      return ignoredResult;
    }

    var result = originalThen.call(this, onFulfilled, onRejected);
    var ctx = __promiseContext__.get(this);
    if (ctx && __contexts__.has(ctx.id)) {
      __promiseContext__.set(result, ctx);
      trackInContext(ctx, result);
    }
    return result;
  };

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

  Object.getOwnPropertyNames(OriginalPromise).forEach(function(key) {
    if (Object.prototype.hasOwnProperty.call(TrackedPromise, key)) return;
    var desc = Object.getOwnPropertyDescriptor(OriginalPromise, key);
    if (!desc) return;
    try { Object.defineProperty(TrackedPromise, key, desc); } catch {}
  });
  Object.getOwnPropertySymbols(OriginalPromise).forEach(function(sym) {
    if (Object.prototype.hasOwnProperty.call(TrackedPromise, sym)) return;
    var desc = Object.getOwnPropertyDescriptor(OriginalPromise, sym);
    if (!desc) return;
    try { Object.defineProperty(TrackedPromise, sym, desc); } catch {}
  });

  globalObj.Promise = TrackedPromise;

  var originalFetch = globalObj.fetch;
  if (originalFetch) {
    globalObj.fetch = function() {
      var p = originalFetch.apply(this, arguments);
      return tagAndTrack(p);
    };
  }

  if (globalObj.Response && globalObj.Response.prototype) {
    ["json", "text", "blob", "arrayBuffer", "formData"].forEach(function(method) {
      var orig = globalObj.Response.prototype[method];
      if (orig) {
        globalObj.Response.prototype[method] = function() {
          return tagAndTrack(orig.call(this));
        };
      }
    });
  }

  if (globalObj.Blob && globalObj.Blob.prototype) {
    ["text", "arrayBuffer"].forEach(function(method) {
      var orig = globalObj.Blob.prototype[method];
      if (orig) {
        globalObj.Blob.prototype[method] = function() {
          return tagAndTrack(orig.call(this));
        };
      }
    });
  }
${browserApiWrappers}
})();
// === End ${label} ===
`;
}

// ===========================================================================
// Expose Module Helpers
// ===========================================================================

/**
 * Generate a module that imports dependencies and registers them to the module map.
 */
function generateExposeModuleCode(depsToExpose: string[]): string {
  if (depsToExpose.length === 0) {
    return `// === NatStack Module Expose ===\nexport {};\n`;
  }

  const importLines = depsToExpose.map(
    (dep, index) => `import * as __mod${index}__ from ${JSON.stringify(dep)};`
  );
  const registerLines = depsToExpose.map(
    (dep, index) =>
      `globalThis.__natstackModuleMap__[${JSON.stringify(dep)}] = __mod${index}__;`
  );

  return `// === NatStack Module Expose ===
${importLines.join("\n")}

globalThis.__natstackModuleMap__ = globalThis.__natstackModuleMap__ || {};
${registerLines.join("\n")}
`;
}

/**
 * Collect exposed dependencies from esbuild metafile.
 */
function collectExposedDepsFromMetafile(
  metafile: esbuild.Metafile,
  externalModules: Set<string>
): string[] {
  const deps = new Set<string>();

  for (const input of Object.values(metafile.inputs)) {
    for (const imp of input.imports) {
      if (imp.external) continue;
      if (!isBareSpecifier(imp.path)) continue;
      if (externalModules.has(imp.path)) continue;
      deps.add(imp.path);
    }
  }

  return [...deps].sort();
}

/**
 * Compare two sorted arrays for equality.
 */
function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ===========================================================================
// Panel Build Strategy
// ===========================================================================

export class PanelBuildStrategy
  implements BuildStrategy<PanelManifest, PanelArtifacts, PanelBuildOptions>
{
  readonly kind = "panel" as const;

  getPlatformConfig(options: PanelBuildOptions): PlatformConfig {
    const unsafe = Boolean(options.unsafe);
    return {
      platform: unsafe ? "node" : "browser",
      target: "es2022",
      format: unsafe ? "cjs" : "esm",
      conditions: ["natstack-panel"],
      splitting: !unsafe,
    };
  }

  getDefaultDependencies(): Record<string, string> {
    return { ...defaultPanelDependencies };
  }

  mergeDependencies(manifestDeps?: Record<string, string>): Record<string, string> {
    const merged = { ...defaultPanelDependencies };

    // If panel depends on @natstack/react, add React dependencies
    if (manifestDeps && "@natstack/react" in manifestDeps) {
      const reactDeps = getReactDependenciesFromNatstackReact();
      if (reactDeps) {
        Object.assign(merged, reactDeps);
      }
    }

    if (manifestDeps) {
      Object.assign(merged, manifestDeps);
    }
    return merged;
  }

  validateManifest(
    packageJson: Record<string, unknown>,
    sourcePath: string
  ): PanelManifest {
    if (!packageJson["natstack"]) {
      throw new Error(`package.json in ${sourcePath} must include a 'natstack' field`);
    }

    const manifest = packageJson["natstack"] as PanelManifest;

    if (!manifest.title) {
      throw new Error("natstack.title must be specified in package.json");
    }

    // Handle type inference from legacy runtime field
    if (!manifest.type) {
      if (manifest.runtime === "worker") {
        manifest.type = "worker";
      } else if (manifest.runtime === "panel" || typeof manifest.runtime === "undefined") {
        manifest.type = "app";
      }
    }

    // Merge package.json dependencies with natstack.dependencies
    const pkgDeps = packageJson["dependencies"] as Record<string, string> | undefined;
    if (pkgDeps) {
      manifest.dependencies = {
        ...manifest.dependencies,
        ...pkgDeps,
      };
    }

    return manifest;
  }

  getPlugins(
    ctx: BuildContext<PanelManifest>,
    options: PanelBuildOptions
  ): esbuild.Plugin[] {
    const plugins: esbuild.Plugin[] = [];
    const unsafe = Boolean(options.unsafe);

    if (!unsafe) {
      plugins.push(createPanelFsShimPlugin(ctx.workspace.depsDir));
      plugins.push(createPanelPathShimPlugin(getAppRoot()));
    }

    // Dedupe React and Radix if using @natstack/react
    if (ctx.manifest.dependencies && "@natstack/react" in ctx.manifest.dependencies) {
      plugins.push(
        createDedupePlugin(ctx.workspace.nodeModulesDir, ctx.manifest.dedupeModules)
      );
    }

    return plugins;
  }

  getExternals(
    ctx: BuildContext<PanelManifest>,
    _options: PanelBuildOptions
  ): string[] {
    const externals: Record<string, string> = { ...(ctx.manifest.externals ?? {}) };

    // Auto-externalize ESM-safe packages with version pinning
    if (isVerdaccioServerInitialized()) {
      const autoExternalized: string[] = [];
      for (const pkgName of ESM_SAFE_PACKAGES) {
        if (!(pkgName in externals)) {
          const version = ctx.esmVersions?.get(pkgName);
          const versionedPkg = version ? `${pkgName}@${version}` : pkgName;
          externals[pkgName] = `__VERDACCIO_ESM__/${versionedPkg}`;
          externals[`${pkgName}/`] = `__VERDACCIO_ESM__/${versionedPkg}/`;
          autoExternalized.push(version ? `${pkgName}@${version}` : pkgName);
        }
      }
      if (isVerbose() && autoExternalized.length > 0) {
        ctx.log(`Auto-externalizing ESM-safe packages: ${autoExternalized.join(", ")}`);
      }
    }

    return Object.keys(externals);
  }

  getBannerJs(
    _ctx: BuildContext<PanelManifest>,
    options: PanelBuildOptions
  ): string {
    const unsafe = Boolean(options.unsafe);

    if (unsafe) {
      const importMetaUrlShim =
        'var __import_meta_url = require("url").pathToFileURL(__filename).href;';
      return [
        importMetaUrlShim,
        generateNodeCompatibilityPatch(),
        generateAsyncTrackingBanner(),
        generateModuleMapBanner(),
      ].join("\n");
    }

    return [generateAsyncTrackingBanner(), generateModuleMapBanner()].join("\n");
  }

  getAdditionalEsbuildOptions(
    _ctx: BuildContext<PanelManifest>,
    options: PanelBuildOptions
  ): Partial<esbuild.BuildOptions> {
    const unsafe = Boolean(options.unsafe);

    return {
      loader: PANEL_ASSET_LOADERS,
      assetNames: "assets/[name]-[hash]",
      supported: unsafe ? { "dynamic-import": false } : undefined,
      define: unsafe ? { "import.meta.url": "__import_meta_url" } : undefined,
    };
  }

  async processResult(
    ctx: BuildContext<PanelManifest>,
    esbuildResult: esbuild.BuildResult,
    options: PanelBuildOptions
  ): Promise<PanelArtifacts> {
    const { workspace, manifest, sourcePath, log } = ctx;
    const unsafe = Boolean(options.unsafe);

    // Read bundle
    const bundlePath = path.join(workspace.buildDir, "bundle.js");
    const bundle = fs.readFileSync(bundlePath, "utf-8");

    // Analyze large bundles for debugging
    if (bundle.length > 10 * 1024 * 1024 && esbuildResult.metafile) {
      log(`Bundle size: ${(bundle.length / 1024 / 1024).toFixed(1)} MB (analyzing...)`);
      analyzeBundleSize(esbuildResult.metafile, log);
    }

    // Read CSS if exists
    const cssPath = bundlePath.replace(".js", ".css");
    const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf-8") : undefined;

    // Collect panel assets (chunks, images, fonts)
    // Note: Worker assets are handled by buildAuxiliary and merged by orchestrator
    const assets = this.collectPanelAssets(
      esbuildResult.metafile,
      workspace.buildDir,
      bundlePath,
      cssPath,
      log
    );

    // Generate HTML
    const externals: Record<string, string> = { ...(manifest.externals ?? {}) };
    // Add auto-externalized ESM packages to externals for import map
    if (isVerdaccioServerInitialized()) {
      for (const pkgName of ESM_SAFE_PACKAGES) {
        if (!(pkgName in externals)) {
          const version = ctx.esmVersions?.get(pkgName);
          const versionedPkg = version ? `${pkgName}@${version}` : pkgName;
          externals[pkgName] = `__VERDACCIO_ESM__/${versionedPkg}`;
          externals[`${pkgName}/`] = `__VERDACCIO_ESM__/${versionedPkg}/`;
        }
      }
    }

    const html = this.resolveHtml(sourcePath, manifest.title, externals, {
      includeCss: Boolean(css),
      unsafe,
    });

    log(`Build complete (${bundle.length} bytes JS)`);

    return {
      bundle,
      html,
      css,
      assets,
      // These will be updated by orchestrator after promotion to stable
      bundlePath: bundlePath,
      stableDir: workspace.buildDir,
    };
  }

  supportsShims(options: PanelBuildOptions): boolean {
    return !options.unsafe;
  }

  computeOptionsSuffix(options: PanelBuildOptions): string {
    const parts: string[] = [];

    if (options.unsafe) {
      if (typeof options.unsafe === "string") {
        parts.push(`unsafe:${options.unsafe}`);
      } else {
        parts.push("unsafe");
      }
    }

    if (options.sourcemap === false) {
      parts.push("nosm");
    }

    return parts.length > 0 ? `:${parts.join(":")}` : "";
  }

  getTsconfigCompilerOptions(_options: PanelBuildOptions): Record<string, unknown> {
    return {
      jsx: "react-jsx",
    };
  }

  // ===========================================================================
  // Multi-Pass Build Hooks
  // ===========================================================================

  /**
   * Generate wrapper entry files (_entry.js and _expose.js) for this build pass.
   * Returns the absolute path to the wrapper entry to use.
   */
  async prepareEntry(
    ctx: BuildContext<PanelManifest>,
    options: PanelBuildOptions
  ): Promise<string> {
    const {
      workspace,
      manifest,
      sourcePath,
      entryPoint,
      passState,
      lastMetafile,
      cacheManager,
      dependencyHash,
      log,
    } = ctx;

    // Build persistent cache key for expose modules
    const explicit = (manifest.exposeModules ?? [])
      .filter((spec): spec is string => typeof spec === "string")
      .map((spec) => spec.trim())
      .filter((spec) => spec.length > 0 && isBareSpecifier(spec));
    const exposeCacheKey = `expose:${ctx.canonicalPath}:${dependencyHash}:${explicit.sort().join(",")}`;

    // Get expose modules - check passState first, then persistent cache
    let exposeModules: string[] = (passState.get("exposeModules") as string[]) ?? [];

    if (ctx.passNumber === 1 && exposeModules.length === 0) {
      // First pass: try persistent cache from previous builds
      const cached = cacheManager.get(exposeCacheKey, isDev());
      if (cached) {
        try {
          exposeModules = JSON.parse(cached) as string[];
          passState.set("exposeModules", exposeModules);
          passState.set("usedCache", true); // Flag to skip second pass
          log(`Using cached expose modules (${exposeModules.length} modules)`);
        } catch {
          log(`Invalid expose modules cache, rebuilding`);
        }
      }
    } else if (ctx.passNumber > 1 && lastMetafile) {
      // Second pass: analyze previous pass's metafile
      const externalSet = new Set(this.getExternals(ctx, options));
      const discovered = collectExposedDepsFromMetafile(lastMetafile, externalSet);
      exposeModules = [...new Set([...discovered, ...explicit])].sort();
      passState.set("exposeModules", exposeModules);

      // Persist to cache for future builds
      await cacheManager.set(exposeCacheKey, JSON.stringify(exposeModules));
      log(`Cached expose modules for future builds`);
    }

    // Generate _expose.js
    const exposeCode = generateExposeModuleCode(exposeModules);
    fs.writeFileSync(path.join(workspace.buildDir, "_expose.js"), exposeCode);

    // Generate _entry.js wrapper
    const hasReact = "@natstack/react" in (manifest.dependencies ?? {});
    const relativeEntry = path.relative(
      workspace.buildDir,
      path.join(sourcePath, entryPoint)
    );

    const wrapperCode = hasReact
      ? `import "./_expose.js";
import { autoMountReactPanel, shouldAutoMount } from "@natstack/react";
import * as userModule from ${JSON.stringify(relativeEntry)};

if (shouldAutoMount(userModule)) {
  autoMountReactPanel(userModule);
}
`
      : `import "./_expose.js";
import ${JSON.stringify(relativeEntry)};
`;

    const wrapperPath = path.join(workspace.buildDir, "_entry.js");
    fs.writeFileSync(wrapperPath, wrapperCode);

    return wrapperPath; // Return absolute path
  }

  /**
   * Check if another build pass is needed based on expose module discovery.
   */
  shouldRebuild(
    ctx: BuildContext<PanelManifest>,
    esbuildResult: esbuild.BuildResult,
    options: PanelBuildOptions
  ): boolean {
    // Only allow one rebuild pass
    if (ctx.passNumber >= 2) return false;

    // Skip if we used persistent cache (already have correct expose modules)
    if (ctx.passState.get("usedCache")) return false;

    const metafile = esbuildResult.metafile;
    if (!metafile) return false;

    const externalSet = new Set(this.getExternals(ctx, options));
    const discovered = collectExposedDepsFromMetafile(metafile, externalSet);

    const explicit = (ctx.manifest.exposeModules ?? [])
      .filter((spec): spec is string => typeof spec === "string")
      .map((spec) => spec.trim())
      .filter((spec) => spec.length > 0 && isBareSpecifier(spec) && !externalSet.has(spec));

    const newModules = [...new Set([...discovered, ...explicit])].sort();
    const oldModules = (ctx.passState.get("exposeModules") as string[]) ?? [];

    // Store the new modules for next pass
    if (!arraysEqual(newModules, oldModules)) {
      ctx.passState.set("exposeModules", newModules);
      ctx.log(`Expose modules changed: ${oldModules.length} → ${newModules.length}, rebuilding`);
      return true;
    }

    return false;
  }

  /**
   * Build auxiliary bundles (workers) after main bundle is complete.
   */
  async buildAuxiliary(
    ctx: BuildContext<PanelManifest>,
    _mainResult: esbuild.BuildResult,
    _options: PanelBuildOptions
  ): Promise<Partial<PanelArtifacts> | undefined> {
    const { workspace, nodePaths, log } = ctx;

    const workers = collectWorkersFromDependencies(workspace.nodeModulesDir, {
      log: (msg) => log(msg),
    });
    const workerEntries = workersToArray(workers);

    if (workerEntries.length === 0) return undefined;

    log(`Building ${workerEntries.length} auxiliary worker bundles...`);

    const req = createRequire(import.meta.url);
    const resolveWithPaths = (specifier: string): string | null => {
      try {
        return req.resolve(specifier, { paths: nodePaths });
      } catch {
        return null;
      }
    };

    const assets: PanelAssetMap = {};

    for (const entry of workerEntries) {
      const entryPath = resolveWithPaths(entry.specifier);
      if (!entryPath || !fs.existsSync(entryPath)) {
        log(`Warning: Could not resolve worker: ${entry.specifier}`);
        continue;
      }

      const outfile = path.join(workspace.buildDir, entry.name);
      fs.mkdirSync(path.dirname(outfile), { recursive: true });

      await esbuild.build({
        entryPoints: [entryPath],
        bundle: true,
        platform: "browser",
        target: "es2022",
        format: "esm",
        outfile,
        sourcemap: false,
        logLevel: "silent",
        nodePaths,
        conditions: ["natstack-panel"],
      });

      assets[`/${entry.name}`] = { content: fs.readFileSync(outfile, "utf-8") };
    }

    if (Object.keys(assets).length === 0) return undefined;

    const packages = [...new Set(workerEntries.map((e) => e.declaredBy))];
    log(`Built ${Object.keys(assets).length} worker assets from: ${packages.join(", ")}`);

    return { assets };
  }

  // ===========================================================================
  // Private Helper Methods
  // ===========================================================================

  private resolveHtml(
    sourcePath: string,
    title: string,
    externals?: Record<string, string>,
    options: { includeCss?: boolean; unsafe?: boolean } = {}
  ): string {
    const sourceHtmlPath = path.join(sourcePath, "index.html");
    if (fs.existsSync(sourceHtmlPath)) {
      return fs.readFileSync(sourceHtmlPath, "utf-8");
    }

    const importMap = { imports: externals ?? {} };
    const importMapScript =
      Object.keys(importMap.imports).length > 0
        ? `<script type="importmap">${JSON.stringify(importMap)}</script>\n  `
        : "";

    const cssLink = options.includeCss
      ? `\n  <link rel=\"stylesheet\" href=\"./bundle.css\" />`
      : "";
    const scriptType = options.unsafe ? "" : ' type="module"';

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

  private collectPanelAssets(
    metafile: esbuild.Metafile | undefined,
    buildDir: string,
    bundlePath: string,
    cssPath: string,
    log?: (message: string) => void
  ): PanelAssetMap | undefined {
    if (!metafile) return undefined;

    const outputs = Object.keys(metafile.outputs ?? {});
    if (outputs.length === 0) return undefined;

    const bundleDir = path.dirname(path.resolve(bundlePath));
    const ignoredOutputs = new Set([path.resolve(bundlePath), path.resolve(cssPath)]);
    const assets: PanelAssetMap = {};

    for (const output of outputs) {
      let absoluteOutput: string;

      if (path.isAbsolute(output)) {
        absoluteOutput = output;
      } else {
        const fullPathInBuildDir = path.join(buildDir, output);
        if (fs.existsSync(fullPathInBuildDir)) {
          absoluteOutput = fullPathInBuildDir;
        } else {
          absoluteOutput = path.join(buildDir, path.basename(output));
        }
      }

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

    const assetCount = Object.keys(assets).length;
    if (assetCount === 0) return undefined;

    const chunkCount = Object.keys(assets).filter(
      (k) => k.startsWith("/chunk-") && k.endsWith(".js")
    ).length;
    if (chunkCount > 0) {
      log?.(`Bundled ${assetCount} panel assets (${chunkCount} code chunks).`);
    } else {
      log?.(`Bundled ${assetCount} panel asset${assetCount === 1 ? "" : "s"}.`);
    }

    return assets;
  }
}
