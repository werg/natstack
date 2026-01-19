import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { fileURLToPath } from "url";
import { app } from "electron";
import type { Workspace } from "./workspace/types.js";
import { isDev } from "./utils.js";

// Derive __dirname in a way that works in both CJS (bundler-injected) and ESM contexts
// In CJS builds, esbuild injects __dirname; in ESM, we derive it from import.meta.url
declare const __dirname: string | undefined;
const __dirnameResolved: string = (() => {
  // Check for bundler-injected __dirname first (CJS context)
  if (typeof __dirname === "string" && __dirname) {
    return __dirname;
  }
  // ESM context - derive from import.meta.url
  if (import.meta.url) {
    return path.dirname(fileURLToPath(import.meta.url));
  }
  throw new Error("Cannot determine __dirname: neither __dirname nor import.meta.url available");
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
 * Get the NatStack application root directory.
 * This is where packages/, node_modules/, and src/ exist.
 *
 * In development: The monorepo root (derived from __dirname)
 * In production: App resources location
 */
export function getAppRoot(): string {
  if (isDev()) {
    // Development: __dirnameResolved is dist/main, walk up to monorepo root
    return path.resolve(__dirnameResolved, "..", "..");
  }
  // Production: use Electron's app path (asar root or extracted resources)
  return app.getAppPath();
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
