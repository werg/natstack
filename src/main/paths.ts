import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { app } from "electron";
import type { Workspace } from "./workspace/types.js";
import { isDev } from "./utils.js";

// Derive __dirname in a way that works in CJS builds
// esbuild should inject __dirname when bundling to CJS, but we also inject fallbacks via banner
declare const __dirname: string | undefined;
declare const __filename: string | undefined;
// These are injected by our build banner as fallbacks (see build.mjs)
declare const __injected_dirname__: string | undefined;
declare const __injected_filename__: string | undefined;

const __dirnameResolved: string = (() => {
  const DEBUG = process.env["NATSTACK_DEBUG_PATHS"] === "1";

  // Check for bundler-injected __dirname first (CJS context)
  if (typeof __dirname === "string" && __dirname) {
    if (DEBUG) console.log("[paths] Using bundler __dirname:", __dirname);
    return __dirname;
  }

  // Check for our banner-injected fallback
  if (typeof __injected_dirname__ === "string" && __injected_dirname__) {
    if (DEBUG) console.log("[paths] Using banner-injected __dirname:", __injected_dirname__);
    return __injected_dirname__;
  }

  // Check for bundler-injected __filename and derive dirname
  if (typeof __filename === "string" && __filename) {
    const dir = path.dirname(__filename);
    if (DEBUG) console.log("[paths] Derived from __filename:", dir);
    return dir;
  }

  // Check for our banner-injected __filename fallback
  if (typeof __injected_filename__ === "string" && __injected_filename__) {
    const dir = path.dirname(__injected_filename__);
    if (DEBUG) console.log("[paths] Derived from banner __filename:", dir);
    return dir;
  }

  // Final fallback: use process.cwd() and look for dist/ directory
  // This handles edge cases where bundler doesn't inject __dirname
  const cwd = process.cwd();
  const distPath = path.join(cwd, "dist");
  if (fs.existsSync(path.join(distPath, "main.cjs"))) {
    console.warn("[paths] Using fallback __dirname detection from cwd:", distPath);
    return distPath;
  }

  // Last resort - assume we're in the dist directory relative to cwd
  console.warn("[paths] Could not determine __dirname, using cwd:", cwd);
  return cwd;
})();

/**
 * Active workspace, if one is set.
 * When set, paths resolve to workspace-relative locations.
 */
let activeWorkspace: Workspace | null = null;

/**
 * Set the active workspace. Once set, getPanelCacheDirectory()
 * will return the workspace cache path.
 */
export function setActiveWorkspace(workspace: Workspace): void {
  activeWorkspace = workspace;
}

/**
 * Get the currently active workspace, if any.
 */
export function getActiveWorkspace(): Workspace | null {
  return activeWorkspace;
}

/**
 * Get the central NatStack config directory based on the platform.
 * This directory is used for app-wide configuration.
 *
 * Platform-specific paths:
 * - Linux: ~/.config/natstack
 * - macOS: ~/Library/Application Support/natstack
 * - Windows: %APPDATA%/natstack
 *
 * Falls back to OS-conventional locations derived from environment variables,
 * then finally to a temp directory if the platform directory cannot be used.
 */
export function getCentralConfigDirectory(): string {
  const ensureDir = (dir: string): string => {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const platformFallback = (): string => {
    const home = os.homedir();

    try {
      switch (process.platform) {
        case "win32": {
          const appData = process.env["APPDATA"] ?? path.join(home, "AppData", "Roaming");
          return path.join(appData, "natstack");
        }
        case "darwin":
          return path.join(home, "Library", "Application Support", "natstack");
        default: {
          const xdgConfig = process.env["XDG_CONFIG_HOME"] ?? path.join(home, ".config");
          return path.join(xdgConfig, "natstack");
        }
      }
    } catch {
      return path.join(os.tmpdir(), "natstack");
    }
  };

  try {
    // Use Electron's app.getPath('userData') which handles platform differences
    const userDataPath = app.getPath("userData");

    // Create the directory if it doesn't exist
    return ensureDir(userDataPath);
  } catch (error) {
    console.warn("Failed to get Electron userData directory, using fallback:", error);

    try {
      return ensureDir(platformFallback());
    } catch (fallbackError) {
      console.warn("Failed to create fallback config directory, using temp dir:", fallbackError);
      return ensureDir(path.join(os.tmpdir(), "natstack"));
    }
  }
}

/**
 * Get the panel cache directory.
 * If a workspace is active, returns the workspace's cache directory.
 * Otherwise returns a cache directory in the central config location.
 */
export function getPanelCacheDirectory(): string {
  // If workspace is active, use workspace cache directory
  if (activeWorkspace) {
    fs.mkdirSync(activeWorkspace.cachePath, { recursive: true });
    return activeWorkspace.cachePath;
  }

  const configDir = getCentralConfigDirectory();
  const cacheDir = path.join(configDir, "panel-cache");

  fs.mkdirSync(cacheDir, { recursive: true });

  return cacheDir;
}

/**
 * Get the NatStack state root directory.
 * - With an active workspace: <workspace>/.cache/
 * - Otherwise: platform userData directory (or platform fallback)
 */
export function getNatstackStateRootDirectory(): string {
  if (activeWorkspace) {
    fs.mkdirSync(activeWorkspace.cachePath, { recursive: true });
    return activeWorkspace.cachePath;
  }

  return getCentralConfigDirectory();
}

/**
 * Get the central build artifacts directory (never inside panel/worker source trees).
 * Always stored in the central config location, not workspace-specific.
 *
 * Location: <userData>/build-artifacts/
 * - Linux: ~/.config/natstack/build-artifacts/
 * - macOS: ~/Library/Application Support/natstack/build-artifacts/
 * - Windows: %APPDATA%/natstack/build-artifacts/
 */
export function getBuildArtifactsDirectory(): string {
  const centralConfigDir = getCentralConfigDirectory();
  const artifactsDir = path.join(centralConfigDir, "build-artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  return artifactsDir;
}

/**
 * Escape an ID for use in a filesystem path.
 * Replaces slashes with double underscores to avoid directory traversal.
 */
function escapeIdForPath(id: string): string {
  return id.replace(/\//g, "__");
}

/**
 * Get the scoped filesystem root directory for an unsafe panel or worker context.
 * Creates a directory at: <central-config>/context-scopes/<workspace-id>/<escaped-context-id>/
 *
 * This provides each context with its own isolated filesystem sandbox when unsafe=true.
 * Panels/workers sharing a context also share the same filesystem scope.
 * Panels or workers with unsafe="/" will use "/" as their scope path (full system access).
 *
 * @param workspaceId - The workspace ID from workspace config
 * @param contextId - The context ID (format: {mode}_{type}_{identifier})
 * @returns Absolute path to the scope directory
 */
export function getContextScopePath(workspaceId: string, contextId: string): string {
  const configDir = getCentralConfigDirectory();
  const escapedContextId = escapeIdForPath(contextId);
  const scopePath = path.join(configDir, "context-scopes", workspaceId, escapedContextId);

  // Create the directory if it doesn't exist
  fs.mkdirSync(scopePath, { recursive: true });

  return scopePath;
}

/**
 * Get the template builds directory.
 * This is where cached template builds are stored, keyed by spec hash.
 *
 * Location: <central-config>/template-builds/
 *
 * @returns Absolute path to the template builds directory
 */
export function getTemplateBuildDirectory(): string {
  const configDir = getCentralConfigDirectory();
  const buildsDir = path.join(configDir, "template-builds");
  fs.mkdirSync(buildsDir, { recursive: true });
  return buildsDir;
}

/**
 * Get the path for a specific template build by its spec hash.
 *
 * @param specHash - The SHA256 hash of the template spec (or first 12 chars)
 * @returns Absolute path to the template build directory
 */
export function getTemplateBuildPath(specHash: string): string {
  return path.join(getTemplateBuildDirectory(), specHash);
}

/**
 * Get the lock file path for a template build.
 *
 * @param specHash - The SHA256 hash of the template spec
 * @returns Absolute path to the lock file
 */
export function getTemplateBuildLockPath(specHash: string): string {
  return `${getTemplateBuildPath(specHash)}.lock`;
}

/**
 * Get the NatStack application root directory.
 * This is where packages/, node_modules/, and src/ exist.
 *
 * In development: The monorepo root (derived from __dirname)
 * In production: App resources location
 */
export function getAppRoot(): string {
  const DEBUG = process.env["NATSTACK_DEBUG_PATHS"] === "1";

  if (isDev()) {
    // Development: __dirnameResolved is dist/ (where main.cjs lives), walk up to monorepo root
    const root = path.resolve(__dirnameResolved, "..");

    if (DEBUG) {
      console.log("[paths] getAppRoot: __dirnameResolved =", __dirnameResolved);
      console.log("[paths] getAppRoot: computed root =", root);
    }

    // Validate the resolved root by checking for expected files
    const packageJsonPath = path.join(root, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      if (DEBUG) console.log("[paths] getAppRoot: package.json not found at", packageJsonPath);

      // Try alternative: maybe we're already at root or in a different structure
      if (fs.existsSync(path.join(__dirnameResolved, "package.json"))) {
        console.warn(`[paths] getAppRoot: Using __dirname directly as root: ${__dirnameResolved}`);
        return __dirnameResolved;
      }
      // Walk up further if needed
      const parentRoot = path.resolve(root, "..");
      if (fs.existsSync(path.join(parentRoot, "package.json"))) {
        console.warn(`[paths] getAppRoot: Using parent of expected root: ${parentRoot}`);
        return parentRoot;
      }
      console.warn(`[paths] getAppRoot: Could not validate root path, using ${root}`);
    } else if (DEBUG) {
      console.log("[paths] getAppRoot: validated root:", root);
    }

    return root;
  }
  // Production: use Electron's app path (asar root or extracted resources)
  const appPath = app.getAppPath();
  if (DEBUG) console.log("[paths] getAppRoot (production):", appPath);
  return appPath;
}

/**
 * Get the Electron resources path for accessing extraResources in production.
 * In development, returns the app root (extraResources don't exist yet).
 * In production, returns the app's resources directory.
 */
export function getResourcesPath(): string {
  if (isDev()) {
    return getAppRoot();
  }
  // In production, resources are at app.getPath('exe')/../Resources on macOS
  // or app.getAppPath()/.. on other platforms
  // process.resourcesPath is the reliable way to get this in Electron
  return process.resourcesPath;
}

/**
 * Get a path inside the .asar.unpacked directory for native modules.
 * Some modules (esbuild, better-sqlite3) need to be unpacked from ASAR for execution.
 *
 * @param relativePath - Path relative to app root (e.g., "node_modules/esbuild")
 * @returns Absolute path to the unpacked location
 */
export function getUnpackedPath(relativePath: string): string {
  if (isDev()) {
    // In development, everything is unpacked
    return path.join(getAppRoot(), relativePath);
  }
  // In production, unpacked files are at app.asar.unpacked
  const appPath = app.getAppPath();
  const unpackedPath = appPath.replace(/\.asar$/, ".asar.unpacked");
  return path.join(unpackedPath, relativePath);
}

/**
 * Get the directory containing shipped (pre-built) panels.
 * These panels are bundled with the app and don't need runtime compilation.
 *
 * In production: Returns path to shipped-panels in resources directory
 * In development: Returns null (panels are compiled at runtime)
 */
export function getShippedPanelsDir(): string | null {
  if (isDev()) {
    return null;
  }
  const shippedPath = path.join(getResourcesPath(), "shipped-panels");
  return fs.existsSync(shippedPath) ? shippedPath : null;
}

/**
 * Get the directory containing pre-built about pages.
 * These pages are bundled with the app and don't need runtime compilation.
 *
 * In production: Returns path to about-pages in resources directory
 * In development: Returns null (pages are compiled at runtime)
 */
export function getPrebuiltAboutPagesDir(): string | null {
  if (isDev()) {
    return null;
  }
  const pagesPath = path.join(getResourcesPath(), "about-pages");
  return fs.existsSync(pagesPath) ? pagesPath : null;
}

/**
 * Get the directory containing pre-built builtin workers.
 * These workers are bundled with the app and don't need runtime compilation.
 *
 * In production: Returns path to builtin-workers in resources directory
 * In development: Returns null (workers are compiled at runtime)
 */
export function getPrebuiltBuiltinWorkersDir(): string | null {
  if (isDev()) {
    return null;
  }
  const workersPath = path.join(getResourcesPath(), "builtin-workers");
  return fs.existsSync(workersPath) ? workersPath : null;
}

/**
 * Cached packages directory result.
 * undefined = not computed yet, null = doesn't exist, string = path
 */
let _packagesDirCache: string | null | undefined;

/**
 * Get the NatStack packages directory for @natstack/* types.
 * Returns null if packages directory doesn't exist (e.g., external workspace).
 * Result is cached since packages directory existence won't change at runtime.
 */
export function getPackagesDir(): string | null {
  if (_packagesDirCache === undefined) {
    const packagesPath = path.join(getAppRoot(), "packages");
    _packagesDirCache = fs.existsSync(packagesPath) ? packagesPath : null;
  }
  return _packagesDirCache;
}

/**
 * Get the app's node_modules directory for esbuild resolution.
 */
export function getAppNodeModules(): string {
  return path.join(getAppRoot(), "node_modules");
}

/**
 * Get the about-pages source directory for shell page builds.
 */
export function getAboutPagesDir(): string {
  return path.join(getAppRoot(), "src", "about-pages");
}

/**
 * Get the Partitions directory where Electron stores session data.
 * This is where partition folders are created for persist: sessions.
 *
 * Location: <userData>/Partitions/
 *
 * @returns Absolute path to the Partitions directory
 */
export function getPartitionsDirectory(): string {
  const configDir = getCentralConfigDirectory();
  const partitionsDir = path.join(configDir, "Partitions");
  fs.mkdirSync(partitionsDir, { recursive: true });
  return partitionsDir;
}

/**
 * Get the path for a specific partition by name.
 *
 * @param partitionName - The partition name (e.g., "tpl_abc123456789")
 * @returns Absolute path to the partition folder
 */
export function getPartitionPath(partitionName: string): string {
  return path.join(getPartitionsDirectory(), partitionName);
}

/**
 * Get the template partition name from a spec hash.
 * Template partitions use the prefix "tpl_" followed by 12 chars of the hash.
 *
 * @param specHash - The template spec hash
 * @returns The partition name (e.g., "tpl_abc123456789")
 */
export function getTemplatePartitionName(specHash: string): string {
  return `tpl_${specHash.slice(0, 12)}`;
}

/**
 * Get the lock file path for a partition build.
 *
 * @param partitionName - The partition name
 * @returns Absolute path to the lock file
 */
export function getPartitionBuildLockPath(partitionName: string): string {
  return path.join(getPartitionsDirectory(), `.${partitionName}.lock`);
}
