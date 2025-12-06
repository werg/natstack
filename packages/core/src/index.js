/**
 * @natstack/core
 *
 * Shared types and utilities for NatStack panels and workers.
 * This package contains platform-agnostic code that can be used in both
 * browser (panel) and isolated-vm (worker) environments.
 *
 * NOTE: The panel API (panelApi.ts) is still exported from here for backwards
 * compatibility with @natstack/react. New code should use @natstack/panel directly.
 */
// Panel API (browser-only, for backwards compatibility)
export { default as panel, createRadixThemeProvider, } from "./panelApi.js";
// RPC types for panel-to-panel and worker communication
export * as Rpc from "./types.js";
// Export OPFS quota utilities (browser-only, but safe to import)
export { checkQuota, logQuotaInfo, ensureSpace, formatBytes, ESTIMATED_CLONE_SIZE, ESTIMATED_BUILD_SIZE, } from "./opfsQuota.js";
// Package registry for dynamic imports
export { getPackageRegistry, resetPackageRegistry, parseSpec, isGitSpec, isNpmSpec, } from "./packages.js";
//# sourceMappingURL=index.js.map