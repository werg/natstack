/**
 * Base runtime factory — transport-agnostic core shared by panels and workers.
 *
 * Provides: rpc, db, fs, callMain, workspace tree/branches/commits,
 * connection error handling, method exposure, theme, focus.
 *
 * Does NOT include: stateArgs, parent handles, panel-specific features.
 */
import { type RpcBridge, type RpcTransport } from "@natstack/rpc";
import type { GitConfig, PubSubConfig, WorkspaceTree, BranchInfo, CommitInfo } from "../core/index.js";
import type { RuntimeFs, ThemeAppearance } from "../types.js";
export interface BaseRuntimeDeps {
    selfId: string;
    /** Primary transport (IPC for panels, WS for workers) */
    createTransport: () => RpcTransport;
    /** Optional secondary transport for routing bridge (panels use this for server) */
    createServerTransport?: () => RpcTransport | null;
    id: string;
    contextId: string;
    initialTheme: ThemeAppearance;
    fs: RuntimeFs;
    setupGlobals?: () => void;
    gitConfig?: GitConfig | null;
    pubsubConfig?: PubSubConfig | null;
}
export declare function createBaseRuntime(deps: BaseRuntimeDeps): {
    id: string;
    rpc: RpcBridge;
    db: import("@natstack/types").DbClient;
    fs: RuntimeFs;
    workers: import("../shared/workerd.js").WorkerdClient;
    callMain: <T>(method: string, ...args: unknown[]) => Promise<T>;
    onConnectionError: (callback: (error: {
        code: number;
        reason: string;
        source?: "electron" | "server";
    }) => void) => (() => void);
    getWorkspaceTree: () => Promise<WorkspaceTree>;
    listBranches: (repoPath: string) => Promise<BranchInfo[]>;
    listCommits: (repoPath: string, ref?: string, limit?: number) => Promise<CommitInfo[]>;
    getTheme: () => ThemeAppearance;
    onThemeChange: (callback: (theme: ThemeAppearance) => void) => () => void;
    onFocus: (callback: () => void) => () => void;
    exposeMethod: <TArgs extends unknown[], TReturn>(method: string, handler: (...args: TArgs) => TReturn | Promise<TReturn>) => void;
    gitConfig: GitConfig | null;
    pubsubConfig: PubSubConfig | null;
    contextId: string;
    destroy: () => void;
};
export type BaseRuntime = ReturnType<typeof createBaseRuntime>;
//# sourceMappingURL=createBaseRuntime.d.ts.map