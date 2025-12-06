import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import Arborist from "@npmcli/arborist";
import type { PanelManifest, PanelBuildResult } from "./panelTypes.js";
import { getMainCacheManager } from "./cacheManager.js";
import { isDev } from "./utils.js";
import { provisionPanelVersion, resolveTargetCommit, type VersionSpec } from "./gitProvisioner.js";
import type { PanelBuildState } from "../shared/ipc/types.js";

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
  /** Panel manifest */
  manifest?: PanelManifest;
  /** Error message if build failed */
  error?: string;
  /** Full build log (for UI) */
  buildLog?: string;
}

const PANEL_RUNTIME_DIRNAME = ".natstack";

// Bundle size limits (very generous to avoid disrupting normal use)
const MAX_BUNDLE_SIZE = 50 * 1024 * 1024; // 50 MB for JS bundle
const MAX_HTML_SIZE = 10 * 1024 * 1024; // 10 MB for HTML
const MAX_CSS_SIZE = 10 * 1024 * 1024; // 10 MB for CSS

// Keep only fs virtual modules.
const panelFsModulePath = path.join(__dirname, "panelFsRuntime.js");
const panelFsPromisesModulePath = path.join(__dirname, "panelFsPromisesRuntime.js");

const fsModuleMap = new Map([
  ["fs", panelFsModulePath],
  ["node:fs", panelFsModulePath],
  ["fs/promises", panelFsPromisesModulePath],
  ["node:fs/promises", panelFsPromisesModulePath],
]);

for (const [name, modulePath] of fsModuleMap) {
  if (!fs.existsSync(modulePath)) {
    throw new Error(`Runtime module ${name} not found at ${modulePath}`);
  }
}

const defaultPanelDependencies: Record<string, string> = {
  // Node types for dependencies that expect them
  "@types/node": "^22.9.0",
};

const defaultWorkerDependencies: Record<string, string> = {
  // Node types for dependencies that expect them
  "@types/node": "^22.9.0",
};

/**
 * Get React dependencies from @natstack/react's peerDependencies.
 * Returns null if @natstack/react package.json can't be found.
 */
function getReactDependenciesFromNatstackReact(): Record<string, string> | null {
  try {
    const natstackReactPkgPath = path.join(process.cwd(), "packages/react/package.json");
    if (!fs.existsSync(natstackReactPkgPath)) {
      return null;
    }
    const pkg = JSON.parse(fs.readFileSync(natstackReactPkgPath, "utf-8")) as {
      peerDependencies?: Record<string, string>;
    };
    const peerDeps = pkg.peerDependencies ?? {};
    const result: Record<string, string> = {};
    if (peerDeps["react"]) result["react"] = peerDeps["react"];
    if (peerDeps["react-dom"]) result["react-dom"] = peerDeps["react-dom"];
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

/**
 * Implicit externals added when certain dependencies are detected.
 * Maps dependency name -> externals to add.
 * This avoids requiring panels to manually specify common externals.
 */
const implicitExternals: Record<string, Record<string, string>> = {
  // @natstack/git uses isomorphic-git which needs CDN loading for Buffer polyfills
  "@natstack/git": {
    "isomorphic-git": "https://esm.sh/isomorphic-git",
    "isomorphic-git/http/web": "https://esm.sh/isomorphic-git/http/web",
  },
};

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
  /** Previous dependency hash for cache optimization */
  previousDependencyHash?: string;
  /** Logger function for build output */
  log?: (message: string) => void;
  /** Whether to emit inline sourcemaps (default: true) */
  inlineSourcemap?: boolean;
}

interface BuildFromSourceResult {
  success: boolean;
  /** The manifest from package.json */
  manifest?: PanelManifest;
  /** Path to bundle file */
  bundlePath?: string;
  /** Path to HTML file */
  htmlPath?: string;
  /** Error message on failure */
  error?: string;
  /** Hash of dependencies for caching */
  dependencyHash?: string;
}

export class PanelBuilder {
  private cacheManager = getMainCacheManager();

  constructor() {
    // CacheManager handles its own storage directory
  }

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

  private getRuntimeDir(panelPath: string): string {
    return path.join(panelPath, PANEL_RUNTIME_DIRNAME);
  }

  private ensureRuntimeDir(panelPath: string): string {
    const runtimeDir = this.getRuntimeDir(panelPath);
    fs.mkdirSync(runtimeDir, { recursive: true });

    // Copy global type definitions to runtime dir for panel TypeScript support
    this.ensureGlobalTypes(runtimeDir);

    return runtimeDir;
  }

  private ensureGlobalTypes(runtimeDir: string): void {
    // Copy globals.d.ts from panelRuntime to the panel's .natstack directory
    const sourceTypesPath = path.join(__dirname, "panelRuntimeGlobals.d.ts");
    const targetTypesPath = path.join(runtimeDir, "globals.d.ts");

    // The globals.d.ts gets compiled to panelRuntimeGlobals.d.ts in dist
    if (fs.existsSync(sourceTypesPath)) {
      const typesContent = fs.readFileSync(sourceTypesPath, "utf-8");
      const existingContent = fs.existsSync(targetTypesPath)
        ? fs.readFileSync(targetTypesPath, "utf-8")
        : null;

      if (existingContent !== typesContent) {
        fs.writeFileSync(targetTypesPath, typesContent);
      }
    }
  }

  private resolveHtmlPath(
    panelPath: string,
    title: string,
    externals?: Record<string, string>
  ): string {
    const sourceHtmlPath = path.join(panelPath, "index.html");
    if (fs.existsSync(sourceHtmlPath)) {
      return sourceHtmlPath;
    }

    const runtimeDir = this.ensureRuntimeDir(panelPath);
    const generatedHtmlPath = path.join(runtimeDir, "index.html");

    // Import map for externals declared in natstack.externals
    // These are loaded via CDN (e.g., esm.sh) instead of bundled
    const importMap = {
      imports: externals ?? {},
    };

    // Only include import map script if there are externals
    const importMapScript =
      Object.keys(importMap.imports).length > 0
        ? `<script type="importmap">${JSON.stringify(importMap)}</script>\n  `
        : "";

    const defaultHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  ${importMapScript}<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@radix-ui/themes@3.2.1/styles.css">
  <link rel="stylesheet" href="./bundle.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./bundle.js"></script>
</body>
</html>`;
    fs.writeFileSync(generatedHtmlPath, defaultHtml);
    return generatedHtmlPath;
  }

  private getNodeResolutionPaths(panelPath: string): string[] {
    const runtimeNodeModules = path.join(this.getRuntimeDir(panelPath), "node_modules");
    const localNodeModules = path.join(panelPath, "node_modules");
    const projectNodeModules = path.join(process.cwd(), "node_modules");

    const paths: string[] = [];
    for (const candidate of [runtimeNodeModules, localNodeModules, projectNodeModules]) {
      paths.push(candidate);
    }
    return paths;
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

  private resolveWorkspaceDependencies(
    dependencies: Record<string, string>
  ): Record<string, string> {
    const resolved: Record<string, string> = {};
    const workspaceRoot = process.cwd();

    for (const [pkg, version] of Object.entries(dependencies)) {
      if (version.startsWith("workspace:")) {
        // Resolve workspace package to file path
        const packagePath = path.join(workspaceRoot, "packages", pkg.split("/")[1] || pkg);
        resolved[pkg] = `file:${packagePath}`;
      } else {
        resolved[pkg] = version;
      }
    }

    return resolved;
  }

  private async installDependencies(
    panelPath: string,
    dependencies: Record<string, string> | undefined,
    previousHash?: string
  ): Promise<string | undefined> {
    if (!dependencies || Object.keys(dependencies).length === 0) {
      return undefined;
    }

    const runtimeDir = this.ensureRuntimeDir(panelPath);
    const packageJsonPath = path.join(runtimeDir, "package.json");

    // Resolve workspace:* to file: paths
    const resolvedDependencies = this.resolveWorkspaceDependencies(dependencies);

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
    const desiredHash = crypto.createHash("sha256").update(serialized).digest("hex");

    const nodeModulesPath = path.join(runtimeDir, "node_modules");
    const packageLockPath = path.join(runtimeDir, "package-lock.json");

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

    if (fs.existsSync(nodeModulesPath)) {
      fs.rmSync(nodeModulesPath, { recursive: true, force: true });
    }
    if (fs.existsSync(packageLockPath)) {
      fs.rmSync(packageLockPath, { recursive: true, force: true });
    }

    const arborist = new Arborist({ path: runtimeDir });
    await arborist.buildIdealTree();
    await arborist.reify();

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
      previousDependencyHash,
      log = console.log.bind(console),
      inlineSourcemap = true,
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

    // Install dependencies
    log(`Installing dependencies...`);
    const runtimeDependencies = this.mergeRuntimeDependencies(manifest.dependencies);
    const dependencyHash = await this.installDependencies(
      sourcePath,
      runtimeDependencies,
      previousDependencyHash
    );
    log(`Dependencies installed`);

    // Determine entry point
    const entry = this.resolveEntryPoint(sourcePath, manifest);
    const entryPath = path.join(sourcePath, entry);

    const runtimeDir = this.ensureRuntimeDir(sourcePath);
    const bundlePath = path.join(runtimeDir, "bundle.js");
    const nodePaths = this.getNodeResolutionPaths(sourcePath);

    // Determine if panel uses @natstack/react (enables auto-mount)
    const hasNatstackReact = "@natstack/react" in (manifest.dependencies ?? {});

    // Create wrapper entry
    const tempEntryPath = path.join(runtimeDir, "_entry.js");
    const relativeUserEntry = path.relative(runtimeDir, entryPath);

    let wrapperCode: string;
    if (hasNatstackReact) {
      // Auto-mount wrapper for React panels
      wrapperCode = `
import { autoMountReactPanel, shouldAutoMount } from "@natstack/react";
import * as userModule from ${JSON.stringify(relativeUserEntry)};

if (shouldAutoMount(userModule)) {
  autoMountReactPanel(userModule);
}
`;
    } else {
      // Direct import for non-React panels (panel handles its own mounting)
      wrapperCode = `import ${JSON.stringify(relativeUserEntry)};\n`;
    }
    fs.writeFileSync(tempEntryPath, wrapperCode);

    // Get externals from manifest (packages loaded via import map / CDN)
    // Also add implicit externals based on detected dependencies
    const externals: Record<string, string> = { ...(manifest.externals ?? {}) };
    const allDependencies = { ...defaultPanelDependencies, ...(manifest.dependencies ?? {}) };
    for (const [dep, depExternals] of Object.entries(implicitExternals)) {
      if (dep in allDependencies) {
        Object.assign(externals, depExternals);
      }
    }
    const externalModules = Object.keys(externals);

    // Build with esbuild (write to disk)
    log(`Building panel...`);
    if (externalModules.length > 0) {
      log(`External modules (CDN): ${externalModules.join(", ")}`);
    }

    // Only use React dedupe plugin if panel uses @natstack/react
    const plugins: esbuild.Plugin[] = [this.createFsPlugin()];
    if (hasNatstackReact) {
      plugins.push(this.createReactDedupePlugin(sourcePath));
    }

    await esbuild.build({
      entryPoints: [tempEntryPath],
      bundle: true,
      platform: "browser",
      target: "es2022",
      outfile: bundlePath,
      sourcemap: inlineSourcemap ? "inline" : false,
      keepNames: true,      // Preserve class/function names
      format: "esm",
      absWorkingDir: sourcePath,
      nodePaths,
      plugins,
      external: externalModules,
    });

    const htmlPath = this.resolveHtmlPath(sourcePath, manifest.title, externals);
    log(`Build complete: ${bundlePath}`);

    return {
      success: true,
      manifest,
      bundlePath,
      htmlPath,
      dependencyHash,
    };
  }

  /**
   * Create the fs virtual module plugin for esbuild.
   */
  private createFsPlugin(): esbuild.Plugin {
    return {
      name: "fs-virtual-module",
      setup(build) {
        build.onResolve({ filter: /^(fs|node:fs|fs\/promises|node:fs\/promises)$/ }, (args) => {
          const runtimePath = fsModuleMap.get(args.path);
          if (!runtimePath) return null;
          return { path: runtimePath };
        });
      },
    };
  }

  /**
   * Create a plugin to deduplicate React imports.
   * This ensures all React imports (including from dependencies like react-virtuoso)
   * resolve to the same React instance in .natstack/node_modules.
   *
   * This mirrors how Next.js solves this with webpack resolve.alias.
   */
  private createReactDedupePlugin(panelPath: string): esbuild.Plugin {
    const runtimeNodeModules = path.join(this.getRuntimeDir(panelPath), "node_modules");

    return {
      name: "react-dedupe",
      setup(build) {
        // Force all react imports to resolve to the same instance
        // Use build.resolve() to properly resolve package entry points
        build.onResolve({ filter: /^react(\/.*)?$/ }, async (args) => {
          // Skip if already resolving from the target directory (prevent infinite recursion)
          if (args.resolveDir === runtimeNodeModules) {
            return null; // Let esbuild's default resolver handle it
          }
          // Re-resolve the same import but from the runtime node_modules directory
          // This forces all react imports to use the same physical package
          const result = await build.resolve(args.path, {
            kind: args.kind,
            resolveDir: runtimeNodeModules,
          });
          return result;
        });

        // Force all react-dom imports to resolve to the same instance
        build.onResolve({ filter: /^react-dom(\/.*)?$/ }, async (args) => {
          // Skip if already resolving from the target directory (prevent infinite recursion)
          if (args.resolveDir === runtimeNodeModules) {
            return null;
          }
          const result = await build.resolve(args.path, {
            kind: args.kind,
            resolveDir: runtimeNodeModules,
          });
          return result;
        });
      },
    };
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
    options?: { sourcemap?: boolean }
  ): Promise<ChildBuildResult> {
    let cleanup: (() => Promise<void>) | null = null;
    let buildLog = "";
    const canonicalPanelPath = path.resolve(panelsRoot, panelPath);

    const log = (message: string) => {
      buildLog += message + "\n";
      console.log(`[PanelBuilder] ${message}`);
    };

    try {
      // Step 1: Early cache check (fast - no git checkout needed)
      const earlyCommit = await resolveTargetCommit(panelsRoot, panelPath, version);

      if (earlyCommit) {
        const cacheKey = `panel:${canonicalPanelPath}:${earlyCommit}`;
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

      // Cache key for storing the result
      const cacheKey = `panel:${canonicalPanelPath}:${sourceCommit}`;

      // Step 3: Build from source
      onProgress?.({ state: "building", message: "Building panel...", log: buildLog });

      // Check for cached dependency hash to avoid unnecessary npm installs
      const dependencyCacheKey = `deps:${canonicalPanelPath}:${sourceCommit}`;
      const previousDependencyHash = this.getDependencyHashFromCache(dependencyCacheKey);

      const buildResult = await this.buildFromSource({
        sourcePath,
        previousDependencyHash,
        log,
        inlineSourcemap: options?.sourcemap !== false,
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

      // Step 4: Read built files for protocol serving
      const bundle = fs.readFileSync(buildResult.bundlePath!, "utf-8");
      const html = fs.readFileSync(buildResult.htmlPath!, "utf-8");

      // Check bundle size limits
      if (bundle.length > MAX_BUNDLE_SIZE) {
        const sizeMB = (bundle.length / 1024 / 1024).toFixed(2);
        const maxMB = (MAX_BUNDLE_SIZE / 1024 / 1024).toFixed(0);
        log(`Warning: Bundle size (${sizeMB}MB) exceeds limit (${maxMB}MB)`);
        return {
          success: false,
          error: `Bundle too large: ${sizeMB}MB (max: ${maxMB}MB). Consider code splitting or removing dependencies.`,
          buildLog,
        };
      }

      if (html.length > MAX_HTML_SIZE) {
        const sizeMB = (html.length / 1024 / 1024).toFixed(2);
        const maxMB = (MAX_HTML_SIZE / 1024 / 1024).toFixed(0);
        log(`Warning: HTML size (${sizeMB}MB) exceeds limit (${maxMB}MB)`);
        return {
          success: false,
          error: `HTML too large: ${sizeMB}MB (max: ${maxMB}MB)`,
          buildLog,
        };
      }

      // Check for CSS bundle
      const cssPath = buildResult.bundlePath!.replace(".js", ".css");
      let css: string | undefined;
      if (fs.existsSync(cssPath)) {
        css = fs.readFileSync(cssPath, "utf-8");
        if (css.length > MAX_CSS_SIZE) {
          const sizeMB = (css.length / 1024 / 1024).toFixed(2);
          const maxMB = (MAX_CSS_SIZE / 1024 / 1024).toFixed(0);
          log(`Warning: CSS size (${sizeMB}MB) exceeds limit (${maxMB}MB)`);
          return {
            success: false,
            error: `CSS too large: ${sizeMB}MB (max: ${maxMB}MB)`,
            buildLog,
          };
        }
      }

      log(`Build complete: ${bundle.length} bytes JS${css ? `, ${css.length} bytes CSS` : ""}`);

      // Step 5: Cache result
      const result: ChildBuildResult = {
        success: true,
        bundle,
        html,
        css,
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
   * Workers are built for isolated-vm (Node.js target) and return just a JS bundle.
   *
   * @param panelsRoot - Absolute path to workspace root
   * @param workerPath - Relative path to worker within workspace
   * @param version - Optional version specifier (branch, commit, or tag)
   * @param onProgress - Optional progress callback for UI updates
   */
  async buildWorker(
    panelsRoot: string,
    workerPath: string,
    version?: VersionSpec,
    onProgress?: (progress: BuildProgress) => void
  ): Promise<WorkerBuildResult> {
    let cleanup: (() => Promise<void>) | null = null;
    let buildLog = "";
    const canonicalWorkerPath = path.resolve(panelsRoot, workerPath);

    const log = (message: string) => {
      buildLog += message + "\n";
      console.log(`[PanelBuilder:Worker] ${message}`);
    };

    try {
      // Step 1: Early cache check (fast - no git checkout needed)
      const earlyCommit = await resolveTargetCommit(panelsRoot, workerPath, version);

      if (earlyCommit) {
        const cacheKey = `worker:${canonicalWorkerPath}:${earlyCommit}`;
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

      // Cache key for storing the result
      const cacheKey = `worker:${canonicalWorkerPath}:${sourceCommit}`;

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

      // Step 4: Install dependencies
      onProgress?.({ state: "building", message: "Installing dependencies...", log: buildLog });
      log(`Installing dependencies...`);

      const dependencyCacheKey = `deps:${canonicalWorkerPath}:${sourceCommit}`;
      const previousDependencyHash = this.getDependencyHashFromCache(dependencyCacheKey);

      const workerDependencies = this.mergeWorkerDependencies(manifest.dependencies);
      const dependencyHash = await this.installDependencies(
        sourcePath,
        workerDependencies,
        previousDependencyHash
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
      const runtimeDir = this.ensureRuntimeDir(sourcePath);
      const bundlePath = path.join(runtimeDir, "worker-bundle.js");
      const nodePaths = this.getNodeResolutionPaths(sourcePath);

      // Create wrapper entry that imports user module and sets up worker runtime
      const tempEntryPath = path.join(runtimeDir, "_worker_entry.js");
      const relativeUserEntry = path.relative(runtimeDir, entryPath);

      // Worker wrapper - imports worker-runtime to set up console/globals,
      // then imports the user module which should call rpc.expose()
      const wrapperCode = `
// Import worker runtime to set up console and globals
import "@natstack/worker-runtime";

// Import user module - it should call rpc.expose() to register methods
import ${JSON.stringify(relativeUserEntry)};
`;
      fs.writeFileSync(tempEntryPath, wrapperCode);

      // Build with esbuild for isolated-vm (Node.js-like environment)
      await esbuild.build({
        entryPoints: [tempEntryPath],
        bundle: true,
        platform: "node", // Workers run in isolated-vm which is Node-like
        target: "es2022",
        outfile: bundlePath,
        sourcemap: false,
        format: "esm",
        absWorkingDir: sourcePath,
        nodePaths,
        // No fs plugin needed - workers use @natstack/worker-runtime fs
        external: ["isomorphic-git", "isomorphic-git/http/web"],
      });

      // Read the built bundle
      const bundle = fs.readFileSync(bundlePath, "utf-8");

      // Check bundle size
      if (bundle.length > MAX_BUNDLE_SIZE) {
        const sizeMB = (bundle.length / 1024 / 1024).toFixed(2);
        const maxMB = (MAX_BUNDLE_SIZE / 1024 / 1024).toFixed(0);
        log(`Warning: Bundle size (${sizeMB}MB) exceeds limit (${maxMB}MB)`);
        if (cleanup) await cleanup();
        return {
          success: false,
          error: `Bundle too large: ${sizeMB}MB (max: ${maxMB}MB)`,
          buildLog,
        };
      }

      log(`Build complete: ${bundle.length} bytes JS`);

      // Step 6: Cache result
      const result: WorkerBuildResult = {
        success: true,
        bundle,
        manifest,
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
    }
  }
}
