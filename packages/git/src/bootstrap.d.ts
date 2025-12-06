import type { FsClient } from "isomorphic-git";
import type { GitDependency } from "./types.js";
/**
 * Configuration for panel bootstrap
 */
export interface BootstrapConfig {
    /** Git server URL */
    serverUrl: string;
    /** Auth token for git operations */
    token: string;
    /** Panel's source repo path (e.g., "panels/my-panel") */
    sourceRepo: string;
    /** Git dependencies to clone */
    gitDependencies?: Record<string, GitDependency | string>;
    /** Path in OPFS for panel source (default: "/src") */
    sourcePath?: string;
    /** Path in OPFS for dependencies (default: "/deps") */
    depsPath?: string;
    /** Author info for commits */
    author?: {
        name: string;
        email: string;
    };
}
/**
 * Result of bootstrap operation
 */
export interface BootstrapResult {
    /** Whether bootstrap succeeded */
    success: boolean;
    /** Path to panel source in OPFS */
    sourcePath: string;
    /** Current commit SHA of panel source (for cache key generation) */
    sourceCommit?: string;
    /** Map of dependency name -> path in OPFS */
    depPaths: Record<string, string>;
    /** Map of dependency name -> commit SHA (for cache key generation) */
    depCommits: Record<string, string>;
    /** Actions taken (cloned, pulled, unchanged) */
    actions: {
        source: "cloned" | "pulled" | "unchanged" | "error";
        deps: Record<string, "cloned" | "updated" | "unchanged" | "error">;
    };
    /** Error message if failed */
    error?: string;
}
/**
 * Bootstrap a panel by cloning/pulling its source and dependencies into OPFS.
 *
 * Usage:
 * ```typescript
 * import { bootstrap } from "@natstack/git";
 * import { fs } from "@zenfs/core";
 *
 * const config = await window.__natstackPanelBridge.git.getConfig();
 * const result = await bootstrap(fs, config);
 *
 * if (result.success) {
 *   // Panel source is now at result.sourcePath
 *   // Dependencies are at result.depPaths
 * }
 * ```
 */
export declare function bootstrap(fs: FsClient, config: BootstrapConfig): Promise<BootstrapResult>;
/**
 * Check if panel source exists in OPFS
 */
export declare function hasSource(fs: FsClient, sourcePath?: string): Promise<boolean>;
//# sourceMappingURL=bootstrap.d.ts.map