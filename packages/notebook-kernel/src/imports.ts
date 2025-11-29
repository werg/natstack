/**
 * Dynamic Import Helpers
 *
 * Provides utilities for dynamically importing modules from various sources.
 */

/** Default CDN for bare module specifiers */
export const DEFAULT_CDN = "https://esm.sh";

export interface ImportModuleOptions {
  /** CDN URL to use for bare specifiers (default: esm.sh) */
  cdn?: string;
  /** Custom import function for testing */
  importFn?: (url: string) => Promise<unknown>;
}

/**
 * Check if a specifier is a bare module specifier.
 * Bare specifiers don't start with '/', './', '../', or a protocol.
 */
export function isBareSpecifier(specifier: string): boolean {
  if (specifier.startsWith("/")) return false;
  if (specifier.startsWith("./")) return false;
  if (specifier.startsWith("../")) return false;
  if (specifier.includes("://")) return false;
  // Handle data: and blob: URLs that use "scheme:" format
  if (specifier.startsWith("data:")) return false;
  if (specifier.startsWith("blob:")) return false;
  return true;
}

/**
 * Normalize a CDN URL by removing trailing slashes.
 */
function normalizeCdnUrl(cdn: string): string {
  return cdn.replace(/\/+$/, "");
}

/**
 * Resolve a specifier to an importable URL.
 *
 * @param specifier - The module specifier
 * @param cdn - CDN URL to use for bare specifiers
 * @returns The resolved URL
 */
export function resolveSpecifier(specifier: string, cdn: string = DEFAULT_CDN): string {
  if (isBareSpecifier(specifier)) {
    const normalizedCdn = normalizeCdnUrl(cdn);
    return `${normalizedCdn}/${specifier}`;
  }
  return specifier;
}

/**
 * Import a module dynamically.
 *
 * - Bare specifiers (e.g., "lodash-es") are loaded from CDN
 * - URLs are imported directly
 * - Relative paths are imported as-is (may fail without proper resolution)
 *
 * @param specifier - The module specifier
 * @param options - Import options
 */
export async function importModule(
  specifier: string,
  options: ImportModuleOptions = {}
): Promise<unknown> {
  const { cdn = DEFAULT_CDN, importFn } = options;

  const url = resolveSpecifier(specifier, cdn);

  if (importFn) {
    return importFn(url);
  }

  return import(/* webpackIgnore: true */ url);
}

/**
 * Create a bound importModule function with preset options.
 */
export function createImportModule(
  options: ImportModuleOptions = {}
): (specifier: string) => Promise<unknown> {
  return (specifier: string) => importModule(specifier, options);
}
