/**
 * Panel manifest from package.json natstack field
 */
export interface PanelManifest {
  title: string;
  entry?: string;
  dependencies?: Record<string, string>;
  injectHostThemeVariables?: boolean;
  template?: "html" | "react";
  singletonState?: boolean;
}

/**
 * Result of a successful panel build
 */
export interface PanelBuildArtifacts {
  /** The bundled JavaScript code */
  bundle: string;
  /** Source map for the bundle */
  sourceMap?: string;
  /** Generated or provided HTML */
  html: string;
  /** The panel manifest */
  manifest: PanelManifest;
  /** CSS bundle if any */
  css?: string;
}

/**
 * Build result - either success with artifacts or failure with error
 */
export type PanelBuildResult =
  | { success: true; artifacts: PanelBuildArtifacts }
  | { success: false; error: string };

/**
 * File system abstraction for reading source files
 * Can be backed by real FS (Node) or OPFS (browser)
 */
export interface BuildFileSystem {
  /** Read a file as text */
  readFile(path: string): Promise<string>;
  /** Read a file as bytes */
  readFileBytes(path: string): Promise<Uint8Array>;
  /** Check if a file exists */
  exists(path: string): Promise<boolean>;
  /** List files in a directory */
  readdir(path: string): Promise<string[]>;
  /** Check if path is a directory */
  isDirectory(path: string): Promise<boolean>;
  /** Recursively list all files matching a pattern */
  glob(pattern: string, basePath: string): Promise<string[]>;
}

/**
 * Dependency resolution configuration.
 *
 * Prebundled packages are resolved from the global registry (populated via registerPrebundledBatch).
 * Import map packages (React, Radix, etc.) are left as bare imports for browser resolution.
 * All other packages are resolved via CDN.
 */
export interface DependencyResolver {
  /** CDN base URL for npm packages (defaults to esm.sh) */
  cdnBaseUrl?: string;
}

/**
 * Build configuration options
 */
export interface BuildOptions {
  /** Base path for resolving files */
  basePath: string;
  /** File system to use for reading sources */
  fs: BuildFileSystem;
  /** How to resolve npm dependencies */
  dependencyResolver: DependencyResolver;
  /** Pre-bundled runtime modules (fs, @natstack/*) */
  runtimeModules?: Map<string, string>;
  /** Generate source maps */
  sourcemap?: boolean;
  /** Minify output */
  minify?: boolean;
}

/**
 * Version configuration - single source of truth for all pinned versions
 */
export const VERSIONS = {
  ESBUILD_WASM: "0.25.5",
  REACT: "19",
  RADIX_THEMES: "3",
  RADIX_THEMES_CSS: "3.2.1",
  ZENFS_CORE: "2.4.4",
  ZENFS_DOM: "1.2.5",
  PATH_BROWSERIFY: "1.0.1",
  UTIL: "0.12.5",
  EVENTS: "3.3.0",
  BUFFER: "6.0.3",
  PROCESS: "0.11.10",
  STREAM_BROWSERIFY: "3.0.0",
  CRYPTO_BROWSERIFY: "3.12.0",
  ISOMORPHIC_GIT: "1.35.1",
} as const;

/**
 * CDN base URLs
 */
export const CDN_BASE_URLS = {
  ESM_SH: "https://esm.sh",
  UNPKG: "https://unpkg.com",
  JSDELIVR: "https://cdn.jsdelivr.net/npm",
} as const;

/**
 * Computed CDN URLs using versions
 */
export const CDN_URLS = {
  ESBUILD_WASM: `${CDN_BASE_URLS.ESM_SH}/esbuild-wasm@${VERSIONS.ESBUILD_WASM}`,
  ESBUILD_WASM_BINARY: `${CDN_BASE_URLS.UNPKG}/esbuild-wasm@${VERSIONS.ESBUILD_WASM}/esbuild.wasm`,
  RADIX_CSS: `${CDN_BASE_URLS.JSDELIVR}/@radix-ui/themes@${VERSIONS.RADIX_THEMES_CSS}/styles.css`,
  ZENFS_CORE: `${CDN_BASE_URLS.ESM_SH}/@zenfs/core@${VERSIONS.ZENFS_CORE}`,
  ZENFS_CORE_PROMISES: `${CDN_BASE_URLS.ESM_SH}/@zenfs/core@${VERSIONS.ZENFS_CORE}/promises`,
  ZENFS_DOM: `${CDN_BASE_URLS.ESM_SH}/@zenfs/dom@${VERSIONS.ZENFS_DOM}`,
  PATH_BROWSERIFY: `${CDN_BASE_URLS.ESM_SH}/path-browserify@${VERSIONS.PATH_BROWSERIFY}`,
  UTIL: `${CDN_BASE_URLS.ESM_SH}/util@${VERSIONS.UTIL}`,
  EVENTS: `${CDN_BASE_URLS.ESM_SH}/events@${VERSIONS.EVENTS}`,
  BUFFER: `${CDN_BASE_URLS.ESM_SH}/buffer@${VERSIONS.BUFFER}`,
  PROCESS: `${CDN_BASE_URLS.ESM_SH}/process@${VERSIONS.PROCESS}`,
  STREAM_BROWSERIFY: `${CDN_BASE_URLS.ESM_SH}/stream-browserify@${VERSIONS.STREAM_BROWSERIFY}`,
  CRYPTO_BROWSERIFY: `${CDN_BASE_URLS.ESM_SH}/crypto-browserify@${VERSIONS.CRYPTO_BROWSERIFY}`,
  ISOMORPHIC_GIT: `${CDN_BASE_URLS.ESM_SH}/isomorphic-git@${VERSIONS.ISOMORPHIC_GIT}`,
} as const;

// Legacy alias for backwards compatibility
export const CDN_DEFAULTS = {
  ESM_SH: CDN_BASE_URLS.ESM_SH,
  ESBUILD_WASM_BINARY: CDN_URLS.ESBUILD_WASM_BINARY,
} as const;

/**
 * CDN fallback URLs for esbuild-wasm
 * Provides multiple CDN options in case primary fails
 */
export const ESBUILD_CDN_FALLBACKS = [
  CDN_URLS.ESBUILD_WASM, // Primary: esm.sh
  `${CDN_BASE_URLS.UNPKG}/esbuild-wasm@${VERSIONS.ESBUILD_WASM}`, // Fallback 1: unpkg
  `${CDN_BASE_URLS.JSDELIVR}/esbuild-wasm@${VERSIONS.ESBUILD_WASM}`, // Fallback 2: jsdelivr
] as const;

/**
 * Framework preset configuration
 * Defines import maps, JSX settings, and HTML templates for different frameworks
 */
export interface FrameworkPreset {
  /** Name of the preset */
  name: string;
  /** Import map entries for the framework */
  importMap: Record<string, string>;
  /** esbuild JSX mode */
  jsx: "automatic" | "transform" | "preserve";
  /** JSX import source (for automatic mode) */
  jsxImportSource?: string;
  /** Additional CSS links to include in HTML */
  cssLinks: string[];
  /** Wrapper code template - receives entry path as parameter */
  wrapperTemplate: (entryPath: string) => string;
}

/**
 * React framework preset (default)
 */
export const REACT_PRESET: FrameworkPreset = {
  name: "react",
  importMap: {
    // React core
    "react": `${CDN_BASE_URLS.ESM_SH}/react@${VERSIONS.REACT}`,
    "react-dom": `${CDN_BASE_URLS.ESM_SH}/react-dom@${VERSIONS.REACT}`,
    "react-dom/client": `${CDN_BASE_URLS.ESM_SH}/react-dom@${VERSIONS.REACT}/client`,
    "react/jsx-runtime": `${CDN_BASE_URLS.ESM_SH}/react@${VERSIONS.REACT}/jsx-runtime`,
    // UI components
    "@radix-ui/themes": `${CDN_BASE_URLS.ESM_SH}/@radix-ui/themes@${VERSIONS.RADIX_THEMES}?external=react,react-dom`,
    // File system - map Node's fs to ZenFS for OPFS support
    "fs": CDN_URLS.ZENFS_CORE,
    "fs/promises": CDN_URLS.ZENFS_CORE_PROMISES,
    "node:fs": CDN_URLS.ZENFS_CORE,
    "node:fs/promises": CDN_URLS.ZENFS_CORE_PROMISES,
    "@zenfs/core": CDN_URLS.ZENFS_CORE,
    "@zenfs/core/promises": CDN_URLS.ZENFS_CORE_PROMISES,
    "@zenfs/dom": CDN_URLS.ZENFS_DOM,
    // Git operations
    "isomorphic-git": CDN_URLS.ISOMORPHIC_GIT,
    "isomorphic-git/http/web": `${CDN_BASE_URLS.ESM_SH}/isomorphic-git@${VERSIONS.ISOMORPHIC_GIT}/http/web`,
    // Node polyfills to improve compatibility
    "path": CDN_URLS.PATH_BROWSERIFY,
    "node:path": CDN_URLS.PATH_BROWSERIFY,
    "util": CDN_URLS.UTIL,
    "node:util": CDN_URLS.UTIL,
    "events": CDN_URLS.EVENTS,
    "node:events": CDN_URLS.EVENTS,
    "buffer": CDN_URLS.BUFFER,
    "node:buffer": CDN_URLS.BUFFER,
    "process": CDN_URLS.PROCESS,
    "node:process": CDN_URLS.PROCESS,
    "stream": CDN_URLS.STREAM_BROWSERIFY,
    "node:stream": CDN_URLS.STREAM_BROWSERIFY,
    "crypto": CDN_URLS.CRYPTO_BROWSERIFY,
    "node:crypto": CDN_URLS.CRYPTO_BROWSERIFY,
  },
  jsx: "automatic",
  jsxImportSource: "react",
  cssLinks: [CDN_URLS.RADIX_CSS],
  wrapperTemplate: (entryPath: string) => `
import { configureSingle } from "@zenfs/core";
import { WebAccess } from "@zenfs/dom";
import { autoMountReactPanel, shouldAutoMount } from "@natstack/panel";

const INIT_TIMEOUT_MS = 10000;

const configureOpfs = (() => {
  let initPromise: Promise<void> | null = null;
  return (): Promise<void> => {
    if (initPromise) {
      return initPromise;
    }
    initPromise = (async () => {
      if (!("storage" in navigator) || typeof navigator.storage.getDirectory !== "function") {
        throw new Error(
          "[NatStack] OPFS is unavailable in this browser. Please use a modern browser with OPFS support."
        );
      }
      const handle = await navigator.storage.getDirectory();
      await configureSingle({ backend: WebAccess, handle });
    })();

    // Timeout protection
    return Promise.race([
      initPromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(\`[NatStack] Filesystem initialization timed out after \${INIT_TIMEOUT_MS}ms\`)), INIT_TIMEOUT_MS);
      }),
    ]);
  };
})();

const globalOpfsReady = (globalThis as Record<string, unknown>).__zenfsReady as Promise<void> | undefined;
const readyPromise = globalOpfsReady ?? configureOpfs();
(globalThis as Record<string, unknown>).__zenfsReady = readyPromise;
await readyPromise;

const userModule = await import(${JSON.stringify(entryPath)});

if (shouldAutoMount(userModule)) {
  autoMountReactPanel(userModule);
}
`,
};

/**
 * Create an import map from a preset
 */
export function createImportMap(preset: FrameworkPreset = REACT_PRESET): { imports: Record<string, string> } {
  return { imports: { ...preset.importMap } };
}

/**
 * Get the set of packages that should be resolved via import map (not bundled)
 * Automatically derived from the preset's import map keys
 */
export function getImportMapPackages(preset: FrameworkPreset = REACT_PRESET): Set<string> {
  return new Set(Object.keys(preset.importMap));
}
