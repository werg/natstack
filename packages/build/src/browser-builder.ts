import type {
  BuildOptions,
  PanelManifest,
  PanelBuildResult,
  BuildFileSystem,
  FrameworkPreset,
} from "./types.js";
import { REACT_PRESET, createImportMap, getImportMapPackages } from "./types.js";
import { createCdnResolverPlugin } from "./cdn-resolver.js";

/**
 * Minimal esbuild API surface required by BrowserPanelBuilder.
 * This allows esbuild to be injected rather than statically imported.
 */
export interface EsbuildAPI {
  build(options: {
    entryPoints: string[];
    bundle: boolean;
    platform: string;
    target: string;
    format: string;
    sourcemap: boolean | "inline";
    minify: boolean;
    write: boolean;
    outdir?: string;
    plugins: EsbuildPlugin[];
    external: string[];
    jsx: string;
    loader: Record<string, string>;
  }): Promise<{
    outputFiles?: Array<{ path: string; text: string }>;
    errors?: Array<{ text: string }>;
  }>;
}

/**
 * Minimal esbuild plugin types for type-safety without importing esbuild
 */
export interface EsbuildPlugin {
  name: string;
  setup: (build: EsbuildPluginBuild) => void;
}

export interface EsbuildPluginBuild {
  onResolve(
    options: { filter: RegExp },
    callback: (args: {
      path: string;
      importer: string;
    }) => { path: string; namespace?: string; external?: boolean } | null | undefined
  ): void;
  onLoad(
    options: { filter: RegExp; namespace?: string },
    callback: (args: { path: string }) =>
      | { contents: string; loader: string }
      | { errors: Array<{ text: string }> }
  ): void;
}

/**
 * Initialization function type for esbuild-wasm
 */
export interface EsbuildInitializer {
  initialize(options: { wasmURL: string }): Promise<void>;
}

/**
 * Build artifact cache entry
 */
interface CachedBuildArtifact {
  hash: string;
  timestamp: number;
  artifacts: import("./types.js").PanelBuildArtifacts;
}

/**
 * Global esbuild singleton storage
 * Stored on globalThis to ensure single instance across all panel contexts
 */
interface EsbuildGlobal {
  __natstackEsbuildInstance?: EsbuildAPI;
  __natstackEsbuildInitialized?: boolean;
  /** Cache of built artifacts by content hash */
  __natstackBuildCache?: Map<string, CachedBuildArtifact>;
}

const globalStore = globalThis as EsbuildGlobal;

/**
 * Get or initialize the global build cache
 */
function getBuildCache(): Map<string, CachedBuildArtifact> {
  if (!globalStore.__natstackBuildCache) {
    globalStore.__natstackBuildCache = new Map();
  }
  return globalStore.__natstackBuildCache;
}

/**
 * Set the esbuild instance to use for building.
 * Call this before using BrowserPanelBuilder if you're dynamically importing esbuild.
 *
 * This stores esbuild on globalThis to ensure a single instance across all panel contexts.
 * Multiple panels can safely call this - the first initialization wins.
 *
 * @example
 * ```typescript
 * // Dynamic import from CDN
 * const esbuild = await import("https://esm.sh/esbuild-wasm@0.25.5");
 * await esbuild.initialize({ wasmURL: CDN_DEFAULTS.ESBUILD_WASM_BINARY });
 * setEsbuildInstance(esbuild);
 * ```
 */
export function setEsbuildInstance(esbuild: EsbuildAPI): void {
  if (globalStore.__natstackEsbuildInitialized) {
    console.log('[BrowserPanelBuilder] esbuild already initialized globally, reusing existing instance');
    return;
  }

  globalStore.__natstackEsbuildInstance = esbuild;
  globalStore.__natstackEsbuildInitialized = true;
  console.log('[BrowserPanelBuilder] esbuild initialized globally');
}

/**
 * Get the current esbuild instance.
 * Returns null if not initialized.
 */
export function getEsbuildInstance(): EsbuildAPI | null {
  return globalStore.__natstackEsbuildInstance ?? null;
}

/**
 * Check if esbuild is initialized
 */
export function isEsbuildInitialized(): boolean {
  return globalStore.__natstackEsbuildInitialized ?? false;
}

/**
 * Compute a hash of the source files to use as cache key
 */
async function computeSourceHash(
  fs: import("./types.js").BuildFileSystem,
  panelPath: string,
  entryPath: string
): Promise<string> {
  // Simple hash based on entry file content + timestamp
  // In a real implementation, you'd want to hash all dependencies too
  try {
    const entryContent = await fs.readFile(entryPath);
    const manifestContent = await fs.readFile(`${panelPath}/package.json`);

    // Combine content for hashing
    const combined = entryContent + manifestContent;

    // Simple hash using built-in crypto if available
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const encoder = new TextEncoder();
      const data = encoder.encode(combined);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    }

    // Fallback: simple string hash
    let hash = 0;
    for (let i = 0; i < combined.length; i++) {
      const char = combined.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16).padStart(16, '0').slice(0, 16);
  } catch {
    // If we can't compute hash, use timestamp to prevent caching
    return Date.now().toString(16);
  }
}

/**
 * Get cached build artifacts if available
 */
function getCachedBuild(hash: string): import("./types.js").PanelBuildArtifacts | null {
  const cache = getBuildCache();
  const cached = cache.get(hash);

  if (cached) {
    const age = Date.now() - cached.timestamp;
    const MAX_CACHE_AGE = 5 * 60 * 1000; // 5 minutes

    if (age < MAX_CACHE_AGE) {
      console.log(`[BrowserPanelBuilder] Cache hit for hash ${hash} (age: ${(age / 1000).toFixed(1)}s)`);
      return cached.artifacts;
    } else {
      console.log(`[BrowserPanelBuilder] Cache expired for hash ${hash} (age: ${(age / 1000).toFixed(1)}s)`);
      cache.delete(hash);
    }
  }

  return null;
}

/**
 * Store build artifacts in cache
 */
function cacheBuild(hash: string, artifacts: import("./types.js").PanelBuildArtifacts): void {
  const cache = getBuildCache();

  // Limit cache size to prevent memory bloat
  const MAX_CACHE_SIZE = 20;
  if (cache.size >= MAX_CACHE_SIZE) {
    // Remove oldest entry
    const oldestKey = Array.from(cache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp)[0]?.[0];
    if (oldestKey) {
      cache.delete(oldestKey);
      console.log(`[BrowserPanelBuilder] Evicted old cache entry to make room`);
    }
  }

  cache.set(hash, {
    hash,
    timestamp: Date.now(),
    artifacts,
  });

  console.log(`[BrowserPanelBuilder] Cached build artifacts (hash: ${hash}, cache size: ${cache.size})`);
}

/**
 * Clear the build cache (useful for debugging)
 */
export function clearBuildCache(): void {
  const cache = getBuildCache();
  const size = cache.size;
  cache.clear();
  console.log(`[BrowserPanelBuilder] Cleared ${size} cached builds`);
}

/**
 * Extended build options with framework preset support
 */
export interface BrowserBuildOptions extends BuildOptions {
  /** Framework preset (defaults to React) */
  preset?: FrameworkPreset;
}

/**
 * Browser-compatible panel builder using esbuild-wasm
 */
export class BrowserPanelBuilder {
  private options: BrowserBuildOptions;
  private preset: FrameworkPreset;

  constructor(options: BrowserBuildOptions) {
    this.options = options;
    this.preset = options.preset ?? REACT_PRESET;
  }

  /**
   * Load and parse the panel manifest from package.json
   */
  async loadManifest(panelPath: string): Promise<PanelManifest> {
    const packageJsonPath = this.joinPath(panelPath, "package.json");

    if (!(await this.options.fs.exists(packageJsonPath))) {
      throw new Error(`package.json not found in ${panelPath}`);
    }

    const content = await this.options.fs.readFile(packageJsonPath);
    const packageJson = JSON.parse(content) as {
      natstack?: PanelManifest;
      dependencies?: Record<string, string>;
    };

    if (!packageJson.natstack) {
      throw new Error(
        `package.json in ${panelPath} must include a 'natstack' field`
      );
    }

    const manifest = packageJson.natstack;

    if (!manifest.title) {
      throw new Error("natstack.title must be specified in package.json");
    }

    // Merge package.json dependencies
    if (packageJson.dependencies) {
      manifest.dependencies = {
        ...manifest.dependencies,
        ...packageJson.dependencies,
      };
    }

    return manifest;
  }

  /**
   * Resolve the entry point for the panel
   */
  async resolveEntryPoint(
    panelPath: string,
    manifest: PanelManifest
  ): Promise<string> {
    const verifyEntry = async (entry: string): Promise<string | null> => {
      const entryPath = this.joinPath(panelPath, entry);
      return (await this.options.fs.exists(entryPath)) ? entry : null;
    };

    if (manifest.entry) {
      const entry = await verifyEntry(manifest.entry);
      if (!entry) {
        throw new Error(`Entry point not found: ${manifest.entry}`);
      }
      return entry;
    }

    const candidates = [
      "index.tsx",
      "index.ts",
      "index.jsx",
      "index.js",
      "main.tsx",
      "main.ts",
    ];

    for (const candidate of candidates) {
      const entry = await verifyEntry(candidate);
      if (entry) return entry;
    }

    throw new Error(
      `No entry point found. Provide an entry file (e.g., index.tsx) or set 'entry' in package.json natstack field`
    );
  }

  /**
   * Generate default HTML template for the panel
   * Uses the framework preset for import map and CSS
   */
  generateHtml(title: string): string {
    const importMap = createImportMap(this.preset);
    const cssLinks = this.preset.cssLinks
      .map((url) => `  <link rel="stylesheet" href="${url}">`)
      .join("\n");
    const csp =
      "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; " +
      "script-src * data: blob: 'unsafe-inline' 'unsafe-eval'; " +
      "style-src * data: blob: 'unsafe-inline'; " +
      "img-src * data: blob:; " +
      "connect-src * data: blob:;";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>${this.escapeHtml(title)}</title>
  <script type="importmap">${JSON.stringify(importMap)}</script>
${cssLinks}
  <style id="panel-css"></style>
</head>
<body>
  <div id="root"></div>
  <!-- BUNDLE_PLACEHOLDER -->
</body>
</html>`;
  }

  /**
   * Build a panel from OPFS sources
   */
  async build(panelPath: string): Promise<PanelBuildResult> {
    try {
      // Ensure esbuild is initialized (check global singleton)
      if (!isEsbuildInitialized()) {
        return {
          success: false,
          error:
            "esbuild not initialized. Call setEsbuildInstance() with a dynamically imported esbuild-wasm module before building.",
        };
      }

      const esbuild = getEsbuildInstance();
      if (!esbuild) {
        return {
          success: false,
          error: "esbuild instance is null after initialization check",
        };
      }

      // Load manifest
      const manifest = await this.loadManifest(panelPath);

      // Resolve entry point
      const entry = await this.resolveEntryPoint(panelPath, manifest);
      const entryPath = this.joinPath(panelPath, entry);

      // Compute source hash for caching
      const sourceHash = await computeSourceHash(this.options.fs, panelPath, entryPath);

      // Check cache
      const cached = getCachedBuild(sourceHash);
      if (cached) {
        return {
          success: true,
          artifacts: cached,
        };
      }

      // Collect all source files
      const sourceFiles = await this.collectSourceFiles(panelPath);

      // Create virtual file system plugin for esbuild
      const virtualFsPlugin = this.createVirtualFsPlugin(panelPath, sourceFiles);

      // Create CDN resolver plugin with preset
      const cdnPlugin = createCdnResolverPlugin(
        this.options.dependencyResolver,
        this.options.runtimeModules,
        this.preset
      );

      // Create wrapper entry using the preset's template
      const wrapperCode = this.preset.wrapperTemplate("./" + entry);

      // Add wrapper to virtual files
      sourceFiles.set("__wrapper__.tsx", wrapperCode);

      // Build with esbuild-wasm using entryPoints instead of stdin
      // This avoids esbuild trying to read the real filesystem
      const wrapperPath = this.joinPath(panelPath, "__wrapper__.tsx");
      const result = await esbuild.build({
        entryPoints: [wrapperPath],
        bundle: true,
        platform: "browser",
        target: "es2022",
        format: "esm",
        sourcemap: this.options.sourcemap ? "inline" : false,
        minify: this.options.minify ?? false,
        write: false,
        // outdir is required when CSS is imported into JS (tells esbuild output structure)
        outdir: "/out",
        plugins: [virtualFsPlugin, cdnPlugin],
        // Mark CDN URLs as external
        external: ["https://*", "http://*"],
        // Use JSX settings from preset
        jsx: this.preset.jsx,
        loader: {
          ".ts": "ts",
          ".tsx": "tsx",
          ".js": "js",
          ".jsx": "jsx",
          ".css": "css",
          ".json": "json",
        },
      });

      // Extract outputs
      const jsOutput = result.outputFiles?.find(
        (f) => f.path.endsWith(".js") || f.path === "<stdout>"
      );
      const cssOutput = result.outputFiles?.find((f) => f.path.endsWith(".css"));

      if (!jsOutput) {
        return {
          success: false,
          error: "Build produced no JavaScript output",
        };
      }

      // Check for custom HTML or generate default
      let html: string;
      const customHtmlPath = this.joinPath(panelPath, "index.html");
      if (await this.options.fs.exists(customHtmlPath)) {
        html = await this.options.fs.readFile(customHtmlPath);
      } else {
        html = this.generateHtml(manifest.title);
      }

      const artifacts = {
        bundle: jsOutput.text,
        html,
        manifest,
        css: cssOutput?.text,
        sourceMap: undefined, // Inline in bundle when enabled
      };

      // Cache the build artifacts
      cacheBuild(sourceHash, artifacts);

      return {
        success: true,
        artifacts,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Collect all source files from the panel directory
   */
  private async collectSourceFiles(
    basePath: string
  ): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    await this.walkDirectory(basePath, basePath, files);
    return files;
  }

  private async walkDirectory(
    currentPath: string,
    basePath: string,
    files: Map<string, string>
  ): Promise<void> {
    const entries = await this.options.fs.readdir(currentPath);

    for (const entry of entries) {
      // Skip node_modules and hidden directories
      if (entry === "node_modules" || entry.startsWith(".")) {
        continue;
      }

      const fullPath = this.joinPath(currentPath, entry);
      const isDir = await this.options.fs.isDirectory(fullPath);

      if (isDir) {
        await this.walkDirectory(fullPath, basePath, files);
      } else {
        // Store relative path from base
        const relativePath = this.relativePath(basePath, fullPath);
        try {
          const content = await this.options.fs.readFile(fullPath);
          files.set(relativePath, content);
        } catch {
          // Skip files that can't be read
        }
      }
    }
  }

  /**
   * Create esbuild plugin for virtual file system
   */
  private createVirtualFsPlugin(
    basePath: string,
    files: Map<string, string>
  ): EsbuildPlugin {
    // Create a regex that matches paths starting with basePath
    const basePathRegex = new RegExp(
      `^${basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
    );

    return {
      name: "virtual-fs",
      setup: (build) => {
        // Handle entry points (absolute paths starting with basePath)
        build.onResolve({ filter: basePathRegex }, (args) => {
          const relativePath = this.relativePath(basePath, args.path);
          if (files.has(relativePath)) {
            return { path: args.path, namespace: "virtual" };
          }
          return null;
        });

        // Resolve relative imports within the panel
        build.onResolve({ filter: /^\./ }, (args) => {
          // Resolve relative to the importer's directory
          const importerDir = args.importer
            ? this.dirname(args.importer)
            : basePath;
          const resolved = this.resolvePath(importerDir, args.path);

          // Try with extensions
          const extensions = [".tsx", ".ts", ".jsx", ".js", ".json", ".css"];
          for (const ext of extensions) {
            const withExt = resolved + ext;
            const relativePath = this.relativePath(basePath, withExt);
            if (files.has(relativePath)) {
              return { path: withExt, namespace: "virtual" };
            }
          }

          // Try exact path
          const relativePath = this.relativePath(basePath, resolved);
          if (files.has(relativePath)) {
            return { path: resolved, namespace: "virtual" };
          }

          // Try index files
          for (const ext of extensions) {
            const indexPath = this.joinPath(resolved, `index${ext}`);
            const relativeIndex = this.relativePath(basePath, indexPath);
            if (files.has(relativeIndex)) {
              return { path: indexPath, namespace: "virtual" };
            }
          }

          return null;
        });

        // Load files from virtual FS
        build.onLoad({ filter: /.*/, namespace: "virtual" }, (args) => {
          const relativePath = this.relativePath(basePath, args.path);
          const content = files.get(relativePath);

          if (content === undefined) {
            return {
              errors: [{ text: `File not found: ${relativePath}` }],
            };
          }

          const loader = this.getLoader(args.path);
          return { contents: content, loader };
        });
      },
    };
  }

  /**
   * Get esbuild loader for a file extension
   */
  private getLoader(
    path: string
  ): "tsx" | "ts" | "jsx" | "js" | "css" | "json" | "text" {
    if (path.endsWith(".tsx")) return "tsx";
    if (path.endsWith(".ts")) return "ts";
    if (path.endsWith(".jsx")) return "jsx";
    if (path.endsWith(".js")) return "js";
    if (path.endsWith(".css")) return "css";
    if (path.endsWith(".json")) return "json";
    return "text";
  }

  // Path utilities (browser-compatible, no Node path module)

  private joinPath(...parts: string[]): string {
    return parts
      .join("/")
      .replace(/\/+/g, "/")
      .replace(/\/$/, "");
  }

  private dirname(path: string): string {
    const lastSlash = path.lastIndexOf("/");
    return lastSlash > 0 ? path.slice(0, lastSlash) : "/";
  }

  private relativePath(from: string, to: string): string {
    // Simple implementation - assumes both are absolute paths starting from same root
    const fromParts = from.split("/").filter(Boolean);
    const toParts = to.split("/").filter(Boolean);

    // Find common prefix length
    let commonLength = 0;
    while (
      commonLength < fromParts.length &&
      commonLength < toParts.length &&
      fromParts[commonLength] === toParts[commonLength]
    ) {
      commonLength++;
    }

    // Build relative path
    const upCount = fromParts.length - commonLength;
    const downParts = toParts.slice(commonLength);

    const relativeParts = [
      ...Array(upCount).fill(".."),
      ...downParts,
    ];

    return relativeParts.length > 0 ? relativeParts.join("/") : ".";
  }

  private resolvePath(base: string, relative: string): string {
    if (relative.startsWith("/")) {
      return relative;
    }

    const baseParts = base.split("/").filter(Boolean);
    const relativeParts = relative.split("/");

    for (const part of relativeParts) {
      if (part === "..") {
        baseParts.pop();
      } else if (part !== "." && part !== "") {
        baseParts.push(part);
      }
    }

    return "/" + baseParts.join("/");
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
}
