/**
 * Workspace client — typed RPC wrapper for workspace management.
 * Shared by both panel and worker entry points.
 */
import type { RpcCaller } from "@natstack/rpc";
export interface WorkspaceEntry {
    name: string;
    lastOpened: number;
}
export interface InitPanelEntry {
    source: string;
    stateArgs?: Record<string, unknown>;
}
export interface WorkspaceConfig {
    id: string;
    initPanels?: InitPanelEntry[];
    git?: {
        remotes?: Record<string, Record<string, Record<string, string | null | undefined> | undefined> | undefined>;
    };
}
export interface WorkspaceUnitStatus {
    name: string;
    kind: "panel" | "worker" | "extension";
    source: string;
    displayName?: string;
    enabled?: boolean;
    status: "running" | "stopped" | "error" | "pending-approval" | "building" | "available";
    version?: string;
    ev?: string | null;
    activeEv?: string | null;
    activeBundleKey?: string | null;
    activeRuntimeDepsKey?: string | null;
    lastError?: string | null;
    health?: unknown;
    methods?: string[];
    hasFetch?: boolean;
    respawn?: {
        attempts: number;
        nextAttemptAt: number | null;
    } | null;
    inspectorUrl?: string | null;
}
export interface WorkspaceUnitLogRecord {
    workspaceId: string;
    unitName: string;
    kind: "extension" | "worker" | "panel";
    timestamp: number;
    level: "debug" | "info" | "warn" | "error";
    message: string;
    fields?: Record<string, unknown>;
    source?: "stdout" | "stderr" | "ctx.log" | "console";
}
export interface WorkspaceUnitsClient {
    list(): Promise<WorkspaceUnitStatus[]>;
    watch(): AsyncIterable<WorkspaceUnitStatus[]>;
    inspector(name: string): Promise<{
        url: string;
    } | null>;
    restart(name: string): Promise<void>;
    logs(name: string, opts?: {
        since?: number;
        level?: WorkspaceUnitLogRecord["level"];
        limit?: number;
    }): Promise<WorkspaceUnitLogRecord[]>;
}
type WorkspaceRpc = RpcCaller & {
    onEvent?: (event: string, listener: (fromId: string, payload: unknown) => void) => () => void;
};
export interface WorkspaceClient {
    /** List all workspaces sorted by last opened. */
    list(): Promise<WorkspaceEntry[]>;
    /** Get the active workspace name. */
    getActive(): Promise<string>;
    /** Get the full entry for the active workspace (name, lastOpened). */
    getActiveEntry(): Promise<WorkspaceEntry>;
    /** Read the active workspace's meta/natstack.yml config. */
    getConfig(): Promise<WorkspaceConfig>;
    /** Create a new workspace. */
    create(name: string, opts?: {
        forkFrom?: string;
    }): Promise<WorkspaceEntry>;
    /** Delete a workspace. Requires host approval for userland callers. */
    delete(name: string): Promise<void>;
    /** Set the panels created on first initialization (when panel tree is empty). */
    setInitPanels(entries: InitPanelEntry[]): Promise<void>;
    /** Set an arbitrary active-workspace config field. Requires host approval for userland callers. */
    setConfigField(key: string, value: unknown): Promise<void>;
    /** Switch to a workspace (triggers app relaunch). */
    switchTo(name: string): Promise<void>;
    /** Workspace unit status and operational controls. */
    units: WorkspaceUnitsClient;
}
export function createWorkspaceClient(rpc: WorkspaceRpc): WorkspaceClient {
    const listUnits = () => rpc.call<WorkspaceUnitStatus[]>("main", "workspace.units.list", []);
    return {
        list: () => rpc.call("main", "workspace.list", []),
        getActive: () => rpc.call("main", "workspace.getActive", []),
        getActiveEntry: () => rpc.call("main", "workspace.getActiveEntry", []),
        getConfig: () => rpc.call("main", "workspace.getConfig", []),
        create: (name, opts) => rpc.call("main", "workspace.create", [name, opts]),
        delete: (name) => rpc.call("main", "workspace.delete", [name]),
        setInitPanels: (entries) => rpc.call("main", "workspace.setInitPanels", [entries]),
        setConfigField: (key, value) => rpc.call("main", "workspace.setConfigField", [key, value]),
        switchTo: (name) => rpc.call("main", "workspace.select", [name]),
        units: {
            list: listUnits,
            watch: () => createUnitsWatch(rpc, listUnits),
            inspector: (name) => rpc.call("main", "workspace.units.inspector", [name]),
            restart: (name) => rpc.call("main", "workspace.units.restart", [name]),
            logs: (name, opts) => rpc.call("main", "workspace.units.logs", [name, opts]),
        },
    };
}
function createUnitsWatch(rpc: WorkspaceRpc, listUnits: () => Promise<WorkspaceUnitStatus[]>): AsyncIterable<WorkspaceUnitStatus[]> {
    return {
        [Symbol.asyncIterator]() {
            let closed = false;
            let pendingResolve: ((result: IteratorResult<WorkspaceUnitStatus[]>) => void) | null = null;
            const queue: WorkspaceUnitStatus[][] = [];
            const pushSnapshot = () => {
                void listUnits()
                    .then((snapshot) => {
                    if (closed)
                        return;
                    const resolve = pendingResolve;
                    if (resolve) {
                        pendingResolve = null;
                        resolve({ done: false, value: snapshot });
                        return;
                    }
                    queue.push(snapshot);
                })
                    .catch(() => {
                    // Watch is best-effort; callers can still call list() for errors.
                });
            };
            const unsubscribers = [
                rpc.onEvent?.("event:extensions:status", pushSnapshot),
                rpc.onEvent?.("event:extensions:health", pushSnapshot),
                rpc.onEvent?.("event:extensions:error", pushSnapshot),
                rpc.onEvent?.("event:workspace:unit-log", pushSnapshot),
            ].filter((unsubscribe): unsubscribe is () => void => typeof unsubscribe === "function");
            pushSnapshot();
            return {
                next(): Promise<IteratorResult<WorkspaceUnitStatus[]>> {
                    if (queue.length > 0) {
                        return Promise.resolve({ done: false, value: queue.shift()! });
                    }
                    if (closed) {
                        return Promise.resolve({ done: true, value: undefined });
                    }
                    return new Promise((resolve) => {
                        pendingResolve = resolve;
                    });
                },
                return(): Promise<IteratorResult<WorkspaceUnitStatus[]>> {
                    closed = true;
                    for (const unsubscribe of unsubscribers)
                        unsubscribe();
                    if (pendingResolve) {
                        pendingResolve({ done: true, value: undefined });
                        pendingResolve = null;
                    }
                    return Promise.resolve({ done: true, value: undefined });
                },
            };
        },
    };
}
