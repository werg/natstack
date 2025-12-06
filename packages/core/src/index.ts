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

// Package registry for dynamic imports
export {
  getPackageRegistry,
  resetPackageRegistry,
  parseSpec,
  isGitSpec,
  isNpmSpec,
  type PackageSpec,
  type PackageRegistry,
} from "./packages.js";

// =============================================================================
// Shared Types
// =============================================================================

import type { GitDependency } from "@natstack/git";

// =============================================================================
// Child Spec Types (spec-based API for createChild)
// =============================================================================

/**
 * Base fields shared by all child spec types.
 * Extended by AppChildSpec, WorkerChildSpec, and BrowserChildSpec.
 */
interface ChildSpecBase {
  /** Optional name for this child (becomes part of the panel ID). If omitted, a random ID is generated. */
  name?: string;
  /** Environment variables to pass to the child */
  env?: Record<string, string>;
  /** Source: workspace-relative path for app/worker, URL for browser */
  source: string;
}

/**
 * Common fields shared by all child spec types.
 * Used as a type constraint for generic child handling.
 * This is the intersection of all child spec types' common fields.
 */
export interface ChildSpecCommon extends ChildSpecBase {
  /** Child type discriminator */
  type: "app" | "worker" | "browser";
}

/**
 * Git-related fields for app and worker specs.
 */
interface GitVersionFields {
  /** Branch name to track */
  branch?: string;
  /** Specific commit hash to pin to */
  commit?: string;
  /** Tag to pin to */
  tag?: string;
}

/**
 * Spec for creating an app panel child.
 * Name is optional - if omitted, a random ID is generated.
 * Singleton panels (singletonState: true in manifest) cannot have a name override.
 */
export interface AppChildSpec extends ChildSpecBase, GitVersionFields {
  type: "app";
  /** Emit inline sourcemaps (default: true). Set to false to omit sourcemaps. */
  sourcemap?: boolean;
}

/**
 * Spec for creating a worker child.
 * Name is optional - if omitted, a random ID is generated.
 */
export interface WorkerChildSpec extends ChildSpecBase, GitVersionFields {
  type: "worker";
  /** Memory limit in MB (default: 1024) */
  memoryLimitMB?: number;
}

/**
 * Spec for creating a browser panel child.
 * Name is optional - if omitted, a random ID is generated.
 */
export interface BrowserChildSpec extends ChildSpecBase {
  type: "browser";
  /** Optional title (defaults to URL hostname) */
  title?: string;
}

/**
 * Union type for createChild spec parameter.
 */
export type ChildSpec = AppChildSpec | WorkerChildSpec | BrowserChildSpec;

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
