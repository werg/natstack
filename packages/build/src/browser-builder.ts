import type {
  BuildOptions,
  PanelManifest,
  PanelBuildResult,
  BuildFileSystem,
  FrameworkPreset,
} from "./types.js";
import { REACT_PRESET, createImportMap, getImportMapPackages } from "./types.js";
import { createCdnResolverPlugin } from "./cdn-resolver.js";
import { getUnifiedCache, computeHash } from "./cache-manager.js";
import { CONTENT_HASH_LIMITS } from "./cache-constants.js";

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
 * Global esbuild singleton storage
 * Stored on globalThis to ensure single instance across all panel contexts
 */
interface EsbuildGlobal {
  __natstackEsbuildInstance?: EsbuildAPI;
  __natstackEsbuildInitialized?: boolean;
  /** Development mode flag - when true, cache expires after 5 minutes */
  __natstackDevMode?: boolean;
}

const globalStore = globalThis as EsbuildGlobal;

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
 * Set development mode flag.
 * When enabled, build cache expires after 5 minutes to prevent stale builds during development.
 * When disabled (production), cache never expires based on time.
 *
 * @param enabled - Whether to enable development mode
 */
export function setDevMode(enabled: boolean): void {
  globalStore.__natstackDevMode = enabled;
  console.log(`[BrowserPanelBuilder] Development mode ${enabled ? 'enabled' : 'disabled'} (cache expiration: ${enabled ? '5 minutes' : 'never'})`);
}

/**
 * Get current development mode setting
 */
export function isDevMode(): boolean {
  return globalStore.__natstackDevMode ?? false;
}

/**
 * Recursively collect all source files from a directory with safety limits
 */
async function collectSourceFiles(
  fs: import("./types.js").BuildFileSystem,
  dirPath: string,
  files: Map<string, string>,
  stats: { fileCount: number; totalSize: number }
): Promise<void> {
  try {
    if (!(await fs.exists(dirPath)) || !(await fs.isDirectory(dirPath))) {
      return;
    }

    const entries = await fs.readdir(dirPath);

    // Sort entries for deterministic ordering
    const sortedEntries = entries.sort();

    for (const entry of sortedEntries) {
      // Check file count limit
      if (stats.fileCount >= CONTENT_HASH_LIMITS.MAX_FILES) {
        console.warn(`[BrowserPanelBuilder] Reached file count limit (${CONTENT_HASH_LIMITS.MAX_FILES}) during content hashing`);
        return;
      }

      // Check total size limit
      if (stats.totalSize >= CONTENT_HASH_LIMITS.MAX_TOTAL_SIZE_BYTES) {
        const sizeMB = (CONTENT_HASH_LIMITS.MAX_TOTAL_SIZE_BYTES / 1024 / 1024).toFixed(0);
        console.warn(`[BrowserPanelBuilder] Reached total size limit (${sizeMB}MB) during content hashing`);
        return;
      }

      const fullPath = `${dirPath}/${entry}`;

      if (await fs.isDirectory(fullPath)) {
        // Skip known large directories
        if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'build' || entry === '.next') {
          continue;
        }
        // Recursively traverse subdirectories
        await collectSourceFiles(fs, fullPath, files, stats);
      } else if (
        entry.endsWith('.ts') ||
        entry.endsWith('.tsx') ||
        entry.endsWith('.js') ||
        entry.endsWith('.jsx') ||
        entry.endsWith('.css') ||
        entry.endsWith('.json')
      ) {
        try {
          const content = await fs.readFile(fullPath);
          const fileSize = content.length;

          // Skip files that are too large
          if (fileSize > CONTENT_HASH_LIMITS.MAX_FILE_SIZE_BYTES) {
            const sizeMB = (fileSize / 1024 / 1024).toFixed(2);
            const limitMB = (CONTENT_HASH_LIMITS.MAX_FILE_SIZE_BYTES / 1024 / 1024).toFixed(0);
            console.warn(`[BrowserPanelBuilder] Skipping large file ${fullPath} (${sizeMB}MB > ${limitMB}MB limit)`);
            continue;
          }

          // Store with relative path for deterministic ordering
          files.set(fullPath, content);
          stats.fileCount++;
          stats.totalSize += fileSize;
        } catch {
          // Skip files we can't read
        }
      }
    }
  } catch {
    // Directory doesn't exist or can't be read, skip
  }
}

async function addFileIfExists(
  fs: import("./types.js").BuildFileSystem,
  filePath: string,
  files: Map<string, string>,
  alias?: string
): Promise<void> {
  try {
    if (await fs.exists(filePath)) {
      const content = await fs.readFile(filePath);
      files.set(alias ?? filePath, content);
    }
  } catch {
    // Ignore unreadable files
  }
}

/**
 * Compute a content-addressable hash of all source files and build configuration.
 *
 * Fast path: Uses git commit SHA if available (zero file reads).
 * Fallback: Walks file tree and hashes contents (for non-git panels).
 *
 * This enables maximal sharing - identical source + config produce identical hashes.
 */
async function computeSourceHash(
  fs: import("./types.js").BuildFileSystem,
  panelPath: string,
  entryPath: string,
  buildOptions: {
    minify?: boolean;
    sourcemap?: boolean | 'inline';
    target?: string;
    external?: string[];
    frameworkPreset?: import("./types.js").FrameworkPreset;
  }
): Promise<string> {
  try {
    // Fast path: Use git commit SHAs if available (zero file system operations)
    const global = globalThis as {
      __natstackSourceCommit?: string;
      __natstackDepCommits?: Record<string, string>;
    };

    const sourceCommit = global.__natstackSourceCommit;
    const depCommits = global.__natstackDepCommits;

    // Validate SHA format (must be 40 hex characters for full SHA or 7+ for short SHA)
    const isValidSha = (sha: string): boolean => {
      return /^[0-9a-f]{7,40}$/i.test(sha);
    };

    // Fallback to content hashing function (defined early to avoid hoisting issues)
    const fallbackToContentHashing = async (): Promise<string> => {
      console.log('[BrowserPanelBuilder] Using content-based hashing');

      // Map to store files with their paths as keys (for sorting)
      const fileMap = new Map<string, string>();
      const hashStats = { fileCount: 0, totalSize: 0 };

      // 1. Include manifest (with normalized path)
      await addFileIfExists(fs, `${panelPath}/package.json`, fileMap, '__manifest__');

      // 2. Include lockfiles for dependency tracking (avoids hashing node_modules)
      await addFileIfExists(fs, `${panelPath}/package-lock.json`, fileMap, '__package-lock__');
      await addFileIfExists(fs, `${panelPath}/yarn.lock`, fileMap, '__yarn-lock__');
      await addFileIfExists(fs, `${panelPath}/pnpm-lock.yaml`, fileMap, '__pnpm-lock__');

      // 3. Include entry file (with normalized path)
      await addFileIfExists(fs, entryPath, fileMap, '__entry__');

      // 4. Recursively collect all source files from common directories (with limits)
      const sourceDirs = ['src', 'lib', 'components', 'styles', 'public', 'assets'];
      for (const dir of sourceDirs) {
        await collectSourceFiles(fs, `${panelPath}/${dir}`, fileMap, hashStats);
      }

      // 5. Include common config and env files that affect builds
      const rootFiles = [
        'tsconfig.json',
        'tsconfig.app.json',
        'vite.config.ts',
        'vite.config.js',
        'webpack.config.js',
        'rollup.config.js',
        'babel.config.js',
        'postcss.config.js',
        'tailwind.config.js',
        '.env',
        '.env.local',
        '.env.development',
        '.env.production',
      ];
      for (const file of rootFiles) {
        await addFileIfExists(fs, `${panelPath}/${file}`, fileMap);
      }

      // 5. Sort all files by path for deterministic ordering
      const sortedPaths = Array.from(fileMap.keys()).sort();

      // 6. Build hash input with:
      //    - Build configuration (serialized)
      //    - All file contents in sorted order
      const hashParts: string[] = [];

      const normalizePathForHash = (filePath: string): string => {
        if (filePath.startsWith(panelPath)) {
          const relative = filePath.slice(panelPath.length).replace(/^\/?/, '');
          return relative || filePath;
        }
        return filePath;
      };

      // Include build options in hash
      hashParts.push(JSON.stringify({
        minify: buildOptions.minify ?? false,
        sourcemap: buildOptions.sourcemap ?? false,
        target: buildOptions.target ?? 'es2020',
        external: (buildOptions.external ?? []).sort(), // Sort for determinism
        framework: buildOptions.frameworkPreset?.name ?? 'none',
      }));

      // Include all file contents in sorted order
      for (const path of sortedPaths) {
        const content = fileMap.get(path)!;
        const normalizedPath = normalizePathForHash(path);
        // Include both path and content for better deduplication
        hashParts.push(`[${normalizedPath}]${content}`);
      }

      // Combine and hash
      const combined = hashParts.join('\n---FILE---\n');
      const contentHash = await computeHash(combined);
      return `content:${contentHash}`;
    };

    if (sourceCommit && isValidSha(sourceCommit)) {
      // Build composite cache key: source commit + dependency commits + build config
      const keyParts: string[] = [sourceCommit];

      // Add dependency commits in sorted order for determinism
      if (depCommits && Object.keys(depCommits).length > 0) {
        const sortedDeps = Object.keys(depCommits).sort();
        for (const depName of sortedDeps) {
          const depSha = depCommits[depName];
          // Validate each dependency SHA
          if (!depSha || !isValidSha(depSha)) {
            console.warn(`[BrowserPanelBuilder] Invalid SHA for dependency ${depName}: ${depSha ?? 'undefined'}, falling back to content hashing`);
            // Fall through to content hashing below
            return await fallbackToContentHashing();
          }
          keyParts.push(`${depName}:${depSha}`);
        }
      }

      // Hash the build configuration
      const buildConfigHash = await computeHash(JSON.stringify({
        minify: buildOptions.minify ?? false,
        sourcemap: buildOptions.sourcemap ?? false,
        target: buildOptions.target ?? 'es2020',
        external: (buildOptions.external ?? []).sort(),
        framework: buildOptions.frameworkPreset?.name ?? 'none',
      }));

      keyParts.push(buildConfigHash);

      const hash = `git:${keyParts.join(':')}`;
      const depCount = depCommits ? Object.keys(depCommits).length : 0;
      console.log(
        `[BrowserPanelBuilder] Using git-based cache key: ` +
        `source=${sourceCommit.slice(0, 8)} deps=${depCount}`
      );
      return hash;
    } else if (sourceCommit && !isValidSha(sourceCommit)) {
      console.warn(`[BrowserPanelBuilder] Invalid source commit SHA: ${sourceCommit}, falling back to content hashing`);
    }

    // Call the fallback function (git not available or invalid)
    return await fallbackToContentHashing();
  } catch (error) {
    console.warn('[BrowserPanelBuilder] Failed to compute source hash:', error);
    // Fallback to timestamp-based hash (disables caching)
    return `timestamp:${Date.now().toString(16)}`;
  }
}

/**
 * Get cached build artifacts if available from unified cache
 * Uses content-addressable caching with cross-panel sharing
 */
function getCachedBuild(hash: string): import("./types.js").PanelBuildArtifacts | null {
  const unifiedCache = getUnifiedCache();
  const cacheKey = `build:${hash}`;

  const cachedJson = unifiedCache.get(cacheKey);
  if (cachedJson) {
    try {
      const artifacts = JSON.parse(cachedJson) as import("./types.js").PanelBuildArtifacts;
      console.log(`[BrowserPanelBuilder] Cache hit for hash ${hash} (cross-panel shared)`);
      return artifacts;
    } catch (error) {
      console.warn(`[BrowserPanelBuilder] Failed to parse cached build:`, error);
      return null;
    }
  }

  return null;
}

/**
 * Store build artifacts in unified cache
 *
 * Note: JSON serialization is required here because PanelBuildArtifacts is a
 * structured object (bundle, html, css, manifest). The cache layer stores strings,
 * so we must serialize the entire object. This is not redundant - the bundle field
 * is already a string, but the overall artifacts object is not.
 */
async function cacheBuild(hash: string, artifacts: import("./types.js").PanelBuildArtifacts): Promise<void> {
  const unifiedCache = getUnifiedCache();
  const cacheKey = `build:${hash}`;

  try {
    // Serialize artifacts object to JSON for storage in string-based cache
    const artifactsJson = JSON.stringify(artifacts);

    // Store in unified cache (will be synced to main process and disk)
    await unifiedCache.set(cacheKey, artifactsJson);

    const stats = unifiedCache.getStats();
    console.log(`[BrowserPanelBuilder] Cached build (hash: ${hash}, entries: ${stats.entries}, size: ${(stats.totalSize / 1024 / 1024).toFixed(1)}MB)`);
  } catch (error) {
    console.warn(`[BrowserPanelBuilder] Failed to cache build artifacts:`, error);
  }
}

/**
 * Clear the build cache (useful for debugging)
 * Clears the unified cache (local memory + main process + disk)
 */
export async function clearBuildCache(): Promise<void> {
  try {
    const { clearCache } = await import('./cache-manager.js');
    await clearCache();
    console.log(`[BrowserPanelBuilder] Cleared unified cache (local memory only - use app:clear-build-cache for full clear)`);
  } catch (error) {
    console.warn(`[BrowserPanelBuilder] Failed to clear cache:`, error);
  }
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
      const sourceHash = await computeSourceHash(this.options.fs, panelPath, entryPath, {
        minify: this.options.minify,
        sourcemap: this.options.sourcemap,
        frameworkPreset: this.preset,
      });

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

      // Cache the build artifacts (async, but we don't need to wait)
      void cacheBuild(sourceHash, artifacts);

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
