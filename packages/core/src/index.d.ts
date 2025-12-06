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
export { default as panel, type PanelAPI, type PanelTheme, type PanelRpcHandleOptions, createRadixThemeProvider, } from "./panelApi.js";
export * as Rpc from "./types.js";
export { checkQuota, logQuotaInfo, ensureSpace, formatBytes, ESTIMATED_CLONE_SIZE, ESTIMATED_BUILD_SIZE, type QuotaInfo, } from "./opfsQuota.js";
export { getPackageRegistry, resetPackageRegistry, parseSpec, isGitSpec, isNpmSpec, type PackageSpec, type PackageRegistry, } from "./packages.js";
import type { GitDependency } from "@natstack/git";
/**
 * Base spec fields common to all child types.
 */
interface ChildSpecBase {
    /** Unique name for this child (becomes part of the panel ID) */
    name: string;
    /** Environment variables to pass to the child */
    env?: Record<string, string>;
}
/**
 * Spec for creating an app panel child.
 */
export interface AppChildSpec extends ChildSpecBase {
    type: "app";
    /** Workspace-relative path to panel source */
    path: string;
    /** Branch name to track */
    branch?: string;
    /** Specific commit hash to pin to */
    commit?: string;
    /** Tag to pin to */
    tag?: string;
}
/**
 * Spec for creating a worker child.
 */
export interface WorkerChildSpec extends ChildSpecBase {
    type: "worker";
    /** Workspace-relative path to worker source */
    path: string;
    /** Branch name to track */
    branch?: string;
    /** Specific commit hash to pin to */
    commit?: string;
    /** Tag to pin to */
    tag?: string;
    /** Memory limit in MB (default: 1024) */
    memoryLimitMB?: number;
}
/**
 * Spec for creating a browser panel child.
 */
export interface BrowserChildSpec extends ChildSpecBase {
    type: "browser";
    /** Initial URL to load */
    url: string;
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
//# sourceMappingURL=index.d.ts.map