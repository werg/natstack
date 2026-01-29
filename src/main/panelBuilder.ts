import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import Arborist from "@npmcli/arborist";
import * as ts from "typescript";
import { createRequire } from "module";
import type { PanelManifest } from "./panelTypes.js";
import { getMainCacheManager } from "./cacheManager.js";
import { isDev } from "./utils.js";
import { provisionPanelVersion, resolveTargetCommit, type VersionSpec } from "./gitProvisioner.js";
import type { PanelBuildState, ProtocolBuildArtifacts } from "../shared/ipc/types.js";
import { createBuildWorkspace, type BuildArtifactKey } from "./build/artifacts.js";
import { analyzeBundleSize } from "./build/bundleAnalysis.js";
import { collectWorkersFromDependencies, workersToArray } from "../shared/collectWorkers.js";
import { PANEL_CSP_META } from "../shared/constants.js";
import {
  isFsModule,
  isFsPromisesModule,
  generateFsShimCode,
  isPathModule,
  generatePathShimCode,
  isBareSpecifier,
  packageToRegex,
  DEFAULT_DEDUPE_PACKAGES,
  createTypeCheckService,
  createDiskFileSource,
  loadSourceFiles,
  type TypeCheckDiagnostic,
} from "@natstack/runtime/typecheck";
import { isVerdaccioServerInitialized, getVerdaccioServer } from "./verdaccioServer.js";
import { getPackagesDir, getAppNodeModules, getActiveWorkspace, getAppRoot } from "./paths.js";
import {
  getPackageStore,
  createPackageFetcher,
  createPackageLinker,
  collectPackagesFromTree,
  serializeTree,
  type SerializedTree,
} from "./package-store/index.js";

// ===========================================================================
// Shared Build Plugins
// ===========================================================================

/**
 * Create a panel fs shim plugin that maps fs imports to @natstack/runtime.
 * Panels run in the browser and use ZenFS (OPFS-backed), so sync methods are not available.
 *
 * Uses shared resolution logic from @natstack/runtime/typecheck to ensure
 * build-time and type-check-time resolution are consistent.
 *
 * @param resolveDir - Directory to use for resolving @natstack/runtime imports
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
 * Create a panel path shim plugin that maps path imports to pathe.
 * pathe is a browser-compatible path library that works identically to Node's path.
 *
 * Uses shared resolution logic from @natstack/runtime/typecheck to ensure
 * build-time and type-check-time resolution are consistent.
 *
 * @param resolveDir - Directory to use for resolving pathe imports
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
 * Generate a module that imports dependencies and registers them to the module map.
 * This keeps bundled instances shared while avoiding export shape issues.
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
 * Generate banner that initializes the runtime require function.
 * This runs before any module code, so the map is ready when registrations happen.
 * Supports both sync require (for pre-bundled modules) and async require (for dynamic loading via CDN).
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
  // Return immediately if already loaded
  if (globalThis.__natstackModuleMap__[id]) {
    return globalThis.__natstackModuleMap__[id];
  }

  // Check if already loading
  if (globalThis.__natstackModuleLoadingPromises__[id]) {
    return globalThis.__natstackModuleLoadingPromises__[id];
  }

  // Load from esm.sh CDN with timeout
  var loadPromise = (async function() {
    var timeoutMs = 30000; // 30 second timeout
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
      // Clear cached promise on failure to allow retry
      delete globalThis.__natstackModuleLoadingPromises__[id];
      var message = err && typeof err === 'object' && 'message' in err ? err.message : String(err);
      throw new Error('Failed to load module "' + id + '" from CDN: ' + message);
    }
  })();

  globalThis.__natstackModuleLoadingPromises__[id] = loadPromise;
  return loadPromise;
};

// Pre-load multiple modules in parallel
globalThis.__natstackPreloadModules__ = async function(moduleIds) {
  return Promise.all(moduleIds.map(function(id) {
    return globalThis.__natstackRequireAsync__(id);
  }));
};
// === End Module Map ===
`;
}

/**
 * Options for generating the async tracking banner.
 */
interface AsyncTrackingBannerOptions {
  /** Banner comment label (e.g., "NatStack Async Tracking" or "NatStack Async Tracking for Workers") */
  label: string;
  /** How to get globalThis (browser needs fallback to window) */
  globalObjExpr: string;
  /** Whether to include browser-only API wrappers (clipboard, createImageBitmap) */
  includeBrowserApis: boolean;
}

/**
 * Generate a compatibility patch for running Node.js code in Electron's hybrid environment.
 *
 * In Electron with nodeIntegration, we have a mix of browser and Node.js APIs.
 * Some Node.js APIs (like events.setMaxListeners) don't recognize browser globals
 * (like AbortSignal) even though they're functionally equivalent.
 *
 * This patch makes Node.js's events module tolerate browser AbortSignal.
 */
export function generateNodeCompatibilityPatch(): string {
  return `
// === Node.js Compatibility Patch ===

// Patch events.setMaxListeners to accept browser AbortSignal
// (Node.js events module doesn't recognize browser's AbortSignal as EventTarget)
(function() {
  if (typeof require === 'function' && typeof AbortSignal !== 'undefined') {
    try {
      var nodeEvents = require('events');
      if (nodeEvents && typeof nodeEvents.setMaxListeners === 'function') {
        var originalSetMaxListeners = nodeEvents.setMaxListeners;
        nodeEvents.setMaxListeners = function(n) {
          var eventTargets = Array.prototype.slice.call(arguments, 1);
          // Filter to targets that Node.js events module can handle
          var compatibleTargets = eventTargets.filter(function(t) {
            // Accept EventEmitters and Node.js EventTargets, skip browser AbortSignals
            return t instanceof nodeEvents.EventEmitter ||
                   (t && t.constructor && t.constructor.name !== 'AbortSignal');
          });
          if (compatibleTargets.length > 0) {
            return originalSetMaxListeners.apply(this, [n].concat(compatibleTargets));
          }
          // If only AbortSignals, just return (ignore the call gracefully)
          return;
        };
      }
    } catch (e) {
      // Ignore - events module not available
    }
  }
})();
`;
}

/**
 * Generate the core async tracking banner code.
 * This is shared between browser panels and Node.js workers.
 *
 * Uses a faceted/context-based approach where each tracking session (context)
 * has its own isolated set of tracked promises. Contexts can be cleaned up
 * independently and have optional automatic timeouts to prevent memory leaks.
 */
function generateAsyncTrackingBannerCore(options: AsyncTrackingBannerOptions): string {
  const { label, globalObjExpr, includeBrowserApis } = options;

  // Browser-only API wrappers (clipboard, createImageBitmap)
  const browserApiWrappers = includeBrowserApis
    ? `
  // Wrap clipboard methods (browser only)
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

  // Wrap createImageBitmap (browser only)
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
  // Store original then BEFORE any wrapping - used by trackInContext to avoid recursion
  var originalThen = OriginalPromise.prototype.then;

  // WeakSet for promises that should never be tracked (e.g., internal wait promises)
  var __ignoredPromises__ = new WeakSet();
  // WeakMap: promise -> context that owns it
  var __promiseContext__ = new WeakMap();

  // Active tracking contexts (faceted approach)
  // Each context has its own promise set and can be cleaned up independently
  var __contexts__ = new Map(); // contextId -> { promises: Set, timeoutId, pauseCount }
  var __nextContextId__ = 1;

  // Current context for tagging new promises
  var __currentContext__ = null;

  function createContext(options) {
    options = options || {};
    var id = __nextContextId__++;
    var ctx = {
      id: id,
      promises: new Set(),
      pauseCount: 0,
      timeoutId: null,
      maxTimeoutMs: options.maxTimeout || 0, // 0 = no auto-cleanup
      createdAt: Date.now()
    };

    // Set up auto-cleanup timeout if configured
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

    // Clear timeout if set
    if (ctx.timeoutId) {
      clearTimeout(ctx.timeoutId);
      ctx.timeoutId = null;
    }

    // Clear promise references (WeakMap entries will be GC'd automatically)
    ctx.promises.clear();

    // Remove context
    __contexts__.delete(contextId);

    // If this was the current context, clear it
    if (__currentContext__ && __currentContext__.id === contextId) {
      __currentContext__ = null;
    }
  }

  function trackInContext(ctx, p) {
    if (!p || typeof p.then !== "function") return p;
    if (__ignoredPromises__.has(p)) return p;

    // Only track if promise belongs to this context
    var promiseCtx = __promiseContext__.get(p);
    if (promiseCtx !== ctx) return p;

    ctx.promises.add(p);

    // Use originalThen (stored before wrapping) to avoid recursion
    originalThen.call(
      p,
      function(value) { ctx.promises.delete(p); return value; },
      function(err) { ctx.promises.delete(p); throw err; }
    );
    return p;
  }

  globalObj.__natstackAsyncTracking__ = {
    /** Create a new tracking context. */
    createContext: function(options) { return createContext(options); },

    /** Start tracking in a context (creates new context and sets as current). */
    start: function(options) {
      var ctx = createContext(options);
      __currentContext__ = ctx;
      return ctx;
    },

    /** Enter a tracking context (set as current for new promises). */
    enter: function(ctx) {
      if (ctx && __contexts__.has(ctx.id)) {
        __currentContext__ = ctx;
      }
    },

    /** Exit the current tracking context. */
    exit: function() { __currentContext__ = null; },

    /** Stop and destroy a context, cleaning up all references. */
    stop: function(ctx) {
      if (ctx) {
        destroyContext(ctx.id);
      } else if (__currentContext__) {
        destroyContext(__currentContext__.id);
        __currentContext__ = null;
      }
    },

    /** Pause tracking in a context (nested pause supported). */
    pause: function(ctx) {
      ctx = ctx || __currentContext__;
      if (ctx && __contexts__.has(ctx.id)) {
        ctx.pauseCount += 1;
      }
    },

    /** Resume tracking in a context. */
    resume: function(ctx) {
      ctx = ctx || __currentContext__;
      if (ctx && __contexts__.has(ctx.id)) {
        ctx.pauseCount = Math.max(0, ctx.pauseCount - 1);
      }
    },

    /** Mark a promise as ignored (never tracked in any context). */
    ignore: function(p) {
      if (p && typeof p === "object") {
        __ignoredPromises__.add(p);
      }
      return p;
    },

    /** Wait for all promises in a context to settle. */
    waitAll: function(timeoutMs, ctx) {
      ctx = ctx || __currentContext__;
      if (!ctx || !__contexts__.has(ctx.id)) {
        return OriginalPromise.resolve();
      }

      var deadline = Date.now() + timeoutMs;
      var waitPromise = new OriginalPromise(function(resolve, reject) {
        function check() {
          // Context may have been destroyed
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

    /** Get pending promise count for a context. */
    pending: function(ctx) {
      ctx = ctx || __currentContext__;
      if (!ctx || !__contexts__.has(ctx.id)) return 0;
      return ctx.promises.size;
    },

    /** Get all active context IDs (for debugging). */
    activeContexts: function() {
      return Array.from(__contexts__.keys());
    }
  };

  // Wrap Promise constructor
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

  // Wrap Promise.prototype.then to propagate context
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

  // Helper to tag and track in current context
  function tagAndTrack(p) {
    var ctx = __currentContext__;
    if (ctx && __contexts__.has(ctx.id) && ctx.pauseCount === 0) {
      __promiseContext__.set(p, ctx);
      trackInContext(ctx, p);
    }
    return p;
  }

  // Wrap static Promise methods
  TrackedPromise.resolve = function(v) { return tagAndTrack(OriginalPromise.resolve(v)); };
  TrackedPromise.reject = function(v) { return tagAndTrack(OriginalPromise.reject(v)); };
  TrackedPromise.all = function(v) { return tagAndTrack(OriginalPromise.all(v)); };
  TrackedPromise.allSettled = function(v) { return tagAndTrack(OriginalPromise.allSettled(v)); };
  TrackedPromise.race = function(v) { return tagAndTrack(OriginalPromise.race(v)); };
  TrackedPromise.any = function(v) { return tagAndTrack(OriginalPromise.any(v)); };

  // Copy other static properties
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

  // Wrap fetch
  var originalFetch = globalObj.fetch;
  if (originalFetch) {
    globalObj.fetch = function() {
      var p = originalFetch.apply(this, arguments);
      return tagAndTrack(p);
    };
  }

  // Wrap Response methods
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

  // Wrap Blob methods
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

/**
 * Generate the async tracking banner for browser panels.
 * Includes browser-specific API wrappers (clipboard, createImageBitmap).
 */
export function generateAsyncTrackingBanner(): string {
  return generateAsyncTrackingBannerCore({
    label: "NatStack Async Tracking",
    globalObjExpr: 'typeof globalThis !== "undefined" ? globalThis : window',
    includeBrowserApis: true,
  });
}

// ===========================================================================
// Child Panel Build Types
// ===========================================================================

/**
 * Progress callback for child panel builds.
 */
export interface BuildProgress {
  state: PanelBuildState;
  message: string;
  log?: string;
}

type PanelAssetMap = NonNullable<ProtocolBuildArtifacts["assets"]>;
type PanelAssetEntry = PanelAssetMap[string];

/**
 * Result of building a child panel.
 * Includes in-memory artifacts for serving via natstack-panel:// protocol.
 */
export interface ChildBuildResult {
  success: boolean;
  /** The bundled JavaScript code */
  bundle?: string;
  /** Generated HTML template */
  html?: string;
  /** CSS bundle if any */
  css?: string;
  /** Additional asset files (path -> content + encoding) */
  assets?: PanelAssetMap;
  /** Panel manifest */
  manifest?: PanelManifest;
  /** Error message if build failed */
  error?: string;
  /** Full build log (for UI) */
  buildLog?: string;
}

/** Bundle size limits for panel builds (generous to avoid disrupting normal use) */
const BUNDLE_SIZE_LIMITS = {
  /** Maximum JS bundle size (150 MB) */
  MAX_JS_BYTES: 150 * 1024 * 1024,
  /** Maximum HTML size */
  MAX_HTML_BYTES: 10 * 1024 * 1024,
  /** Maximum CSS size */
  MAX_CSS_BYTES: 10 * 1024 * 1024,
} as const;

const defaultPanelDependencies: Record<string, string> = {
  // Node types for dependencies that expect them
  "@types/node": "^22.9.0",
  // Browser-compatible path module for shim (enables import * as path from "path")
  "pathe": "^2.0.0",
};

const defaultWorkerDependencies: Record<string, string> = {
  // Node types for dependencies that expect them
  "@types/node": "^22.9.0",
  // Browser-compatible path module for shim (enables import * as path from "path")
  "pathe": "^2.0.0",
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

/**
 * Get React dependencies from @natstack/react's peerDependencies.
 * Returns null if @natstack/react package.json can't be found.
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
    // Add React runtime packages
    if (peerDeps["react"]) result["react"] = peerDeps["react"];
    if (peerDeps["react-dom"]) result["react-dom"] = peerDeps["react-dom"];
    // Add @types packages for type checking (React 19 doesn't bundle types)
    if (devDeps["@types/react"]) result["@types/react"] = devDeps["@types/react"];
    if (devDeps["@types/react-dom"]) result["@types/react-dom"] = devDeps["@types/react-dom"];
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

/**
 * Result of building a worker.
 * Contains just the JS bundle (no HTML/CSS needed).
 */
export interface WorkerBuildResult {
  success: boolean;
  /** The bundled JavaScript code */
  bundle?: string;
  /** Worker manifest */
  manifest?: PanelManifest;
  /** Error message if build failed */
  error?: string;
  /** Full build log (for UI) */
  buildLog?: string;
}

// ===========================================================================
// Internal Build Types
// ===========================================================================

interface BuildFromSourceOptions {
  /** Absolute path to the panel source directory */
  sourcePath: string;
  /** Stable key used to locate shared build artifacts (deps) */
  artifactKey: BuildArtifactKey;
  /** Previous dependency hash for cache optimization */
  previousDependencyHash?: string;
  /** Logger function for build output */
  log?: (message: string) => void;
  /** Whether to emit inline sourcemaps (default: true) */
  inlineSourcemap?: boolean;
  /**
   * Run panel with full Node.js API access instead of browser sandbox.
   * - `true`: Unsafe mode with default scoped filesystem
   * - `string`: Unsafe mode with custom filesystem root (e.g., "/" for full access)
   */
  unsafe?: boolean | string;
}

interface BuildFromSourceResult {
  success: boolean;
  /** The manifest from package.json */
  manifest?: PanelManifest;
  /** Bundled JavaScript code */
  bundle?: string;
  /** HTML document */
  html?: string;
  /** CSS bundle if generated */
  css?: string;
  /** Additional asset files (path -> content + encoding) */
  assets?: PanelAssetMap;
  /** Error message on failure */
  error?: string;
  /** Hash of dependencies for caching */
  dependencyHash?: string;
  /** Warning message (e.g., partial build success) */
  warning?: string;
  /** TypeScript type errors found during build */
  typeErrors?: TypeCheckDiagnostic[];
}

export class PanelBuilder {
  private cacheManager = getMainCacheManager();

  /** Last known Verdaccio versions (for detecting changes) */
  private lastVerdaccioVersions: Record<string, string> | null = null;

  /** Per-panel cache of relevant @natstack package versions */
  private panelRelevantVersionsCache = new Map<string, Record<string, string>>();

  /**
   * Get cached dependency hash for a panel source path.
   * This helps avoid unnecessary npm installs when dependencies haven't changed.
   */
  private getDependencyHashFromCache(cacheKey: string): string | undefined {
    const cached = this.cacheManager.get(cacheKey, isDev());
    return cached ?? undefined;
  }

  /**
   * Save dependency hash to cache
   */
  private async saveDependencyHashToCache(cacheKey: string, hash: string): Promise<void> {
    await this.cacheManager.set(cacheKey, hash);
  }

  /**
   * Get a hash of all current Verdaccio package versions.
   * Used in cache keys to invalidate when any workspace dependency changes.
   * Includes both @natstack/* and user workspace packages (@workspace/*, @workspace-panels/*, @workspace-workers/*).
   * Returns empty string if Verdaccio is not initialized.
   */
  private async getVerdaccioVersionsHash(): Promise<string> {
    if (!isVerdaccioServerInitialized()) {
      return "";
    }

    try {
      const verdaccio = getVerdaccioServer();

      // Get @natstack/* package versions
      const natstackVersions = await verdaccio.getVerdaccioVersions();

      // Get user workspace package versions (@workspace/*, @workspace-panels/*, @workspace-workers/*)
      const userWorkspace = getActiveWorkspace();
      const userWorkspaceVersions = userWorkspace
        ? await verdaccio.getUserWorkspaceVersions(userWorkspace.path)
        : {};

      // Merge all versions
      const allVersions = { ...natstackVersions, ...userWorkspaceVersions };

      if (Object.keys(allVersions).length === 0) {
        return "";
      }

      const sorted = Object.keys(allVersions).sort();
      return crypto.createHash("sha256").update(JSON.stringify(allVersions, sorted)).digest("hex").slice(0, 12);
    } catch {
      return "";
    }
  }

  private readUserCompilerOptions(sourcePath: string): Record<string, unknown> {
    const tsconfigPath = path.join(sourcePath, "tsconfig.json");
    if (!fs.existsSync(tsconfigPath)) {
      return {};
    }

    try {
      const visited = new Set<string>();
      const read = (configPath: string): Record<string, unknown> => {
        const resolvedPath = path.resolve(configPath);
        if (visited.has(resolvedPath)) {
          return {};
        }
        visited.add(resolvedPath);

        const content = fs.readFileSync(resolvedPath, "utf-8");
        const parsed = ts.parseConfigFileTextToJson(resolvedPath, content);
        const config = (parsed.config ?? {}) as {
          extends?: string | string[];
          compilerOptions?: Record<string, unknown>;
        };

        const baseExtends = config.extends;
        let baseOptions: Record<string, unknown> = {};
        if (typeof baseExtends === "string") {
          const basePath = this.resolveTsconfigExtends(resolvedPath, baseExtends);
          if (basePath) {
            baseOptions = read(basePath);
          }
        }

        return { ...baseOptions, ...(config.compilerOptions ?? {}) };
      };

      return read(tsconfigPath);
    } catch {
      return {};
    }
  }

  private resolveTsconfigExtends(fromTsconfigPath: string, extendsValue: string): string | null {
    const baseDir = path.dirname(fromTsconfigPath);

    // Relative/absolute path (most common)
    const isFileLike =
      extendsValue.startsWith(".") ||
      extendsValue.startsWith("/") ||
      extendsValue.includes(path.sep) ||
      extendsValue.includes("/");
    if (isFileLike) {
      const candidate = path.resolve(baseDir, extendsValue);
      const withJson = candidate.endsWith(".json") ? candidate : `${candidate}.json`;
      if (fs.existsSync(candidate)) return candidate;
      if (fs.existsSync(withJson)) return withJson;
      return null;
    }

    // Package-style specifier: best-effort support
    // (tsc supports resolving node module tsconfigs; we keep this conservative)
    try {
      const req = createRequire(import.meta.url);
      const resolved = req.resolve(extendsValue, { paths: [baseDir] });
      return resolved;
    } catch {
      return null;
    }
  }

  private pickSafeCompilerOptions(
    userCompilerOptions: Record<string, unknown>,
    kind: "panel" | "worker"
  ): Record<string, unknown> {
    const allowlist = new Set<string>([
      "experimentalDecorators",
      "emitDecoratorMetadata",
      "useDefineForClassFields",
    ]);

    if (kind === "panel") {
      allowlist.add("jsxImportSource");
    }

    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(userCompilerOptions)) {
      if (allowlist.has(key) && value !== undefined) {
        safe[key] = value;
      }
    }
    return safe;
  }

  private writeBuildTsconfig(
    buildDir: string,
    sourcePath: string,
    kind: "panel" | "worker",
    baseCompilerOptions: Record<string, unknown>
  ): string {
    const userOptions = this.readUserCompilerOptions(sourcePath);
    const safeOverrides = this.pickSafeCompilerOptions(userOptions, kind);
    const compilerOptions = { ...baseCompilerOptions, ...safeOverrides };

    const tsconfigPath = path.join(buildDir, "tsconfig.json");
    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify(
        {
          compilerOptions,
        },
        null,
        2
      )
    );
    return tsconfigPath;
  }

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

    // Import map for externals declared in natstack.externals
    // These are loaded via CDN (e.g., esm.sh) instead of bundled.
    const importMap = { imports: externals ?? {} };
    const importMapScript =
      Object.keys(importMap.imports).length > 0
        ? `<script type="importmap">${JSON.stringify(importMap)}</script>\n  `
        : "";

    const cssLink = options.includeCss ? `\n  <link rel=\"stylesheet\" href=\"./bundle.css\" />` : "";

    // Script type must match bundle format:
    // - Unsafe panels: CJS format (require()) → no type attribute (classic script)
    // - Safe panels: ESM format (import/export) → type="module" required
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

  private getNodeResolutionPaths(sourcePath: string, runtimeNodeModules: string): string[] {
    const localNodeModules = path.join(sourcePath, "node_modules");
    const projectNodeModules = getAppNodeModules();

    const paths: string[] = [];
    for (const candidate of [runtimeNodeModules, localNodeModules, projectNodeModules]) {
      paths.push(candidate);
    }
    return paths;
  }

  /**
   * Run TypeScript type checking on a panel or worker source directory.
   * Returns an array of type errors (diagnostics with severity "error").
   */
  private async runTypeCheck(
    sourcePath: string,
    runtimeNodeModules: string,
    log: (message: string) => void,
    _dependencies?: Record<string, string>
  ): Promise<TypeCheckDiagnostic[]> {
    log(`Type checking...`);

    try {
      // Create file source for reading from disk
      const fileSource = createDiskFileSource(sourcePath);

      // Load all TypeScript source files
      const files = await loadSourceFiles(fileSource, ".");
      if (files.size === 0) {
        log(`No TypeScript files found to type check`);
        return [];
      }

      log(`Type checking ${files.size} files...`);

      // Find workspace root for loading @natstack package types
      const packagesDir = getPackagesDir();
      const workspaceRoot = packagesDir ? path.dirname(packagesDir) : undefined;
      // Get user workspace path for @workspace-panels/* and @workspace-workers/* resolution
      const userWorkspace = getActiveWorkspace();

      // Create type check service that loads types from the build's node_modules.
      // React, @types/react, and other deduplicated packages are installed here.
      const service = createTypeCheckService({
        panelPath: sourcePath,
        resolution: {
          fsShimEnabled: true,
          runtimeNodeModules,
        },
        workspaceRoot,
        skipSuggestions: true, // Build-time: only errors, not suggestions
        // Load types directly from the build's node_modules
        nodeModulesPaths: [runtimeNodeModules],
        // Enable resolution of @workspace-panels/* and @workspace-workers/* from workspace
        userWorkspacePath: userWorkspace?.path,
      });

      // Add all source files to the service with absolute paths
      // TypeScript's module resolution uses absolute paths, so we need to match
      for (const [relativePath, content] of files) {
        const absolutePath = path.join(sourcePath, relativePath);
        service.updateFile(absolutePath, content);
      }

      // Run type checking with automatic external type loading
      // checkWithExternalTypes handles the transitive dependency loop internally
      const result = await service.checkWithExternalTypes();

      // Filter to only errors (not warnings or suggestions)
      const errors = result.diagnostics.filter((d) => d.severity === "error");

      if (errors.length > 0) {
        log(`Type check found ${errors.length} error(s)`);
      } else {
        log(`Type check passed`);
      }

      return errors;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Type check failed: ${message}`);
      // Return a synthetic error diagnostic
      return [{
        file: sourcePath,
        line: 1,
        column: 1,
        message: `Type checking failed: ${message}`,
        severity: "error",
        code: 0,
        category: ts.DiagnosticCategory.Error,
      }];
    }
  }

  loadManifest(panelPath: string): PanelManifest {
    const absolutePanelPath = path.resolve(panelPath);
    const packageJsonPath = path.join(absolutePanelPath, "package.json");

    if (!fs.existsSync(packageJsonPath)) {
      throw new Error(`package.json not found in ${panelPath}`);
    }

    const packageContent = fs.readFileSync(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(packageContent) as {
      natstack?: PanelManifest;
      dependencies?: Record<string, string>;
    };

    if (!packageJson.natstack) {
      throw new Error(`package.json in ${panelPath} must include a 'natstack' field`);
    }

    const manifest = packageJson.natstack;

    if (!manifest.title) {
      throw new Error("natstack.title must be specified in package.json");
    }

    // natstack.type is required (canonical). For compatibility, infer from legacy runtime if present.
    if (!manifest.type) {
      if (manifest.runtime === "worker") {
        manifest.type = "worker";
      } else if (manifest.runtime === "panel" || typeof manifest.runtime === "undefined") {
        manifest.type = "app";
      }
    }

    if (manifest.runtime && manifest.runtime === "worker" && manifest.type !== "worker") {
      throw new Error(`natstack.type must be "worker" when natstack.runtime is "worker"`);
    }

    // Merge package.json dependencies with natstack.dependencies
    if (packageJson.dependencies) {
      manifest.dependencies = {
        ...manifest.dependencies,
        ...packageJson.dependencies,
      };
    }

    return manifest;
  }

  private resolveEntryPoint(panelPath: string, manifest: PanelManifest): string {
    const absolutePanelPath = path.resolve(panelPath);

    const verifyEntry = (entryCandidate: string): string | null => {
      const entryPath = path.join(absolutePanelPath, entryCandidate);
      return fs.existsSync(entryPath) ? entryCandidate : null;
    };

    if (manifest.entry) {
      const entry = verifyEntry(manifest.entry);
      if (!entry) {
        throw new Error(`Entry point not found: ${manifest.entry}`);
      }
      return entry;
    }

    const defaultCandidates = [
      "index.tsx",
      "index.ts",
      "index.jsx",
      "index.js",
      "main.tsx",
      "main.ts",
    ];
    const entries = defaultCandidates.filter(verifyEntry);
    if (entries.length > 1) {
      throw new Error(
        `Multiple conventional entry points found (${entries.join(
          ", "
        )}). Please specify a single entry in panel.json.`
      );
    } else if (entries.length === 1) {
      return entries[0]!;
    }

    throw new Error(
      `No entry point found. Provide an entry file (e.g., index.tsx) or set 'entry' in panel.json`
    );
  }

  private async installDependencies(
    depsDir: string,
    dependencies: Record<string, string> | undefined,
    previousHash?: string,
    canonicalPath?: string
  ): Promise<string | undefined> {
    if (!dependencies || Object.keys(dependencies).length === 0) {
      return undefined;
    }

    fs.mkdirSync(depsDir, { recursive: true });
    const packageJsonPath = path.join(depsDir, "package.json");
    const npmrcPath = path.join(depsDir, ".npmrc");

    // Verdaccio is required for dependency resolution
    // ensureRunning() will auto-restart Verdaccio if it crashed
    if (!isVerdaccioServerInitialized()) {
      throw new Error(
        "Verdaccio server not initialized. Cannot resolve dependencies without local npm registry. " +
        "Ensure Verdaccio starts successfully during app initialization."
      );
    }

    const verdaccioRunning = await getVerdaccioServer().ensureRunning();
    if (!verdaccioRunning) {
      throw new Error(
        "Verdaccio server failed to start. Cannot resolve dependencies. " +
        `Last error: ${getVerdaccioServer().getExitError()?.message ?? "unknown"}`
      );
    }

    // Ensure workspace dependencies are published on-demand before resolution
    const verdaccio = getVerdaccioServer();
    const userWorkspace = getActiveWorkspace();
    const publishResult = await verdaccio.ensureDependenciesPublished(
      dependencies,
      userWorkspace?.path
    );

    if (publishResult.published.length > 0) {
      console.log(`[PanelBuilder] On-demand published: ${publishResult.published.join(", ")}`);
    }
    if (publishResult.notFound.length > 0) {
      console.warn(`[PanelBuilder] Workspace packages not found: ${publishResult.notFound.join(", ")}`);
    }

    // With Verdaccio, translate workspace:* to * (Verdaccio serves local packages)
    const resolvedDependencies: Record<string, string> = {};
    for (const [name, version] of Object.entries(dependencies)) {
      resolvedDependencies[name] = version.startsWith("workspace:") ? "*" : version;
    }

    // Write .npmrc to point to local Verdaccio registry
    const verdaccioUrl = getVerdaccioServer().getBaseUrl();
    fs.writeFileSync(npmrcPath, `registry=${verdaccioUrl}\n`);

    type PanelRuntimePackageJson = {
      name: string;
      private: boolean;
      version: string;
      dependencies?: Record<string, string>;
    };

    const desiredPackageJson: PanelRuntimePackageJson = {
      name: "natstack-panel-runtime",
      private: true,
      version: "1.0.0",
      dependencies: resolvedDependencies,
    };
    const serialized = JSON.stringify(desiredPackageJson, null, 2);

    // Include actual Verdaccio package versions in the dependency hash.
    // This ensures we reinstall when Verdaccio packages change, even if:
    // - Version specifiers (like "*") remain the same
    // - Content hashes match but Verdaccio state is different
    //
    // Smart optimization: Only walk transitive deps when Verdaccio packages have actually changed.
    // This avoids unnecessary npm installs when unrelated packages change.
    const natstackVersions = await verdaccio.getVerdaccioVersions();

    // Also get user workspace package versions (@workspace/*, @workspace-panels/*, @workspace-workers/*)
    const userWorkspaceVersions = userWorkspace
      ? await verdaccio.getUserWorkspaceVersions(userWorkspace.path)
      : {};

    // Merge all versions
    const verdaccioVersions = { ...natstackVersions, ...userWorkspaceVersions };

    // Fast path: check if any package changed since last known state
    // Use union of all keys from both objects for consistent comparison
    const lastKnownVersions = this.lastVerdaccioVersions;
    const allKeys = [...new Set([
      ...Object.keys(verdaccioVersions),
      ...Object.keys(lastKnownVersions ?? {})
    ])].sort();
    const versionsChanged = !lastKnownVersions ||
      JSON.stringify(verdaccioVersions, allKeys) !== JSON.stringify(lastKnownVersions, allKeys);

    // When versions change, clear ALL panels' cached relevantVersions.
    // This prevents stale cache hits when: Panel A built → versions change → Panel B built
    // (updates lastKnownVersions) → Panel A rebuilt (would incorrectly use stale cache).
    if (versionsChanged) {
      this.panelRelevantVersionsCache.clear();
    }

    let relevantVersions: Record<string, string>;

    if (!versionsChanged && canonicalPath) {
      // Nothing changed - use cached relevant versions for this panel
      relevantVersions = this.panelRelevantVersionsCache.get(canonicalPath) ?? {};
    } else {
      // Something changed - compute transitive deps for this panel
      relevantVersions = {};

      // Check if we're in a monorepo context (packages/ directory exists)
      // If not, we can't walk transitive deps - fall back to including all verdaccioVersions
      // Use app packages dir (returns null in packaged builds)
      const packagesDir = getPackagesDir();

      if (!packagesDir) {
        // Non-monorepo context: include all Verdaccio versions in hash
        // This is safe (may cause extra reinstalls) but correct
        relevantVersions = { ...verdaccioVersions };
      } else {
        // Monorepo context: walk transitive deps for precise hash
        const visited = new Set<string>();

        const walkDeps = (pkgName: string) => {
          if (visited.has(pkgName)) return;

          // Determine base directory for this package
          let pkgJsonPath: string | null = null;

          if (pkgName.startsWith("@natstack/")) {
            const pkgDir = pkgName.replace("@natstack/", "");
            pkgJsonPath = path.join(packagesDir, pkgDir, "package.json");
          } else if (userWorkspace) {
            if (pkgName.startsWith("@workspace-panels/")) {
              const pkgDir = pkgName.replace("@workspace-panels/", "");
              pkgJsonPath = path.join(userWorkspace.path, "panels", pkgDir, "package.json");
            } else if (pkgName.startsWith("@workspace-workers/")) {
              const pkgDir = pkgName.replace("@workspace-workers/", "");
              pkgJsonPath = path.join(userWorkspace.path, "workers", pkgDir, "package.json");
            } else if (pkgName.startsWith("@workspace/")) {
              const pkgDir = pkgName.replace("@workspace/", "");
              pkgJsonPath = path.join(userWorkspace.path, "packages", pkgDir, "package.json");
            }
          }

          // Only track packages we know about (Verdaccio-published packages)
          if (!pkgJsonPath) return;

          visited.add(pkgName);
          if (verdaccioVersions[pkgName]) {
            relevantVersions[pkgName] = verdaccioVersions[pkgName];
          }

          // Walk transitive deps
          if (fs.existsSync(pkgJsonPath)) {
            try {
              const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
              for (const dep of Object.keys(pkgJson.dependencies ?? {})) {
                walkDeps(dep);
              }
            } catch {
              // Malformed package.json - skip this package's transitive deps
              // The direct dep is already added to relevantVersions above
            }
          }
        };

        // Start from panel's direct deps
        for (const dep of Object.keys(resolvedDependencies)) {
          walkDeps(dep);
        }
      }

      // Cache for next time
      if (canonicalPath) {
        this.panelRelevantVersionsCache.set(canonicalPath, relevantVersions);
      }
      this.lastVerdaccioVersions = verdaccioVersions;
    }

    const hashInput = serialized + JSON.stringify(relevantVersions, Object.keys(relevantVersions).sort());
    const desiredHash = crypto.createHash("sha256").update(hashInput).digest("hex");

    const nodeModulesPath = path.join(depsDir, "node_modules");
    const packageLockPath = path.join(depsDir, "package-lock.json");

    if (previousHash === desiredHash && fs.existsSync(nodeModulesPath)) {
      const existingContent = fs.existsSync(packageJsonPath)
        ? fs.readFileSync(packageJsonPath, "utf-8")
        : null;
      if (existingContent !== serialized) {
        fs.writeFileSync(packageJsonPath, serialized);
      }
      return desiredHash;
    }

    fs.writeFileSync(packageJsonPath, serialized);

    if (fs.existsSync(packageLockPath)) {
      fs.rmSync(packageLockPath, { recursive: true, force: true });
    }

    // Use content-addressable package store for efficient package installation
    // 1. Resolution: Arborist builds ideal tree with hoisting/peer deps
    // 2. Fetch: Store packages by content hash (deduplicated)
    // 3. Link: Hard-link from store to node_modules (space efficient)

    const store = await getPackageStore();

    // Check resolution cache first (skip Arborist if deps unchanged)
    // Use desiredHash as cache key - it includes both package.json content AND
    // Verdaccio version state (relevantVersions), so republishes invalidate cache
    const cachedResolution = store.getResolutionCache(desiredHash);

    let tree: SerializedTree;

    if (cachedResolution) {
      // Use cached resolution
      tree = JSON.parse(cachedResolution.treeJson) as SerializedTree;
    } else {
      // Run Arborist for dependency resolution (tree structure, hoisting, peer deps)
      const arborist = new Arborist({
        path: depsDir,
        registry: verdaccioUrl,
        preferOnline: true,
      });
      const idealTree = await arborist.buildIdealTree();

      // Serialize tree for caching and linking
      tree = serializeTree(idealTree);

      // Cache the resolution (keyed by desiredHash which includes Verdaccio versions)
      store.setResolutionCache(desiredHash, JSON.stringify(tree));
    }

    // Fetch all packages to store (deduplicates, verifies integrity)
    const fetcher = await createPackageFetcher(verdaccioUrl);
    const packages = tree.packages.map((p) => ({
      name: p.name,
      version: p.version,
      integrity: p.integrity,
    }));
    await fetcher.fetchAll(packages, { concurrency: 10 });

    // Link packages from store to node_modules (hard links, preserves tree structure)
    const linker = await createPackageLinker(fetcher);
    await linker.linkFromCache(depsDir, tree);

    return desiredHash;
  }

  // ===========================================================================
  // Unified Build Methods
  // ===========================================================================

  /**
   * Core build method that compiles a panel from source.
   * Writes output to disk (proven to work reliably).
   * Used by both buildPanel() and buildChildPanel().
   */
  private async buildFromSource(options: BuildFromSourceOptions): Promise<BuildFromSourceResult> {
    const {
      sourcePath,
      artifactKey,
      previousDependencyHash,
      log = console.log.bind(console),
      inlineSourcemap = true,
      unsafe,
    } = options;

    // Check if panel directory exists
    if (!fs.existsSync(sourcePath)) {
      return {
        success: false,
        error: `Panel directory not found: ${sourcePath}`,
      };
    }

    // Load manifest
    let manifest: PanelManifest;
    try {
      manifest = this.loadManifest(sourcePath);
      log(`Manifest loaded: ${manifest.title}`);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const workspace = createBuildWorkspace(artifactKey);

    // Install dependencies
    try {
      log(`Installing dependencies...`);
      const runtimeDependencies = this.mergeRuntimeDependencies(manifest.dependencies);
      const dependencyHash = await this.installDependencies(
        workspace.depsDir,
        runtimeDependencies,
        previousDependencyHash,
        artifactKey.canonicalPath
      );
      log(`Dependencies installed`);

      // Determine entry point
      const entry = this.resolveEntryPoint(sourcePath, manifest);
      const entryPath = path.join(sourcePath, entry);

      const bundlePath = path.join(workspace.buildDir, "bundle.js");
      const nodePaths = this.getNodeResolutionPaths(sourcePath, workspace.nodeModulesDir);

      // Determine if panel uses @natstack/react (enables auto-mount)
      const hasNatstackReact = "@natstack/react" in (manifest.dependencies ?? {});

      // Determine if panel has repoArgs (needs bootstrap)
      const hasRepoArgs = manifest.repoArgs && manifest.repoArgs.length > 0;

      // Get externals from manifest (packages loaded via import map / CDN)
      const externals: Record<string, string> = { ...(manifest.externals ?? {}) };
      const externalModules = Object.keys(externals);
      // For unsafe panels with platform: "node", don't manually mark Node.js built-ins as external
      // esbuild will handle them correctly as built-ins provided by the Node.js runtime
      // (This matches the pattern used by the renderer/shell which also uses platform: "node")

      const explicitExposeModules = (manifest.exposeModules ?? [])
        .filter((spec): spec is string => typeof spec === "string")
        .map((spec) => spec.trim())
        .filter((spec) => spec.length > 0 && isBareSpecifier(spec));

      // Check cache for previously discovered expose modules to avoid two-pass build
      // Note: Use spread to avoid mutating the original array
      const exposeCacheKey = `expose:${artifactKey.canonicalPath}:${dependencyHash}:${[...explicitExposeModules].sort().join(",")}`;
      const cachedExposeModules = this.cacheManager.get(exposeCacheKey, isDev());
      let cachedModulesList: string[] | null = null;

      const exposeModulePath = path.join(workspace.buildDir, "_expose.js");
      let exposeModuleCode: string;

      if (cachedExposeModules) {
        try {
          cachedModulesList = JSON.parse(cachedExposeModules) as string[];
          exposeModuleCode = generateExposeModuleCode(cachedModulesList);
          log(`Using cached expose modules (${cachedModulesList.length} modules)`);
        } catch {
          // Cache parse failed, start with empty
          exposeModuleCode = generateExposeModuleCode([]);
        }
      } else {
        exposeModuleCode = generateExposeModuleCode([]);
      }
      fs.writeFileSync(exposeModulePath, exposeModuleCode);

      // Create wrapper entry
      const tempEntryPath = path.join(workspace.buildDir, "_entry.js");
      const relativeUserEntry = path.relative(workspace.buildDir, entryPath);

      // Build wrapper code
      // Bootstrap is now started automatically by @natstack/runtime when the module loads.
      // Panel code that needs bootstrap results can await `bootstrapPromise` from the runtime.
      let wrapperCode: string;

      if (hasNatstackReact) {
        // Auto-mount wrapper for React panels
        wrapperCode = `import "./_expose.js";
import { autoMountReactPanel, shouldAutoMount } from "@natstack/react";
import * as userModule from ${JSON.stringify(relativeUserEntry)};

if (shouldAutoMount(userModule)) {
  autoMountReactPanel(userModule);
}
`;
      } else {
        // Direct import for non-React panels (panel handles its own mounting)
        wrapperCode = `import "./_expose.js";
import ${JSON.stringify(relativeUserEntry)};
`;
      }

      // hasRepoArgs is still checked to pass git config, but bootstrap is non-blocking
      void hasRepoArgs; // Suppress unused variable warning
      fs.writeFileSync(tempEntryPath, wrapperCode);

      // Build with esbuild (write to disk)
      log(`Building panel...`);
      if (externalModules.length > 0) {
        log(`External modules (CDN): ${externalModules.join(", ")}`);
      }

      // Use panel fs and path shim plugins for safe panels.
      // For unsafe panels, skip the shims to allow direct Node.js fs/path access.
      // fs shim resolveDir points at deps dir where @natstack/runtime is installed.
      // path shim resolveDir uses app root so it can resolve 'pathe' from node_modules.
      const plugins: esbuild.Plugin[] = [];
      if (!unsafe) {
        plugins.push(createPanelFsShimPlugin(workspace.depsDir));
        plugins.push(createPanelPathShimPlugin(getAppRoot()));
      }
      if (hasNatstackReact) {
        // Dedupe React, Radix UI, and any manifest-specified packages
        plugins.push(this.createDedupePlugin(workspace.nodeModulesDir, manifest.dedupeModules));
      }

      // For unsafe panels, include Node.js compatibility patch to handle hybrid browser/Node.js environment
      // Also set up import.meta.url shim variable that define will reference
      const importMetaUrlShim = 'var __import_meta_url = require("url").pathToFileURL(__filename).href;';
      const bannerJs = unsafe
        ? [importMetaUrlShim, generateNodeCompatibilityPatch(), generateAsyncTrackingBanner(), generateModuleMapBanner()].join("\n")
        : [generateAsyncTrackingBanner(), generateModuleMapBanner()].join("\n");

      // Helper to create consistent esbuild configuration
      const createBuildConfig = (): esbuild.BuildOptions => ({
        entryPoints: [tempEntryPath],
        bundle: true,
        // Use "node" platform for unsafe panels to enable Node.js built-in modules
        platform: unsafe ? "node" : "browser",
        target: "es2022",
        conditions: ["natstack-panel"],
        outfile: bundlePath,
        sourcemap: inlineSourcemap ? "inline" : false,
        keepNames: true, // Preserve class/function names
        // CJS format required for unsafe panels: nodeIntegration only patches require(), not ES imports
        format: unsafe ? "cjs" : "esm",
        absWorkingDir: sourcePath,
        nodePaths,
        plugins,
        external: externalModules,
        loader: PANEL_ASSET_LOADERS,
        assetNames: "assets/[name]-[hash]",
        banner: {
          js: bannerJs,
        },
        metafile: true,
        // For CJS (unsafe panels), dynamic import() must be transformed to require()
        // because WebContentsView doesn't have an ESM loader to resolve bare specifiers.
        supported: unsafe ? { "dynamic-import": false } : undefined,
        // For CJS bundles, provide import.meta.url shim since CJS doesn't have import.meta
        // This allows ES modules that use import.meta.url to work when bundled
        // The actual value is computed in the banner and stored in __import_meta_url
        define: unsafe
          ? { "import.meta.url": "__import_meta_url" }
          : undefined,
        // Use a build-owned tsconfig. Only allowlisted user compilerOptions are merged.
        tsconfig: this.writeBuildTsconfig(workspace.buildDir, sourcePath, "panel", {
          jsx: "react-jsx",
          target: "ES2022",
          useDefineForClassFields: true,
        }),
      });

      // Run esbuild and type checking in parallel
      // Type checking uses the original source files, so it can run while esbuild bundles
      const [buildResult, typeErrors] = await Promise.all([
        esbuild.build(createBuildConfig()),
        this.runTypeCheck(sourcePath, workspace.nodeModulesDir, log, runtimeDependencies),
      ]);

      let buildMetafile = buildResult.metafile;
      let exposeModulesWarning: string | undefined;

      if (buildResult.metafile) {
        const externalSet = new Set(externalModules);
        const depsToExpose = collectExposedDepsFromMetafile(buildResult.metafile, externalSet);
        for (const spec of explicitExposeModules) {
          if (!externalSet.has(spec)) {
            depsToExpose.push(spec);
          }
        }
        const uniqueDeps = [...new Set(depsToExpose)].sort();

        // Check if we need to rebuild
        const arraysEqual = (a: string[], b: string[]) =>
          a.length === b.length && a.every((v, i) => v === b[i]);

        if (cachedModulesList && arraysEqual(uniqueDeps, cachedModulesList)) {
          // Cache hit - no rebuild needed
          log(`Expose modules cache hit (skipped second build pass)`);
        } else {
          // Need to check if expose code changed
          const nextExposeCode = generateExposeModuleCode(uniqueDeps);
          if (nextExposeCode !== exposeModuleCode) {
            exposeModuleCode = nextExposeCode;
            fs.writeFileSync(exposeModulePath, exposeModuleCode);

            log(`Re-building with ${uniqueDeps.length} exposed modules...`);
            try {
              const rebuildResult = await esbuild.build(createBuildConfig());
              if (rebuildResult.metafile) {
                buildMetafile = rebuildResult.metafile;
              }
            } catch (rebuildError) {
              // Log but don't fail - the first build output is still usable
              const msg = rebuildError instanceof Error ? rebuildError.message : String(rebuildError);
              log(`Warning: Second build pass failed: ${msg}`);
              log(`Continuing with first build output (exposed modules may not work correctly)`);
              exposeModulesWarning = `Exposed modules may not work: ${msg}`;
            }
          }

          // Save to cache for next build
          await this.cacheManager.set(exposeCacheKey, JSON.stringify(uniqueDeps));
          log(`Cached expose modules for future builds`);
        }
      }

      const bundle = fs.readFileSync(bundlePath, "utf-8");
      const cssPath = bundlePath.replace(".js", ".css");
      const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf-8") : undefined;

      // Analyze bundle size if it's large (> 10MB)
      if (bundle.length > 10 * 1024 * 1024 && buildMetafile) {
        analyzeBundleSize(buildMetafile, log);
      }

      const panelAssets = this.collectPanelAssets(buildMetafile, workspace.buildDir, bundlePath, cssPath, log);

      // Build workers declared by dependencies (via natstack.workers in package.json)
      let dependencyWorkerAssets: PanelAssetMap | undefined;
      try {
        dependencyWorkerAssets = await this.buildDependencyWorkerAssets(
          workspace.nodeModulesDir,
          nodePaths,
          workspace.buildDir,
          log
        );
        if (dependencyWorkerAssets) {
          const workerKeys = Object.keys(dependencyWorkerAssets);
          log(`Built ${workerKeys.length} dependency worker assets: ${workerKeys.join(", ")}`);
        } else {
          log(`No dependency worker assets found`);
        }
      } catch (assetError) {
        log?.(
          `Warning: Dependency worker build failed: ${
            assetError instanceof Error ? assetError.message : String(assetError)
          }`
        );
      }
      const assets = this.mergeAssetMaps(panelAssets, dependencyWorkerAssets);
      if (assets) {
        const assetKeys = Object.keys(assets);
        const monacoKeys = assetKeys.filter(k => k.includes("monaco"));
        log(`Total panel assets: ${assetKeys.length} (${monacoKeys.length} monaco-related: ${monacoKeys.join(", ")})`);
      }
      const html = this.resolveHtml(sourcePath, manifest.title, externals, {
        includeCss: Boolean(css),
        unsafe: Boolean(unsafe),
      });

      log(`Build complete (${bundle.length} bytes JS)`);

      // If there are type errors, fail the build
      if (typeErrors.length > 0) {
        const errorSummary = typeErrors
          .slice(0, 40) // Show first 40 errors
          .map((e) => `${e.file}:${e.line}:${e.column}: ${e.message}`)
          .join("\n");
        const moreMsg = typeErrors.length > 40 ? `\n... and ${typeErrors.length - 40} more errors` : "";
        return {
          success: false,
          error: `TypeScript errors:\n${errorSummary}${moreMsg}`,
          typeErrors,
        };
      }

      return {
        success: true,
        manifest,
        bundle,
        html,
        css,
        assets,
        dependencyHash,
        warning: exposeModulesWarning,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      try {
        await workspace.cleanupBuildDir();
      } catch {
        // Best-effort cleanup
      }
    }
  }

  /**
   * Create a plugin to deduplicate module imports.
   * This ensures all imports of specified packages (including from dependencies)
   * resolve to the same instance in the build dependency node_modules.
   *
   * This is critical for packages that use React context or other singleton patterns
   * because context only works when provider and consumer use the same module instance.
   *
   * Uses shared resolution logic from @natstack/runtime/typecheck to ensure
   * build-time and type-check-time resolution are consistent.
   *
   * @param runtimeNodeModules - The node_modules directory to resolve from
   * @param additionalPackages - Extra packages to dedupe (from manifest.dedupeModules)
   */
  private createDedupePlugin(
    runtimeNodeModules: string,
    additionalPackages: string[] = []
  ): esbuild.Plugin {
    const resolvedRuntimeNodeModules = path.resolve(runtimeNodeModules);

    // Combine default packages with manifest-specified ones (using shared constant)
    const allPackages = [...DEFAULT_DEDUPE_PACKAGES, ...additionalPackages];

    // Convert to regex patterns, deduplicating (using shared function)
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
        // Create a resolver for each pattern
        for (const pattern of patterns) {
          build.onResolve({ filter: pattern }, async (args) => {
            // Skip if already resolving from within the target tree (prevent infinite recursion)
            if (path.resolve(args.resolveDir).startsWith(resolvedRuntimeNodeModules)) {
              return null;
            }
            // Try to resolve from the runtime node_modules directory
            // This forces all matching imports to use the same physical package
            try {
              const result = await build.resolve(args.path, {
                kind: args.kind,
                resolveDir: resolvedRuntimeNodeModules,
              });
              // Only use the result if resolution succeeded (no errors)
              // If the package doesn't exist in runtime node_modules, fall back to default
              if (!result.errors || result.errors.length === 0) {
                return result;
              }
            } catch {
              // Resolution failed, fall back to default resolver
            }
            // Let esbuild's default resolver handle it
            return null;
          });
        }
      },
    };
  }

  private mergeAssetMaps(...assetSets: Array<PanelAssetMap | undefined>): PanelAssetMap | undefined {
    const merged: PanelAssetMap = {};
    for (const assetSet of assetSets) {
      if (!assetSet) continue;
      Object.assign(merged, assetSet);
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
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

    const ignoredOutputs = new Set<string>([
      path.resolve(bundlePath),
      path.resolve(cssPath),
    ]);
    const assets: PanelAssetMap = {};

    for (const output of outputs) {
      const resolvedOutput = path.isAbsolute(output) ? output : path.join(buildDir, output);
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
      const entry: PanelAssetEntry = isText ? { content } : { content, encoding: "base64" };
      assets[assetPath] = entry;
    }

    const assetCount = Object.keys(assets).length;
    if (assetCount === 0) {
      return undefined;
    }

    log?.(`Bundled ${assetCount} panel asset${assetCount === 1 ? "" : "s"}.`);
    return assets;
  }

  /**
   * Build web workers declared by dependencies via natstack.workers in package.json.
   * Scans the panel's node_modules for worker declarations and bundles them as assets.
   */
  private async buildDependencyWorkerAssets(
    nodeModulesDir: string,
    nodePaths: string[],
    buildDir: string,
    log?: (message: string) => void
  ): Promise<PanelAssetMap | undefined> {
    // Collect workers from the panel's dependencies
    log?.(`Scanning for worker declarations in: ${nodeModulesDir}`);
    const workers = collectWorkersFromDependencies(nodeModulesDir, {
      log: (msg) => log?.(msg),
    });

    const workerEntries = workersToArray(workers);
    log?.(`Found ${workerEntries.length} worker declarations`);
    if (workerEntries.length === 0) {
      return undefined;
    }

    const req = createRequire(__filename);
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
        log?.(`Warning: Could not resolve worker: ${entry.specifier} (declared by ${entry.declaredBy})`);
        continue;
      }

      // Create output directory based on worker path (e.g., "monaco/editor.worker.js")
      const outfile = path.join(buildDir, entry.name);
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

    if (Object.keys(assets).length === 0) {
      return undefined;
    }

    const packages = [...new Set(workerEntries.map((e) => e.declaredBy))];
    log?.(`Bundled ${Object.keys(assets).length} worker assets from: ${packages.join(", ")}`);
    return assets;
  }

  private mergeRuntimeDependencies(
    panelDependencies: Record<string, string> | undefined
  ): Record<string, string> {
    const merged = { ...defaultPanelDependencies };

    // If panel depends on @natstack/react, add React dependencies
    // Use the version from @natstack/react's peerDependencies
    if (panelDependencies && "@natstack/react" in panelDependencies) {
      const reactDeps = getReactDependenciesFromNatstackReact();
      if (reactDeps) {
        Object.assign(merged, reactDeps);
      }
    }

    if (panelDependencies) {
      Object.assign(merged, panelDependencies);
    }
    return merged;
  }

  // ===========================================================================
  // Public Build API
  // ===========================================================================

  /**
   * Build a panel from a workspace path with optional version specifier.
   * All panels (root and child) are built and served via natstack-panel:// protocol.
   *
   * @param panelsRoot - Absolute path to workspace root
   * @param panelPath - Relative path to panel within workspace (e.g., "panels/root")
   * @param version - Optional version specifier (branch, commit, or tag)
   * @param onProgress - Optional progress callback for UI updates
   */
  async buildPanel(
    panelsRoot: string,
    panelPath: string,
    version?: VersionSpec,
    onProgress?: (progress: BuildProgress) => void,
    options?: { sourcemap?: boolean; unsafe?: boolean | string }
  ): Promise<ChildBuildResult> {
    let cleanup: (() => Promise<void>) | null = null;
    let buildLog = "";
    const canonicalPanelPath = path.resolve(panelsRoot, panelPath);

    const log = (message: string) => {
      buildLog += message + "\n";
      console.log(`[PanelBuilder] ${message}`);
    };

    try {
      // Get verdaccio versions hash once at the start for consistent cache keys
      const versionsHash = await this.getVerdaccioVersionsHash();

      // Step 1: Early cache check (fast - no git checkout needed)
      const earlyCommit = await resolveTargetCommit(panelsRoot, panelPath, version);

      if (earlyCommit) {
        const cacheKey = `panel:${canonicalPanelPath}:${earlyCommit}:${versionsHash}`;
        const cached = this.cacheManager.get(cacheKey, isDev());

        if (cached) {
          log(`Early cache hit for ${cacheKey}`);
          onProgress?.({ state: "ready", message: "Loaded from cache", log: buildLog });

          try {
            return JSON.parse(cached) as ChildBuildResult;
          } catch {
            log(`Cache parse failed, will rebuild`);
          }
        }
      }

      // Step 2: Provision source at the right version
      onProgress?.({ state: "cloning", message: "Fetching panel source...", log: buildLog });
      log(`Provisioning ${panelPath}${version ? ` at ${JSON.stringify(version)}` : ""}`);

      const provision = await provisionPanelVersion(panelsRoot, panelPath, version, (progress) => {
        log(`Git: ${progress.message}`);
        onProgress?.({ state: "cloning", message: progress.message, log: buildLog });
      });

      cleanup = provision.cleanup;
      const sourcePath = provision.sourcePath;
      const sourceCommit = provision.commit;

      log(`Source provisioned at ${sourcePath} (commit: ${sourceCommit.slice(0, 8)})`);

      // Cache key for storing the result (uses same versionsHash computed at start)
      const cacheKey = `panel:${canonicalPanelPath}:${sourceCommit}:${versionsHash}`;

      // Step 3: Build from source
      onProgress?.({ state: "building", message: "Building panel...", log: buildLog });

      // Check for cached dependency hash to avoid unnecessary npm installs
      const dependencyCacheKey = `deps:${canonicalPanelPath}:${sourceCommit}`;
      const previousDependencyHash = this.getDependencyHashFromCache(dependencyCacheKey);

      const buildResult = await this.buildFromSource({
        sourcePath,
        artifactKey: { kind: "panel", canonicalPath: canonicalPanelPath, commit: sourceCommit },
        previousDependencyHash,
        log,
        inlineSourcemap: options?.sourcemap !== false,
        unsafe: options?.unsafe,
      });

      // Save the new dependency hash for next time
      if (buildResult.success && buildResult.dependencyHash) {
        await this.saveDependencyHashToCache(dependencyCacheKey, buildResult.dependencyHash);
      }

      if (!buildResult.success) {
        log(`Build failed: ${buildResult.error}`);
        onProgress?.({ state: "error", message: buildResult.error!, log: buildLog });

        if (cleanup) {
          await cleanup();
        }

        return {
          success: false,
          error: buildResult.error,
          buildLog,
        };
      }

      // Step 4: Use in-memory artifacts for protocol serving
      const bundle = buildResult.bundle!;
      const html = buildResult.html!;

      // Check bundle size limits
      if (bundle.length > BUNDLE_SIZE_LIMITS.MAX_JS_BYTES) {
        const sizeMB = (bundle.length / 1024 / 1024).toFixed(2);
        const maxMB = (BUNDLE_SIZE_LIMITS.MAX_JS_BYTES / 1024 / 1024).toFixed(0);
        log(`Warning: Bundle size (${sizeMB}MB) exceeds limit (${maxMB}MB)`);
        return {
          success: false,
          error: `Bundle too large: ${sizeMB}MB (max: ${maxMB}MB). Consider code splitting or removing dependencies.`,
          buildLog,
        };
      }

      if (html.length > BUNDLE_SIZE_LIMITS.MAX_HTML_BYTES) {
        const sizeMB = (html.length / 1024 / 1024).toFixed(2);
        const maxMB = (BUNDLE_SIZE_LIMITS.MAX_HTML_BYTES / 1024 / 1024).toFixed(0);
        log(`Warning: HTML size (${sizeMB}MB) exceeds limit (${maxMB}MB)`);
        return {
          success: false,
          error: `HTML too large: ${sizeMB}MB (max: ${maxMB}MB)`,
          buildLog,
        };
      }

      // Check CSS bundle size (if any)
      const css = buildResult.css;
      if (css && css.length > BUNDLE_SIZE_LIMITS.MAX_CSS_BYTES) {
        const sizeMB = (css.length / 1024 / 1024).toFixed(2);
        const maxMB = (BUNDLE_SIZE_LIMITS.MAX_CSS_BYTES / 1024 / 1024).toFixed(0);
        log(`Warning: CSS size (${sizeMB}MB) exceeds limit (${maxMB}MB)`);
        return {
          success: false,
          error: `CSS too large: ${sizeMB}MB (max: ${maxMB}MB)`,
          buildLog,
        };
      }

      log(`Build complete: ${bundle.length} bytes JS${css ? `, ${css.length} bytes CSS` : ""}`);

      // Step 5: Cache result
      const result: ChildBuildResult = {
        success: true,
        bundle,
        html,
        css,
        assets: buildResult.assets,
        manifest: buildResult.manifest,
        buildLog,
      };

      await this.cacheManager.set(cacheKey, JSON.stringify(result));
      log(`Cached build result`);

      // Cleanup temp directory
      if (cleanup) {
        await cleanup();
        log(`Cleaned up temp directory`);
      }

      onProgress?.({ state: "ready", message: "Build complete", log: buildLog });

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`Build failed: ${errorMsg}`);

      if (cleanup) {
        try {
          await cleanup();
        } catch {
          // Ignore cleanup errors
        }
      }

      onProgress?.({ state: "error", message: errorMsg, log: buildLog });

      return {
        success: false,
        error: errorMsg,
        buildLog,
      };
    }
  }

  /**
   * Build a worker from a workspace path with optional version specifier.
   * Workers are built for browser target (WebContentsView) and return just a JS bundle.
   *
   * @param panelsRoot - Absolute path to workspace root
   * @param workerPath - Relative path to worker within workspace
   * @param version - Optional version specifier (branch, commit, or tag)
   * @param onProgress - Optional progress callback for UI updates
   * @param options - Build options
   * @param options.unsafe - If true or a string path, run with Node.js integration
   */
  async buildWorker(
    panelsRoot: string,
    workerPath: string,
    version?: VersionSpec,
    onProgress?: (progress: BuildProgress) => void,
    options?: { unsafe?: boolean | string }
  ): Promise<WorkerBuildResult> {
    let cleanup: (() => Promise<void>) | null = null;
    let buildWorkspace: ReturnType<typeof createBuildWorkspace> | null = null;
    let buildLog = "";
    const canonicalWorkerPath = path.resolve(panelsRoot, workerPath);

    const log = (message: string) => {
      buildLog += message + "\n";
      console.log(`[PanelBuilder:Worker] ${message}`);
    };

    try {
      // Get verdaccio versions hash once at the start for consistent cache keys
      const versionsHash = await this.getVerdaccioVersionsHash();

      // Step 1: Early cache check (fast - no git checkout needed)
      const earlyCommit = await resolveTargetCommit(panelsRoot, workerPath, version);

      if (earlyCommit) {
        const cacheKey = `worker:${canonicalWorkerPath}:${earlyCommit}:${versionsHash}`;
        const cached = this.cacheManager.get(cacheKey, isDev());

        if (cached) {
          log(`Early cache hit for ${cacheKey}`);
          onProgress?.({ state: "ready", message: "Loaded from cache", log: buildLog });

          try {
            return JSON.parse(cached) as WorkerBuildResult;
          } catch {
            log(`Cache parse failed, will rebuild`);
          }
        }
      }

      // Step 2: Provision source at the right version
      onProgress?.({ state: "cloning", message: "Fetching worker source...", log: buildLog });
      log(`Provisioning ${workerPath}${version ? ` at ${JSON.stringify(version)}` : ""}`);

      const provision = await provisionPanelVersion(panelsRoot, workerPath, version, (progress) => {
        log(`Git: ${progress.message}`);
        onProgress?.({ state: "cloning", message: progress.message, log: buildLog });
      });

      cleanup = provision.cleanup;
      const sourcePath = provision.sourcePath;
      const sourceCommit = provision.commit;

      log(`Source provisioned at ${sourcePath} (commit: ${sourceCommit.slice(0, 8)})`);

      // Cache key for storing the result (uses same versionsHash computed at start)
      const cacheKey = `worker:${canonicalWorkerPath}:${sourceCommit}:${versionsHash}`;

      // Step 3: Load manifest and validate it's a worker
      let manifest: PanelManifest;
      try {
        manifest = this.loadManifest(sourcePath);
        log(`Manifest loaded: ${manifest.title}`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log(`Failed to load manifest: ${errorMsg}`);
        onProgress?.({ state: "error", message: errorMsg, log: buildLog });
        if (cleanup) await cleanup();
        return { success: false, error: errorMsg, buildLog };
      }

      buildWorkspace = createBuildWorkspace({
        kind: "worker",
        canonicalPath: canonicalWorkerPath,
        commit: sourceCommit,
      });

      // Step 4: Install dependencies
      onProgress?.({ state: "building", message: "Installing dependencies...", log: buildLog });
      log(`Installing dependencies...`);

      const dependencyCacheKey = `deps:${canonicalWorkerPath}:${sourceCommit}`;
      const previousDependencyHash = this.getDependencyHashFromCache(dependencyCacheKey);

      const workerDependencies = this.mergeWorkerDependencies(manifest.dependencies);
      const dependencyHash = await this.installDependencies(
        buildWorkspace.depsDir,
        workerDependencies,
        previousDependencyHash,
        canonicalWorkerPath
      );

      if (dependencyHash) {
        await this.saveDependencyHashToCache(dependencyCacheKey, dependencyHash);
      }
      log(`Dependencies installed`);

      // Step 5: Build the worker bundle
      onProgress?.({ state: "building", message: "Building worker...", log: buildLog });
      log(`Building worker bundle...`);

      const entry = this.resolveEntryPoint(sourcePath, manifest);
      const entryPath = path.join(sourcePath, entry);
      const bundlePath = path.join(buildWorkspace.buildDir, "worker-bundle.js");
      const nodePaths = this.getNodeResolutionPaths(sourcePath, buildWorkspace.nodeModulesDir);

      // Create wrapper entry that imports user module and sets up worker runtime
      const tempEntryPath = path.join(buildWorkspace.buildDir, "_worker_entry.js");
      const relativeUserEntry = path.relative(buildWorkspace.buildDir, entryPath);

      // Worker wrapper - imports runtime to set up console/globals,
      // then imports the user module which should call rpc.expose()
      const wrapperCode = `
// Import worker runtime to set up console and globals
import "@natstack/runtime";

// Import user module - it should call rpc.expose() to register methods
import ${JSON.stringify(relativeUserEntry)};
`;
      fs.writeFileSync(tempEntryPath, wrapperCode);

      // Workers are now WebContentsView-based (like panels).
      // Safe workers use ZenFS (OPFS) via the panel fs shim plugin and pathe for path.
      // Unsafe workers get Node.js integration (nodeIntegration: true in WebContentsView).
      const plugins: esbuild.Plugin[] = [];

      // For safe workers, use panel fs and path shims
      // path shim uses app root so it can resolve 'pathe' from node_modules
      if (!options?.unsafe) {
        plugins.push(createPanelFsShimPlugin(buildWorkspace.depsDir));
        plugins.push(createPanelPathShimPlugin(getAppRoot()));
      }

      // Generate banners - include Node.js compatibility patch for unsafe workers
      // For CJS bundles, also set up import.meta.url shim variable that define will reference
      const importMetaUrlShim = 'var __import_meta_url = require("url").pathToFileURL(__filename).href;';
      const bannerJs = options?.unsafe
        ? [importMetaUrlShim, generateNodeCompatibilityPatch(), generateAsyncTrackingBanner(), generateModuleMapBanner()].join("\n")
        : [generateAsyncTrackingBanner(), generateModuleMapBanner()].join("\n");

      // Build configuration
      // Workers intentionally use the "natstack-panel" condition to share the same
      // @natstack/runtime entry point as panels. Both run in WebContentsView and use
      // the same transport, fs abstraction, and bootstrap sequence.
      //
      // Platform/format differences:
      // - Safe workers: browser platform + ESM (standard browser environment)
      // - Unsafe workers: node platform + CJS (nodeIntegration enabled, require() available)

      // Run esbuild and type checking in parallel
      const [, typeErrors] = await Promise.all([
        esbuild.build({
          entryPoints: [tempEntryPath],
          bundle: true,
          platform: options?.unsafe ? "node" : "browser",
          target: "es2022",
          conditions: ["natstack-panel"],
          outfile: bundlePath,
          sourcemap: "inline",
          keepNames: true,
          format: options?.unsafe ? "cjs" : "esm",
          absWorkingDir: sourcePath,
          nodePaths,
          plugins,
          tsconfig: this.writeBuildTsconfig(buildWorkspace.buildDir, sourcePath, "worker", {
            target: "ES2022",
            useDefineForClassFields: true,
          }),
          // For CJS (unsafe workers), dynamic import() must be transformed to require()
          // because WebContentsView doesn't have an ESM loader to resolve bare specifiers.
          // Setting 'dynamic-import': false tells esbuild to transform import() to require().
          supported: options?.unsafe ? { "dynamic-import": false } : undefined,
          // For CJS bundles, provide import.meta.url shim since CJS doesn't have import.meta
          // This allows ES modules that use import.meta.url to work when bundled.
          // The actual value is computed in the banner and stored in __import_meta_url.
          // Note: For @openai/codex-sdk, this provides a valid URL (though not the original path).
          // The codex-responder uses codexPathOverride to specify the codex binary location,
          // so the SDK's findCodexPath() (which uses import.meta.url) isn't actually called.
          define: options?.unsafe
            ? { "import.meta.url": "__import_meta_url" }
            : undefined,
          banner: {
            js: bannerJs,
          },
        }),
        this.runTypeCheck(sourcePath, buildWorkspace.nodeModulesDir, log, workerDependencies),
      ]);

      // Read the built bundle
      const bundle = fs.readFileSync(bundlePath, "utf-8");

      // Check bundle size
      if (bundle.length > BUNDLE_SIZE_LIMITS.MAX_JS_BYTES) {
        const sizeMB = (bundle.length / 1024 / 1024).toFixed(2);
        const maxMB = (BUNDLE_SIZE_LIMITS.MAX_JS_BYTES / 1024 / 1024).toFixed(0);
        log(`Warning: Bundle size (${sizeMB}MB) exceeds limit (${maxMB}MB)`);
        if (buildWorkspace) {
          try {
            await buildWorkspace.cleanupBuildDir();
          } catch {
            // Best-effort
          }
        }
        if (cleanup) await cleanup();
        return {
          success: false,
          error: `Bundle too large: ${sizeMB}MB (max: ${maxMB}MB)`,
          buildLog,
        };
      }

      log(`Build complete: ${bundle.length} bytes JS`);

      // If there are type errors, fail the build
      if (typeErrors.length > 0) {
        const errorSummary = typeErrors
          .slice(0, 40) // Show first 40 errors
          .map((e) => `${e.file}:${e.line}:${e.column}: ${e.message}`)
          .join("\n");
        const moreMsg = typeErrors.length > 40 ? `\n... and ${typeErrors.length - 40} more errors` : "";
        if (buildWorkspace) {
          try {
            await buildWorkspace.cleanupBuildDir();
          } catch {
            // Best-effort
          }
        }
        if (cleanup) await cleanup();
        return {
          success: false,
          error: `TypeScript errors:\n${errorSummary}${moreMsg}`,
          buildLog,
        };
      }

      // Step 6: Cache result
      const result: WorkerBuildResult = {
        success: true,
        bundle,
        manifest,
        buildLog,
      };

      await this.cacheManager.set(cacheKey, JSON.stringify(result));
      log(`Cached build result`);

      if (buildWorkspace) {
        try {
          await buildWorkspace.cleanupBuildDir();
        } catch {
          // Best-effort
        }
      }

      // Cleanup temp directory
      if (cleanup) {
        await cleanup();
        log(`Cleaned up temp directory`);
      }

      onProgress?.({ state: "ready", message: "Build complete", log: buildLog });

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`Build failed: ${errorMsg}`);

      if (buildWorkspace) {
        try {
          await buildWorkspace.cleanupBuildDir();
        } catch {
          // Ignore cleanup errors
        }
      }

      if (cleanup) {
        try {
          await cleanup();
        } catch {
          // Ignore cleanup errors
        }
      }

      onProgress?.({ state: "error", message: errorMsg, log: buildLog });

      return {
        success: false,
        error: errorMsg,
        buildLog,
      };
    }
  }

  private mergeWorkerDependencies(
    workerDependencies: Record<string, string> | undefined
  ): Record<string, string> {
    const merged = { ...defaultWorkerDependencies };
    if (workerDependencies) {
      Object.assign(merged, workerDependencies);
    }
    return merged;
  }

  async clearCache(panelPath?: string): Promise<void> {
    if (panelPath) {
      console.warn(
        "[PanelBuilder] Individual panel cache clearing not yet supported with unified cache"
      );
    } else {
      await this.cacheManager.clear();

      // Note: Error panels are now reset in-memory by PanelManager.invalidateReadyPanels()
      // No database reset needed since artifacts are runtime-only state.
    }
  }
}
