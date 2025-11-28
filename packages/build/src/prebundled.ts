/**
 * Registry of pre-bundled packages that are shipped with NatStack
 * These are injected at build time by the host environment
 *
 * In the browser, these will be populated by the panel runtime
 * before any in-panel builds occur.
 */

export type PrebundledRegistry = Map<string, string>;

/**
 * Global registry of pre-bundled module contents
 * Key: package name (e.g., "@natstack/panel")
 * Value: ESM bundle content as string
 */
let prebundledRegistry: PrebundledRegistry = new Map();

/**
 * Register a pre-bundled module
 * Called by the host environment to provide @natstack/* packages
 */
export function registerPrebundled(name: string, content: string): void {
  prebundledRegistry.set(name, content);
}

/**
 * Register multiple pre-bundled modules at once
 */
export function registerPrebundledBatch(
  modules: Record<string, string>
): void {
  for (const [name, content] of Object.entries(modules)) {
    prebundledRegistry.set(name, content);
  }
}

/**
 * Get the current pre-bundled registry
 */
export function getPrebundledRegistry(): PrebundledRegistry {
  return prebundledRegistry;
}

/**
 * Check if a module is pre-bundled
 */
export function isPrebundled(name: string): boolean {
  return prebundledRegistry.has(name);
}

/**
 * Get pre-bundled module content
 */
export function getPrebundled(name: string): string | undefined {
  return prebundledRegistry.get(name);
}

/**
 * Clear the registry (mainly for testing)
 */
export function clearPrebundledRegistry(): void {
  prebundledRegistry = new Map();
}

/**
 * Default packages that should be pre-bundled
 * These are resolved and bundled by the main process at startup
 */
export const DEFAULT_PREBUNDLED_PACKAGES = [
  "@natstack/panel",
  "@natstack/react",
  "@natstack/core",
  "@natstack/ai",
  "@zenfs/core",
  "@zenfs/core/promises",
  "@zenfs/dom",
  "typescript", // For in-panel type checking
] as const;

/**
 * Runtime modules that map Node.js APIs to browser equivalents
 * These are virtual modules handled specially by the build process
 */
export const RUNTIME_MODULE_MAP = {
  fs: "@natstack/build/runtime/fs",
  "fs/promises": "@natstack/build/runtime/fs-promises",
  "node:fs": "@natstack/build/runtime/fs",
  "node:fs/promises": "@natstack/build/runtime/fs-promises",
} as const;
