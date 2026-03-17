/**
 * Panel runtime factory — extends createBaseRuntime with panel-specific features.
 *
 * Adds: stateArgs bridge, parent handles, panel lifecycle methods.
 */
import type { RpcTransport } from "@natstack/rpc";
import { type PanelContract, type EndpointInfo, type GitConfig, type PubSubConfig, type Rpc } from "../core/index.js";
import type { ParentHandle, ParentHandleFromContract } from "../core/index.js";
import type { RuntimeFs, ThemeAppearance } from "../types.js";
export interface RuntimeDeps {
    selfId: string;
    createTransport: () => RpcTransport;
    createServerTransport?: () => RpcTransport | null;
    id: string;
    contextId: string;
    parentId: string | null;
    initialTheme: ThemeAppearance;
    fs: RuntimeFs;
    setupGlobals?: () => void;
    gitConfig?: GitConfig | null;
    pubsubConfig?: PubSubConfig | null;
}
export declare function createRuntime(deps: RuntimeDeps): {
    id: string;
    parentId: string | null;
    rpc: import("@natstack/rpc").RpcBridge;
    db: import("@natstack/types").DbClient;
    fs: RuntimeFs;
    workers: import("../shared/workerd.js").WorkerdClient;
    parent: ParentHandle<Rpc.ExposedMethods, Rpc.RpcEventMap, Rpc.RpcEventMap>;
    getParent: <T extends Rpc.ExposedMethods = Rpc.ExposedMethods, E extends Rpc.RpcEventMap = Rpc.RpcEventMap, EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap>() => ParentHandle<T, E, EmitE> | null;
    getParentWithContract: <C extends PanelContract>(contract: C) => ParentHandleFromContract<C> | null;
    onConnectionError: (callback: (error: {
        code: number;
        reason: string;
        source?: "electron" | "server";
    }) => void) => (() => void);
    getInfo: () => Promise<EndpointInfo>;
    closeSelf: () => Promise<void>;
    focusPanel: (panelId: string) => Promise<void>;
    getWorkspaceTree: () => Promise<import("../core/types.js").WorkspaceTree>;
    listBranches: (repoPath: string) => Promise<import("../core/types.js").BranchInfo[]>;
    listCommits: (repoPath: string, ref?: string, limit?: number) => Promise<import("../core/types.js").CommitInfo[]>;
    getTheme: () => ThemeAppearance;
    onThemeChange: (callback: (theme: ThemeAppearance) => void) => () => void;
    onFocus: (callback: () => void) => () => void;
    exposeMethod: <TArgs extends unknown[], TReturn>(method: string, handler: (...args: TArgs) => TReturn | Promise<TReturn>) => void;
    gitConfig: GitConfig | null;
    pubsubConfig: PubSubConfig | null;
    contextId: string;
};
export type Runtime = ReturnType<typeof createRuntime>;
//# sourceMappingURL=createRuntime.d.ts.map