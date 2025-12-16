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
import type { PanelBuildState } from "../shared/ipc/types.js";
import { createBuildWorkspace, type BuildArtifactKey } from "./build/artifacts.js";

// ===========================================================================
// Shared Build Plugins
// ===========================================================================

// FS methods exported by @natstack/runtime
// Inlined here to avoid importing from @natstack/runtime at build time
const FS_METHODS = [
  "readFile",
  "writeFile",
  "readdir",
  "stat",
  "mkdir",
  "rmdir",
  "rm",
  "unlink",
  "exists",
] as const;

/**
 * Unified fs shim plugin for both panel and worker builds.
 * Maps `import "fs"` and `import "fs/promises"` to @natstack/runtime.
 *
 * @param resolveDir - Directory to use for resolving @natstack/runtime imports
 */
function createFsShimPlugin(resolveDir: string): esbuild.Plugin {
  const methodExports = FS_METHODS.map((m) => `export const ${m} = fs.${m}.bind(fs);`).join("\n");

  return {
    name: "fs-shim",
    setup(build) {
      build.onResolve({ filter: /^(fs|node:fs|fs\/promises|node:fs\/promises)$/ }, (args) => {
        return { path: args.path, namespace: "natstack-fs-shim" };
      });

      build.onLoad({ filter: /.*/, namespace: "natstack-fs-shim" }, (args) => {
        const isPromises = args.path.includes("promises");
        const contents = `import { fs } from "@natstack/runtime";
export default fs;
${isPromises ? "" : "export const promises = fs;"}
${methodExports}
`;
        // resolveDir tells esbuild where to look for @natstack/runtime
        return { contents, loader: "js", resolveDir };
      });
    },
  };
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

// Bundle size limits (very generous to avoid disrupting normal use)
const MAX_BUNDLE_SIZE = 50 * 1024 * 1024; // 50 MB for JS bundle
const MAX_HTML_SIZE = 10 * 1024 * 1024; // 10 MB for HTML
const MAX_CSS_SIZE = 10 * 1024 * 1024; // 10 MB for CSS

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
  // @natstack/build-eval optionally uses typescript for type checking.
  // TypeScript is marked external because:
  // 1. It's ~8MB and rarely needed at runtime (type checking is optional)
  // 2. It has complex CJS internals that are better loaded from CDN
  "@natstack/build-eval": {
    "typescript": "https://esm.sh/typescript",
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
  /** Stable key used to locate shared build artifacts (deps) */
  artifactKey: BuildArtifactKey;
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
  /** Bundled JavaScript code */
  bundle?: string;
  /** HTML document */
  html?: string;
  /** CSS bundle if generated */
  css?: string;
  /** Error message on failure */
  error?: string;
  /** Hash of dependencies for caching */
  dependencyHash?: string;
}

export class PanelBuilder {
  private cacheManager = getMainCacheManager();

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

  private resolveHtml(sourcePath: string, title: string, externals?: Record<string, string>): string {
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

    return `<!DOCTYPE html>
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
  }

  private getNodeResolutionPaths(sourcePath: string, runtimeNodeModules: string): string[] {
    const localNodeModules = path.join(sourcePath, "node_modules");
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
    depsDir: string,
    dependencies: Record<string, string> | undefined,
    previousHash?: string
  ): Promise<string | undefined> {
    if (!dependencies || Object.keys(dependencies).length === 0) {
      return undefined;
    }

    fs.mkdirSync(depsDir, { recursive: true });
    const packageJsonPath = path.join(depsDir, "package.json");

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

    if (fs.existsSync(nodeModulesPath)) {
      fs.rmSync(nodeModulesPath, { recursive: true, force: true });
    }
    if (fs.existsSync(packageLockPath)) {
      fs.rmSync(packageLockPath, { recursive: true, force: true });
    }

    const arborist = new Arborist({ path: depsDir });
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
      artifactKey,
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

    const workspace = createBuildWorkspace(artifactKey);

    // Install dependencies
    try {
      log(`Installing dependencies...`);
      const runtimeDependencies = this.mergeRuntimeDependencies(manifest.dependencies);
      const dependencyHash = await this.installDependencies(
        workspace.depsDir,
        runtimeDependencies,
        previousDependencyHash
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

      // Create wrapper entry
      const tempEntryPath = path.join(workspace.buildDir, "_entry.js");
      const relativeUserEntry = path.relative(workspace.buildDir, entryPath);

      // Build wrapper code
      // Bootstrap is now started automatically by @natstack/runtime when the module loads.
      // Panel code that needs bootstrap results can await `bootstrapPromise` from the runtime.
      let wrapperCode: string;

      if (hasNatstackReact) {
        // Auto-mount wrapper for React panels
        wrapperCode = `import { autoMountReactPanel, shouldAutoMount } from "@natstack/react";
import * as userModule from ${JSON.stringify(relativeUserEntry)};

if (shouldAutoMount(userModule)) {
  autoMountReactPanel(userModule);
}
`;
      } else {
        // Direct import for non-React panels (panel handles its own mounting)
        wrapperCode = `import ${JSON.stringify(relativeUserEntry)};\n`;
      }

      // hasRepoArgs is still checked to pass git config, but bootstrap is non-blocking
      void hasRepoArgs; // Suppress unused variable warning
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

      // Use unified fs shim plugin and optionally React dedupe plugin.
      // resolveDir points at the deps dir where @natstack/runtime is installed.
      const plugins: esbuild.Plugin[] = [createFsShimPlugin(workspace.depsDir)];
      if (hasNatstackReact) {
        plugins.push(this.createReactDedupePlugin(workspace.nodeModulesDir));
      }

      await esbuild.build({
        entryPoints: [tempEntryPath],
        bundle: true,
        platform: "browser",
        target: "es2022",
        conditions: ["natstack-panel"],
        outfile: bundlePath,
        sourcemap: inlineSourcemap ? "inline" : false,
        keepNames: true, // Preserve class/function names
        format: "esm",
        absWorkingDir: sourcePath,
        nodePaths,
        plugins,
        external: externalModules,
        // Use a build-owned tsconfig. Only allowlisted user compilerOptions are merged.
        tsconfig: this.writeBuildTsconfig(workspace.buildDir, sourcePath, "panel", {
          jsx: "react-jsx",
          target: "ES2022",
          useDefineForClassFields: true,
        }),
      });

      const bundle = fs.readFileSync(bundlePath, "utf-8");
      const cssPath = bundlePath.replace(".js", ".css");
      const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf-8") : undefined;
      const html = this.resolveHtml(sourcePath, manifest.title, externals);

      log(`Build complete (${bundle.length} bytes JS)`);

      return {
        success: true,
        manifest,
        bundle,
        html,
        css,
        dependencyHash,
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
   * Create a plugin to deduplicate React imports.
   * This ensures all React imports (including from dependencies like react-virtuoso)
   * resolve to the same React instance in the build dependency node_modules.
   *
   * This mirrors how Next.js solves this with webpack resolve.alias.
   */
  private createReactDedupePlugin(runtimeNodeModules: string): esbuild.Plugin {
    const resolvedRuntimeNodeModules = path.resolve(runtimeNodeModules);

    return {
      name: "react-dedupe",
      setup(build) {
        // Force all react imports to resolve to the same instance
        // Use build.resolve() to properly resolve package entry points
        build.onResolve({ filter: /^react(\/.*)?$/ }, async (args) => {
          // Skip if already resolving from within the target tree (prevent infinite recursion)
          if (path.resolve(args.resolveDir).startsWith(resolvedRuntimeNodeModules)) {
            return null; // Let esbuild's default resolver handle it
          }
          // Re-resolve the same import but from the runtime node_modules directory
          // This forces all react imports to use the same physical package
          const result = await build.resolve(args.path, {
            kind: args.kind,
            resolveDir: resolvedRuntimeNodeModules,
          });
          return result;
        });

        // Force all react-dom imports to resolve to the same instance
        build.onResolve({ filter: /^react-dom(\/.*)?$/ }, async (args) => {
          // Skip if already resolving from within the target tree (prevent infinite recursion)
          if (path.resolve(args.resolveDir).startsWith(resolvedRuntimeNodeModules)) {
            return null;
          }
          const result = await build.resolve(args.path, {
            kind: args.kind,
            resolveDir: resolvedRuntimeNodeModules,
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
        artifactKey: { kind: "panel", canonicalPath: canonicalPanelPath, commit: sourceCommit },
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

      // Step 4: Use in-memory artifacts for protocol serving
      const bundle = buildResult.bundle!;
      const html = buildResult.html!;

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

      // Check CSS bundle size (if any)
      const css = buildResult.css;
      if (css && css.length > MAX_CSS_SIZE) {
        const sizeMB = (css.length / 1024 / 1024).toFixed(2);
        const maxMB = (MAX_CSS_SIZE / 1024 / 1024).toFixed(0);
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
    let buildWorkspace: ReturnType<typeof createBuildWorkspace> | null = null;
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

      // Build with esbuild for vm.Script (Node.js sandbox)
      // IMPORTANT: Must use "iife" format because vm.Script doesn't support ES modules.
      // ESM format outputs "import/export" statements which cause syntax errors.
      // Also cannot use externals since vm.Script has no module resolution.

      // Create a shim for the "buffer" module that uses the global Buffer
      // This is needed because isomorphic-git's dependencies (safe-buffer, sha.js)
      // use require("buffer") which fails in esbuild's IIFE format without this shim
      const bufferShimPath = path.join(buildWorkspace.buildDir, "_buffer_shim.js");
      fs.writeFileSync(
        bufferShimPath,
        `// Buffer shim for vm.Script sandbox - uses the global Buffer provided by sandbox
export const Buffer = globalThis.Buffer;
export default { Buffer: globalThis.Buffer };
`
      );

      await esbuild.build({
        entryPoints: [tempEntryPath],
        bundle: true,
        platform: "node", // Workers run in vm sandbox which is Node-like
        target: "es2022",
        conditions: ["natstack-worker"],
        outfile: bundlePath,
        sourcemap: false,
        format: "iife", // Must be iife - vm.Script doesn't support ES modules
        absWorkingDir: sourcePath,
        nodePaths,
        plugins: [createFsShimPlugin(buildWorkspace.depsDir)], // Shim fs imports to @natstack/runtime
        // Use a build-owned tsconfig. Only allowlisted user compilerOptions are merged.
        tsconfig: this.writeBuildTsconfig(buildWorkspace.buildDir, sourcePath, "worker", {
          target: "ES2022",
          useDefineForClassFields: true,
        }),
        // No externals - everything must be bundled for vm.Script
        // Alias "buffer" to our shim so require("buffer") works
        alias: {
          buffer: bufferShimPath,
        },
      });

      // Read the built bundle
      const bundle = fs.readFileSync(bundlePath, "utf-8");

      // Check bundle size
      if (bundle.length > MAX_BUNDLE_SIZE) {
        const sizeMB = (bundle.length / 1024 / 1024).toFixed(2);
        const maxMB = (MAX_BUNDLE_SIZE / 1024 / 1024).toFixed(0);
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
    }
  }
}
