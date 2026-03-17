/**
 * Unified injected globals for panels and workers.
 *
 * Both environments receive the same global names.
 */
import type { GitConfig, PubSubConfig } from "../core/index.js";
/**
 * Injected globals available in both panel and worker environments.
 */
declare global {
    /** Unique identifier for this panel or worker */
    var __natstackId: string | undefined;
    /** Context ID for storage partition (format: {mode}_{type}_{identifier}) */
    var __natstackContextId: string | undefined;
    /** Environment kind: "panel" or "shell" */
    var __natstackKind: "panel" | "shell" | undefined;
    /** Parent panel ID if this is a child panel/worker */
    var __natstackParentId: string | null | undefined;
    /** Initial theme appearance */
    var __natstackInitialTheme: "light" | "dark" | undefined;
    /** Git configuration */
    var __natstackGitConfig: GitConfig | null | undefined;
    /** PubSub configuration for real-time messaging */
    var __natstackPubSubConfig: PubSubConfig | null | undefined;
    /** Environment variables */
    var __natstackEnv: Record<string, string> | undefined;
}
export interface InjectedConfig {
    id: string;
    contextId: string;
    kind: "panel" | "shell";
    parentId: string | null;
    initialTheme: "light" | "dark";
    gitConfig: GitConfig | null;
    pubsubConfig: PubSubConfig | null;
    env: Record<string, string>;
}
/**
 * Get the injected configuration from globals.
 */
export declare function getInjectedConfig(): InjectedConfig;
//# sourceMappingURL=globals.d.ts.map