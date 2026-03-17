/**
 * Cross-platform path utilities for NatStack.
 * Works in both Node.js and browser (via pathe shim) environments.
 */
/**
 * Normalize path to use forward slashes.
 */
export declare function normalizePath(p: string): string;
/**
 * Extract filename from path.
 */
export declare function getFileName(filePath: string): string;
/**
 * Resolve a relative path against a base path.
 * This is a simple implementation for browser/panel contexts.
 * For full path resolution with .. handling, use Node.js path module.
 */
export declare function resolvePath(basePath: string, relativePath: string): string;
//# sourceMappingURL=pathUtils.d.ts.map