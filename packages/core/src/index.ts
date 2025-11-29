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
export {
  default as panel,
  type PanelAPI,
  type PanelTheme,
  type PanelRpcHandleOptions,
  createRadixThemeProvider,
} from "./panelApi.js";

// RPC types for panel-to-panel and worker communication
export * as Rpc from "./types.js";

// Export OPFS quota utilities (browser-only, but safe to import)
export {
  checkQuota,
  logQuotaInfo,
  ensureSpace,
  formatBytes,
  ESTIMATED_CLONE_SIZE,
  ESTIMATED_BUILD_SIZE,
  type QuotaInfo,
} from "./opfsQuota.js";

// =============================================================================
// Shared Types
// =============================================================================

import type { GitDependency } from "@natstack/git";

/**
 * Options for creating a child panel or worker.
 * Version specifiers are mutually exclusive; priority: commit > tag > branch
 */
export interface CreateChildOptions {
  /** Environment variables to pass to the child */
  env?: Record<string, string>;
  /** Custom ID (only used for tree children, ignored for singletons) */
  panelId?: string;
  /** Branch name to track (e.g., "develop") */
  branch?: string;
  /** Specific commit hash to pin to (e.g., "abc123...") */
  commit?: string;
  /** Tag to pin to (e.g., "v1.0.0") */
  tag?: string;

  // Worker-specific options (only apply when manifest.runtime is "worker")

  /** Memory limit in MB (default: 1024, workers only) */
  memoryLimitMB?: number;
}

/**
 * Git configuration for a panel or worker.
 */
export interface GitConfig {
  /** Git server base URL (e.g., http://localhost:63524) */
  serverUrl: string;
  /** Bearer token for authentication */
  token: string;
  /** This endpoint's source repo path (e.g., "panels/my-panel") */
  sourceRepo: string;
  /** Git dependencies from manifest (to clone into OPFS) */
  gitDependencies: Record<string, string | GitDependency>;
}

/**
 * Information about a panel or worker.
 */
export interface EndpointInfo {
  /** The endpoint's unique ID */
  id: string;
  /** Storage partition name (for isolated storage) */
  partition: string;
}

/**
 * Options for creating an RPC handle with optional validation.
 */
export interface RpcHandleOptions {
  /**
   * When enabled, validate incoming RPC event payloads with typia.
   * This surfaces schema mismatches early during development.
   */
  validateEvents?: boolean;
}
