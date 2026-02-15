/**
 * Builder — esbuild orchestration for panels, about pages, and agents.
 *
 * Two build strategies:
 *   - Panel/About (browser target): ESM, code splitting, fs/path shims
 *   - Agent (node target): ESM, no splitting, full Node.js access
 *
 * Build options are manifest-derived, not caller-supplied.
 * Concurrency: semaphore with MAX_CONCURRENT_BUILDS = 4.
 * Coalescing: dedup concurrent builds of the same build key.
 *
 * Source files are extracted from git at the correct commit via sourceExtractor,
 * so builds always match what the EV describes regardless of working tree state.
 */

import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import type { GraphNode, PackageGraph } from "./packageGraph.js";
import * as buildStore from "./buildStore.js";
import type { BuildArtifacts, BuildMetadata, BuildResult } from "./buildStore.js";
import { computeBuildKey } from "./effectiveVersion.js";
import { collectTransitiveExternalDeps, ensureExternalDeps } from "./externalDeps.js";
import { extractSourceForBuild } from "./sourceExtractor.js";
import { PANEL_CSP_META } from "../../shared/constants.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_BUILDS = 4;

const PANEL_ASSET_LOADERS: Record<string, esbuild.Loader> = {
  ".png": "file", ".jpg": "file", ".jpeg": "file", ".gif": "file",
  ".webp": "file", ".avif": "file", ".svg": "file", ".ico": "file",
  ".bmp": "file", ".tif": "file", ".tiff": "file",
  ".woff": "file", ".woff2": "file", ".ttf": "file", ".otf": "file", ".eot": "file",
  ".mp3": "file", ".wav": "file", ".ogg": "file", ".mp4": "file", ".webm": "file",
  ".wasm": "file", ".pdf": "file",
};

const KNOWN_NATIVE_EXTERNALS = [
  "*.node", "fsevents", "bufferutil", "utf-8-validate",
  "node-pty", "cpu-features", "@parcel/watcher",
];

const TEXT_EXTENSIONS = new Set([
  ".js", ".css", ".json", ".map", ".svg", ".txt", ".md", ".html",
]);

const DEFAULT_DEDUPE_PACKAGES = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
] as const;

// Packages that frequently dominate bundle size. We create synthetic entry points
// for these when present so esbuild can split them into independent chunks.
const FORCED_SPLIT_PACKAGES = [
  "@mdx-js/mdx",
  "rehype-highlight",
  "@radix-ui/react-icons",
  "typescript",
  "monaco-editor",
  "sucrase",
] as const;

function isVerboseBuildLogEnabled(): boolean {
  return process.env["NATSTACK_LOG_LEVEL"] === "verbose";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${bytes}B`;
}

// ---------------------------------------------------------------------------
// Path Remapping
// ---------------------------------------------------------------------------

/**
 * Remap an original workspace path to the corresponding extracted source path.
 * Uses path.relative + path.join, not string replacement.
 */
function remapPath(orig: string, workspaceRoot: string, sourceRoot: string): string {
  return path.join(sourceRoot, path.relative(workspaceRoot, orig));
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

let runningBuilds = 0;
const waitQueue: (() => void)[] = [];

async function acquireSemaphore(): Promise<void> {
  if (runningBuilds < MAX_CONCURRENT_BUILDS) {
    runningBuilds++;
    return;
  }
  await new Promise<void>((resolve) => waitQueue.push(resolve));
  runningBuilds++;
}

function releaseSemaphore(): void {
  runningBuilds--;
  const next = waitQueue.shift();
  if (next) next();
}

// Build coalescing: dedup concurrent builds of the same key
const inFlightBuilds = new Map<string, Promise<BuildResult>>();

// ---------------------------------------------------------------------------
// Resolve Plugin
// ---------------------------------------------------------------------------

/**
 * Create an esbuild plugin that resolves @workspace/* imports from
 * the git-extracted source tree. All packages are extracted from git
 * to preserve content-addressable semantics — the build always matches
 * the EV regardless of filesystem state.
 *
 * Since extracted source lacks dist/ (gitignored), the plugin maps
 * exports-based dist/ paths to their TypeScript source equivalents.
 */
const PANEL_CONDITIONS = ["natstack-panel", "import", "default"] as const;
const NODE_CONDITIONS = ["import", "default"] as const;

function createWorkspaceResolvePlugin(
  graph: PackageGraph,
  workspaceRoot: string,
  sourceRoot: string,
  conditions: readonly string[] = PANEL_CONDITIONS,
): esbuild.Plugin {
  return {
    name: "workspace-packages",
    setup(build) {
      // Match @workspace/*, @workspace-panels/*, @workspace-about/*, @workspace-agents/*
      build.onResolve({ filter: /^@workspace[-/]/ }, (args) => {
        const parsed = parseWorkspaceImport(args.path);
        if (!parsed) return null;

        const node = graph.tryGet(parsed.packageName);
        if (!node) return null;

        const sourcePath = remapPath(node.path, workspaceRoot, sourceRoot);
        const pkgJsonPath = path.join(sourcePath, "package.json");
        if (!fs.existsSync(pkgJsonPath)) return null;

        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
          main?: string;
          exports?: Record<string, unknown>;
        };

        // Try exports-based resolution, then main field
        let target: string | null = null;
        if (pkgJson.exports) {
          target = resolveExportSubpath(pkgJson.exports, parsed.subpath, conditions);
        }
        if (!target && parsed.subpath === "." && pkgJson.main) {
          target = pkgJson.main;
        }

        if (target) {
          const resolved = path.resolve(sourcePath, target);
          if (fs.existsSync(resolved)) return { path: resolved };

          // dist/ not in git-extracted source — map to TypeScript source
          const srcFallback = resolveSourceFallback(sourcePath, target);
          if (srcFallback) return { path: srcFallback };
        }

        // Last resort: try common source entry patterns
        if (parsed.subpath === ".") {
          for (const entry of SOURCE_ENTRY_CANDIDATES) {
            const full = path.join(sourcePath, entry);
            if (fs.existsSync(full)) return { path: full };
          }
        }

        return null;
      });
    },
  };
}

const SOURCE_ENTRY_CANDIDATES = [
  "src/index.ts", "src/index.tsx", "index.ts", "index.tsx",
];

/** Common build output directories that tsc/other compilers write to (gitignored). */
const BUILD_OUTPUT_DIRS = ["dist", "lib", "build", "out"];

/**
 * Map a build-output export target to its TypeScript source equivalent.
 * Inverts the tsc compilation mapping, e.g.:
 *   ./dist/foo.js    → ./src/foo.ts
 *   ./lib/panel.js   → ./src/panel.ts
 *   ./index.js       → ./index.ts (flat layout, no output dir)
 *
 * Tries each known output dir replacement with src/, then tries the target
 * as-is with .js→.ts rewrite (for flat layouts without an output dir).
 */
function resolveSourceFallback(sourcePath: string, target: string): string | null {
  const candidates: string[] = [];

  // Try replacing each known output dir with src/
  for (const dir of BUILD_OUTPUT_DIRS) {
    const pattern = new RegExp(`^\\./${dir}/`);
    if (pattern.test(target)) {
      candidates.push(target.replace(pattern, "./src/"));
      break; // Only one output dir can match
    }
  }

  // Also try the target as-is (flat layout: ./index.js → ./index.ts)
  candidates.push(target);

  for (const candidate of candidates) {
    const base = candidate.replace(/\.js$/, "");
    for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const full = path.resolve(sourcePath, base + ext);
      if (fs.existsSync(full)) return full;
    }
  }

  return null;
}

/**
 * Rewrite .js extension imports to .ts/.tsx within the extracted source tree.
 *
 * TypeScript ESM sources use .js extensions in imports (e.g., `from "./rpc.js"`)
 * per the TypeScript convention — these reference compiled output. In the git-
 * extracted source, only .ts files exist. This plugin intercepts .js imports
 * within the source root and rewrites them to their .ts/.tsx equivalents.
 */
function createTsExtensionPlugin(sourceRoot: string): esbuild.Plugin {
  return {
    name: "ts-extension-rewrite",
    setup(build) {
      build.onResolve({ filter: /\.js$/ }, (args) => {
        // Only relative imports within extracted source
        if (!args.path.startsWith(".") || !args.resolveDir) return null;
        if (!args.resolveDir.startsWith(sourceRoot)) return null;

        const resolved = path.resolve(args.resolveDir, args.path);
        if (fs.existsSync(resolved)) return null; // .js exists, use it

        // Try .ts and .tsx equivalents
        const base = resolved.slice(0, -3); // strip .js
        for (const ext of [".ts", ".tsx"]) {
          if (fs.existsSync(base + ext)) return { path: base + ext };
        }

        return null;
      });
    },
  };
}

/**
 * Parse a workspace import like "@workspace/core" or "@workspace/runtime/config".
 */
function parseWorkspaceImport(
  importPath: string,
): { packageName: string; subpath: string } | null {
  // Match @workspace/name, @workspace-panels/name, @workspace-about/name, @workspace-agents/name
  const match = importPath.match(/^(@workspace(?:-\w+)?)\/([^/]+)(\/.*)?$/);
  if (!match) return null;

  const scope = match[1];
  const name = match[2]!;
  const rest = match[3] ?? "";
  const packageName = `${scope}/${name}`;
  const subpath = rest ? `.${rest}` : ".";

  return { packageName, subpath };
}

/**
 * Resolve a subpath from package.json exports.
 * Handles nested condition objects recursively.
 */
function resolveExportSubpath(
  exports: Record<string, unknown>,
  subpath: string,
  conditions: readonly string[],
): string | null {
  const entry = exports[subpath];
  if (!entry) return null;

  if (typeof entry === "string") return entry;

  if (typeof entry === "object" && entry !== null) {
    // Condition object — try each condition in order
    const condObj = entry as Record<string, unknown>;
    for (const cond of conditions) {
      if (cond in condObj) {
        const val = condObj[cond];
        if (typeof val === "string") return val;
        if (typeof val === "object" && val !== null) {
          // Nested conditions — recurse
          return resolveFromConditionObject(
            val as Record<string, unknown>,
            conditions,
          );
        }
      }
    }
  }

  return null;
}

function resolveFromConditionObject(
  obj: Record<string, unknown>,
  conditions: readonly string[],
): string | null {
  for (const cond of conditions) {
    if (cond in obj) {
      const val = obj[cond];
      if (typeof val === "string") return val;
      if (typeof val === "object" && val !== null) {
        return resolveFromConditionObject(
          val as Record<string, unknown>,
          conditions,
        );
      }
    }
  }
  return null;
}

function isBareSpecifier(spec: string): boolean {
  return !spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("node:");
}

function normalizeManifestSpecList(specs: string[] | undefined): string[] {
  if (!specs) return [];
  const deduped = new Set<string>();
  for (const raw of specs) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (!value || !isBareSpecifier(value)) continue;
    deduped.add(value);
  }
  return [...deduped].sort();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function packageToRegex(pkg: string): RegExp {
  return new RegExp(`^${escapeRegex(pkg)}(?:$|/)`);
}

function sanitizeModuleForFileName(specifier: string): string {
  return specifier.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function pickResolveDir(nodePaths: string[], fallback: string): string {
  for (const p of nodePaths) {
    if (p && fs.existsSync(p)) return p;
  }
  return fallback;
}

function expandExternalSpecifiers(externals: Record<string, string>): string[] {
  const patterns = new Set<string>();
  for (const specifier of Object.keys(externals)) {
    if (!specifier) continue;
    patterns.add(specifier);
    if (specifier.endsWith("/")) {
      patterns.add(`${specifier}*`);
    }
  }
  return [...patterns];
}

function pickForcedSplitModules(
  transitiveExternals: Record<string, string>,
  exposeModules: string[],
): string[] {
  const selected = new Set<string>();

  for (const pkg of FORCED_SPLIT_PACKAGES) {
    if (transitiveExternals[pkg]) {
      selected.add(pkg);
    }
  }

  // If a module is explicitly exposed for __natstackRequire__, keep it split out.
  for (const specifier of exposeModules) {
    if (transitiveExternals[specifier]) {
      selected.add(specifier);
    }
  }

  return [...selected].sort();
}

function createDedupePlugin(
  runtimeNodeModules: string,
  packages: string[],
): esbuild.Plugin | null {
  if (!runtimeNodeModules || !fs.existsSync(runtimeNodeModules)) {
    return null;
  }
  if (packages.length === 0) {
    return null;
  }

  const resolvedRuntimeNodeModules = path.resolve(runtimeNodeModules);
  const patterns = packages.map((pkg) => packageToRegex(pkg));

  return {
    name: "module-dedupe",
    setup(build) {
      for (const pattern of patterns) {
        build.onResolve({ filter: pattern }, async (args) => {
          // Keep resolution unchanged when we're already resolving from runtime node_modules.
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
            // Fall through to default resolver.
          }
          return null;
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// FS/Path Shim Plugins
// ---------------------------------------------------------------------------

function createFsShimPlugin(resolveDir: string): esbuild.Plugin {
  return {
    name: "fs-shim",
    setup(build) {
      build.onResolve(
        { filter: /^(fs|node:fs|fs\/promises|node:fs\/promises)$/ },
        (args) => ({
          path: args.path,
          namespace: "workspace-fs-shim",
        }),
      );

      build.onLoad(
        { filter: /.*/, namespace: "workspace-fs-shim" },
        (args) => {
          const isPromises =
            args.path === "fs/promises" || args.path === "node:fs/promises";
          // @workspace/runtime exports `fs` as a Proxy object with async methods.
          // We destructure individual methods from it for Node fs/promises compat.
          const contents = isPromises
            ? `import { fs as _fs } from "@workspace/runtime";
export const readFile = (...a) => _fs.readFile(...a);
export const writeFile = (...a) => _fs.writeFile(...a);
export const readdir = (...a) => _fs.readdir(...a);
export const stat = (...a) => _fs.stat(...a);
export const lstat = (...a) => _fs.lstat(...a);
export const mkdir = (...a) => _fs.mkdir(...a);
export const rmdir = (...a) => _fs.rmdir(...a);
export const unlink = (...a) => _fs.unlink(...a);
export const rename = (...a) => _fs.rename(...a);
export const copyFile = (...a) => _fs.copyFile(...a);
export const access = (...a) => _fs.access(...a);
export const appendFile = (...a) => _fs.appendFile(...a);
export const chmod = (...a) => _fs.chmod(...a);
export const chown = (...a) => _fs.chown(...a);
export const symlink = (...a) => _fs.symlink(...a);
export const readlink = (...a) => _fs.readlink(...a);
export const realpath = (...a) => _fs.realpath(...a);
export const truncate = (...a) => _fs.truncate(...a);
export const utimes = (...a) => _fs.utimes(...a);
export const rm = (...a) => _fs.rm(...a);
export const open = (...a) => _fs.open(...a);
export const link = (...a) => _fs.symlink(...a);
export const mkdtemp = () => { throw new Error("mkdtemp is not available in workspace panels"); };
export const watch = () => { throw new Error("watch is not available in workspace panels"); };
export const cp = () => { throw new Error("cp is not available in workspace panels"); };
export const constants = {};`
            : `import { fs as _fs } from "@workspace/runtime";
export const promises = _fs;
export const readFile = (...a) => _fs.readFile(...a);
export const writeFile = (...a) => _fs.writeFile(...a);
export const readdir = (...a) => _fs.readdir(...a);
export const stat = (...a) => _fs.stat(...a);
export const lstat = (...a) => _fs.lstat(...a);
export const mkdir = (...a) => _fs.mkdir(...a);
export const rmdir = (...a) => _fs.rmdir(...a);
export const unlink = (...a) => _fs.unlink(...a);
export const rename = (...a) => _fs.rename(...a);
export const copyFile = (...a) => _fs.copyFile(...a);
export const access = (...a) => _fs.access(...a);
export const constants = {};
export const existsSync = () => { throw new Error("Synchronous fs methods are not available in workspace panels. Use async alternatives."); };
export const readFileSync = existsSync;
export const writeFileSync = existsSync;
export const readdirSync = existsSync;
export const statSync = existsSync;
export const mkdirSync = existsSync;
export default { promises: _fs, readFile: (...a) => _fs.readFile(...a), writeFile: (...a) => _fs.writeFile(...a), readdir: (...a) => _fs.readdir(...a), stat: (...a) => _fs.stat(...a), constants: {}, existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync };`;
          return { contents, loader: "js", resolveDir };
        },
      );
    },
  };
}

function createPathShimPlugin(resolveDir: string): esbuild.Plugin {
  return {
    name: "path-shim",
    setup(build) {
      build.onResolve(
        { filter: /^(path|node:path|path\/posix|node:path\/posix)$/ },
        (args) => ({
          path: args.path,
          namespace: "workspace-path-shim",
        }),
      );

      build.onLoad(
        { filter: /.*/, namespace: "workspace-path-shim" },
        () => ({
          contents: `export { basename, dirname, extname, format, isAbsolute, join, normalize, parse, relative, resolve, sep, delimiter, toNamespacedPath } from "pathe";
import * as pathe from "pathe";
export const posix = pathe;
export default pathe;`,
          loader: "js",
          resolveDir,
        }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// HTML Generation
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generatePanelHtml(
  title: string,
  sourcePath: string,
  options: { hasCss: boolean; externals?: Record<string, string> },
): string {
  // Check for custom index.html
  const customHtmlPath = path.join(sourcePath, "index.html");
  if (fs.existsSync(customHtmlPath)) {
    let html = fs.readFileSync(customHtmlPath, "utf-8");
    if (
      options.externals &&
      Object.keys(options.externals).length > 0 &&
      !/<script[^>]+type\s*=\s*["']importmap["']/i.test(html)
    ) {
      const importMapScript = `<script type="importmap">${JSON.stringify({ imports: options.externals })}</script>`;
      if (/<head\b[^>]*>/i.test(html)) {
        html = html.replace(/(<head\b[^>]*>)/i, `$1\n  ${importMapScript}`);
      } else {
        html = `${importMapScript}\n${html}`;
      }
    }
    // Inject CSP if not present
    if (
      !/<meta[^>]+http-equiv\s*=\s*["']Content-Security-Policy["']/i.test(html)
    ) {
      html = html.replace(/(<head\b[^>]*>)/i, `$1\n  ${PANEL_CSP_META}`);
    }
    return html;
  }

  const cssLink = options.hasCss
    ? `\n  <link rel="stylesheet" href="./bundle.css" />`
    : "";
  const importMapScript = options.externals && Object.keys(options.externals).length > 0
    ? `<script type="importmap">${JSON.stringify({ imports: options.externals })}</script>\n  `
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${PANEL_CSP_META}
  <title>${escapeHtml(title)}</title>
  ${importMapScript}<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@radix-ui/themes@3.2.1/styles.css">${cssLink}
  <style>
    html, body { margin: 0; padding: 0; height: 100%; }
    #root, #root > .radix-themes { min-height: 100vh; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./bundle.js"></script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Entry point wrappers
// ---------------------------------------------------------------------------

function generateModuleMapBootstrap(): string {
  return `globalThis.__natstackModuleMap__ = globalThis.__natstackModuleMap__ || {};
globalThis.__natstackModuleLoadingPromises__ = globalThis.__natstackModuleLoadingPromises__ || {};
globalThis.__natstackRequire__ = function(id) {
  const mod = globalThis.__natstackModuleMap__[id];
  if (mod) return mod;
  throw new Error('Module "' + id + '" not available via __natstackRequire__');
};
globalThis.__natstackRequireAsync__ = async function(id) {
  if (globalThis.__natstackModuleMap__[id]) return globalThis.__natstackModuleMap__[id];
  if (globalThis.__natstackModuleLoadingPromises__[id]) return globalThis.__natstackModuleLoadingPromises__[id];
  const loadPromise = import(id).then((mod) => {
    globalThis.__natstackModuleMap__[id] = mod;
    return mod;
  }).finally(() => {
    delete globalThis.__natstackModuleLoadingPromises__[id];
  });
  globalThis.__natstackModuleLoadingPromises__[id] = loadPromise;
  return loadPromise;
};`;
}

function generateExposeModuleCode(exposeModules: string[]): string {
  const importLines = exposeModules.map(
    (dep, index) => `import * as __mod${index}__ from ${JSON.stringify(dep)};`,
  );
  const registerLines = exposeModules.map(
    (dep, index) =>
      `globalThis.__natstackModuleMap__[${JSON.stringify(dep)}] = __mod${index}__;`,
  );

  return `${generateModuleMapBootstrap()}
${importLines.join("\n")}
${registerLines.join("\n")}
`;
}

function isSyntheticSplitEntryOutput(fileName: string): boolean {
  return /^split-\d+\.js(\.map)?$/.test(fileName);
}

function generatePanelEntry(
  exposeEntryFile: string,
  entryFile: string,
  hasReact: boolean,
): string {
  if (hasReact) {
    return `import ${JSON.stringify(exposeEntryFile)};
import { autoMountReactPanel, shouldAutoMount } from "@workspace/react";
import * as userModule from ${JSON.stringify(entryFile)};

if (shouldAutoMount(userModule)) {
  autoMountReactPanel(userModule);
}
`;
  }
  return `import ${JSON.stringify(exposeEntryFile)};
import ${JSON.stringify(entryFile)};\n`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildOptions {
  sourcemap: boolean;
}

/**
 * Build a single unit (panel, about page, or agent).
 * Returns a BuildResult from the content-addressed store.
 *
 * @param commitMap - Optional map of unit name → commit SHA for source extraction.
 *   When provided (from push trigger), ensures extraction uses the same commits
 *   that EVs were derived from. When absent, extraction snapshots from git on the spot.
 */
export async function buildUnit(
  node: GraphNode,
  ev: string,
  graph: PackageGraph,
  workspaceRoot: string,
  commitMap?: Map<string, string>,
): Promise<BuildResult> {
  const sourcemap = node.manifest.sourcemap !== false;
  const buildKey = computeBuildKey(node.name, ev, sourcemap);

  // Check store first
  const cached = buildStore.get(buildKey);
  if (cached) return cached;

  // Check for in-flight build (coalescing)
  const inFlight = inFlightBuilds.get(buildKey);
  if (inFlight) return inFlight;

  const buildPromise = doBuild(node, ev, buildKey, graph, workspaceRoot, sourcemap, commitMap);
  inFlightBuilds.set(buildKey, buildPromise);

  try {
    return await buildPromise;
  } finally {
    inFlightBuilds.delete(buildKey);
  }
}

async function doBuild(
  node: GraphNode,
  ev: string,
  buildKey: string,
  graph: PackageGraph,
  workspaceRoot: string,
  sourcemap: boolean,
  commitMap?: Map<string, string>,
): Promise<BuildResult> {
  await acquireSemaphore();

  // Extract source from git before building
  const extracted = extractSourceForBuild(node, graph, workspaceRoot, commitMap);

  try {
    if (node.kind === "agent") {
      return await buildAgent(node, ev, buildKey, graph, workspaceRoot, sourcemap, extracted.sourceRoot);
    } else {
      return await buildPanel(node, ev, buildKey, graph, workspaceRoot, sourcemap, extracted.sourceRoot);
    }
  } finally {
    releaseSemaphore();
    extracted.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Panel / About Build
// ---------------------------------------------------------------------------

async function buildPanel(
  node: GraphNode,
  ev: string,
  buildKey: string,
  graph: PackageGraph,
  workspaceRoot: string,
  sourcemap: boolean,
  sourceRoot: string,
): Promise<BuildResult> {
  const outdir = path.join(
    require("os").tmpdir(),
    "natstack-builds",
    `build-${buildKey}`,
  );
  fs.mkdirSync(outdir, { recursive: true });

  // Resolve entry point from extracted source
  const sourcePath = remapPath(node.path, workspaceRoot, sourceRoot);
  const entryFile = resolveEntryPoint(node, sourcePath);

  // Collect and install external deps (from real filesystem, not git)
  const externalDeps = collectTransitiveExternalDeps(node, graph);
  const nodeModulesDir = await ensureExternalDeps(externalDeps);
  const nodePaths = nodeModulesDir ? [nodeModulesDir] : [];

  // Also add the root node_modules for @workspace packages that might need it
  const rootNodeModules = path.join(workspaceRoot, "..", "node_modules");
  if (fs.existsSync(rootNodeModules)) {
    nodePaths.push(rootNodeModules);
  }

  const manifestExternals = node.manifest.externals ?? {};
  const externalSpecifiers = expandExternalSpecifiers(manifestExternals);
  const exposeModules = normalizeManifestSpecList(node.manifest.exposeModules);
  const dedupePackages = normalizeManifestSpecList([
    ...DEFAULT_DEDUPE_PACKAGES,
    ...(node.manifest.dedupeModules ?? []),
  ]);
  const forcedSplitModules = pickForcedSplitModules(externalDeps, exposeModules);
  const resolveDir = pickResolveDir(nodePaths, workspaceRoot);

  // Check for React
  const hasReact = "@workspace/react" in node.dependencies;

  // Generate expose/wrapper entries.
  const exposePath = path.join(outdir, "_expose.js");
  fs.writeFileSync(exposePath, generateExposeModuleCode(exposeModules));

  const wrapperCode = generatePanelEntry(exposePath, entryFile, hasReact);
  const wrapperPath = path.join(outdir, "_entry.js");
  fs.writeFileSync(wrapperPath, wrapperCode);

  // Force additional split points for known heavy modules to avoid oversized single chunks.
  const entryPoints: Record<string, string> = { bundle: wrapperPath };
  for (const [index, specifier] of forcedSplitModules.entries()) {
    const moduleEntry = path.join(
      outdir,
      `_split_${index}_${sanitizeModuleForFileName(specifier)}.js`,
    );
    fs.writeFileSync(moduleEntry, `import ${JSON.stringify(specifier)};\n`);
    entryPoints[`split-${index}`] = moduleEntry;
  }

  // Build plugins — resolve plugin uses extracted source paths.
  const plugins: esbuild.Plugin[] = [
    createWorkspaceResolvePlugin(graph, workspaceRoot, sourceRoot),
    createTsExtensionPlugin(sourceRoot),
    createFsShimPlugin(resolveDir),
    createPathShimPlugin(resolveDir),
  ];
  const dedupePlugin = createDedupePlugin(resolveDir, dedupePackages);
  if (dedupePlugin) {
    plugins.push(dedupePlugin);
  }

  try {
    const result = await esbuild.build({
      entryPoints,
      bundle: true,
      platform: "browser",
      target: "es2022",
      format: "esm",
      splitting: true,
      outdir,
      jsx: "automatic",
      sourcemap: sourcemap ? "inline" : false,
      metafile: true,
      logLevel: "warning",
      conditions: [...PANEL_CONDITIONS],
      plugins,
      nodePaths,
      loader: PANEL_ASSET_LOADERS,
      assetNames: "assets/[name]-[hash]",
      entryNames: "[name]",
      chunkNames: "chunk-[hash]",
      external: externalSpecifiers,
      tsconfigRaw: { compilerOptions: { jsx: "react-jsx" } },
    });

    if (isVerboseBuildLogEnabled() && result.metafile) {
      const outputs = Object.entries(result.metafile.outputs);
      const jsChunks = outputs
        .filter(([outputPath, meta]) =>
          outputPath.endsWith(".js") && !meta.entryPoint && Object.keys(meta.inputs).length > 0
        )
        .map(([, meta]) => meta);
      const largestChunkBytes = jsChunks.reduce(
        (max, meta) => Math.max(max, meta.bytes),
        0,
      );
      const mainBundleEntry = outputs.find(([outputPath]) => outputPath.endsWith("/bundle.js") || outputPath === "bundle.js");
      const mainBundleBytes = mainBundleEntry?.[1].bytes;
      const bundleSizeText = formatBytes(mainBundleBytes ?? 0);
      const largestChunkText = jsChunks.length > 0 ? formatBytes(largestChunkBytes) : "0B";

      console.log(
        `[BuildV2] ${node.name}: main=${bundleSizeText}, chunks=${jsChunks.length}, largestChunk=${largestChunkText}`,
      );
    }

    // Read outputs
    const bundlePath = path.join(outdir, "bundle.js");
    const cssPath = path.join(outdir, "bundle.css");

    const bundle = fs.existsSync(bundlePath)
      ? fs.readFileSync(bundlePath, "utf-8")
      : "";
    const css = fs.existsSync(cssPath)
      ? fs.readFileSync(cssPath, "utf-8")
      : undefined;

    // Collect assets (chunks, images, etc.)
    const assets: Record<string, { content: string; encoding?: "base64" }> = {};
    if (result.metafile) {
      for (const outputPath of Object.keys(result.metafile.outputs)) {
        const absPath = path.isAbsolute(outputPath)
          ? outputPath
          : path.join(outdir, outputPath);

        // Skip main bundle and CSS
        const basename = path.basename(absPath);
        if (basename === "bundle.js" || basename === "bundle.css") continue;
        if (isSyntheticSplitEntryOutput(basename)) continue;
        if (!fs.existsSync(absPath)) continue;

        const relativeName = path.relative(outdir, absPath).replace(/\\/g, "/");
        const ext = path.extname(absPath).toLowerCase();
        const isText = TEXT_EXTENSIONS.has(ext);

        assets[relativeName] = isText
          ? { content: fs.readFileSync(absPath, "utf-8") }
          : { content: fs.readFileSync(absPath).toString("base64"), encoding: "base64" };
      }
    }

    // Generate HTML from extracted source (for custom index.html)
    const title = node.manifest.title ?? node.name;
    const html = generatePanelHtml(title, sourcePath, {
      hasCss: !!css,
      externals: manifestExternals,
    });

    // Store artifacts
    const artifacts: BuildArtifacts = {
      bundle,
      css,
      html,
      assets: Object.keys(assets).length > 0 ? assets : undefined,
    };

    const metadata: BuildMetadata = {
      kind: node.kind,
      name: node.name,
      ev,
      sourcemap,
      builtAt: new Date().toISOString(),
    };

    return buildStore.put(buildKey, artifacts, metadata);
  } finally {
    // Clean up temp dir
    try {
      fs.rmSync(outdir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Agent Build
// ---------------------------------------------------------------------------

async function buildAgent(
  node: GraphNode,
  ev: string,
  buildKey: string,
  graph: PackageGraph,
  workspaceRoot: string,
  sourcemap: boolean,
  sourceRoot: string,
): Promise<BuildResult> {
  const outdir = path.join(
    require("os").tmpdir(),
    "natstack-builds",
    `build-${buildKey}`,
  );
  fs.mkdirSync(outdir, { recursive: true });

  // Resolve entry point from extracted source
  const sourcePath = remapPath(node.path, workspaceRoot, sourceRoot);
  const entryFile = resolveEntryPoint(node, sourcePath);

  // Collect and install external deps (from real filesystem, not git)
  const externalDeps = collectTransitiveExternalDeps(node, graph);
  const nodeModulesDir = await ensureExternalDeps(externalDeps);
  const nodePaths = nodeModulesDir ? [nodeModulesDir] : [];

  const rootNodeModules = path.join(workspaceRoot, "..", "node_modules");
  if (fs.existsSync(rootNodeModules)) {
    nodePaths.push(rootNodeModules);
  }

  // Resolve plugin uses extracted source paths — node conditions for agent builds
  const plugins: esbuild.Plugin[] = [
    createWorkspaceResolvePlugin(graph, workspaceRoot, sourceRoot, NODE_CONDITIONS),
    createTsExtensionPlugin(sourceRoot),
  ];

  try {
    await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      splitting: false,
      outfile: path.join(outdir, "bundle.mjs"),
      sourcemap: sourcemap ? "inline" : false,
      metafile: true,
      logLevel: "warning",
      plugins,
      nodePaths,
      external: KNOWN_NATIVE_EXTERNALS,
      tsconfigRaw: { compilerOptions: {} },
    });

    const bundlePath = path.join(outdir, "bundle.mjs");
    const bundle = fs.readFileSync(bundlePath, "utf-8");

    const artifacts: BuildArtifacts = { bundle };
    const metadata: BuildMetadata = {
      kind: "agent",
      name: node.name,
      ev,
      sourcemap,
      builtAt: new Date().toISOString(),
    };

    return buildStore.put(buildKey, artifacts, metadata);
  } finally {
    try {
      fs.rmSync(outdir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the entry point for a node.
 * Uses sourcePath (extracted from git) instead of node.path.
 */
function resolveEntryPoint(node: GraphNode, sourcePath: string): string {
  const explicit = node.manifest.entry;
  if (explicit) {
    const full = path.join(sourcePath, explicit);
    if (fs.existsSync(full)) return full;
  }

  // Try common entry points
  for (const candidate of [
    "index.tsx", "index.ts", "index.jsx", "index.js",
    "src/index.tsx", "src/index.ts", "src/index.jsx", "src/index.js",
  ]) {
    const full = path.join(sourcePath, candidate);
    if (fs.existsSync(full)) return full;
  }

  throw new Error(`No entry point found for ${node.name} at ${sourcePath}`);
}
