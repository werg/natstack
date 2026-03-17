/**
 * Workspace client — typed RPC wrapper for workspace management.
 * Shared by both panel and worker entry points.
 */
import type { RpcBridge } from "@natstack/rpc";
export interface WorkspaceEntry {
    name: string;
    lastOpened: number;
    gitUrl?: string;
}
export interface WorkspaceConfig {
    id: string;
    rootPanel?: string;
    initPanels?: string[];
    git?: {
        port?: number;
    };
}
export interface WorkspaceClient {
    /** List all workspaces sorted by last opened. */
    list(): Promise<WorkspaceEntry[]>;
    /** Get the active workspace name. */
    getActive(): Promise<string>;
    /** Get the full entry for the active workspace (name, lastOpened, gitUrl). */
    getActiveEntry(): Promise<WorkspaceEntry>;
    /** Read the active workspace's natstack.yml config. */
    getConfig(): Promise<WorkspaceConfig>;
    /** Create a new workspace. */
    create(name: string, opts?: {
        gitUrl?: string;
        forkFrom?: string;
    }): Promise<WorkspaceEntry>;
    /** Set the default panel opened when the workspace loads. Pass null to clear. */
    setRootPanel(source: string | null): Promise<void>;
    /** Set the panels created on first initialization (when panel tree is empty). */
    setInitPanels(sources: string[]): Promise<void>;
    /** Switch to a workspace (triggers app relaunch). */
    switchTo(name: string): Promise<void>;
}
export declare function createWorkspaceClient(rpc: RpcBridge): WorkspaceClient;
//# sourceMappingURL=workspace.d.ts.map