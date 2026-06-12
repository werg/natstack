import type { RpcCaller } from "@natstack/rpc";
import type {
  InitPanelEntry,
  WorkspaceConfig,
  WorkspaceEntry,
} from "./types.js";

export type { InitPanelEntry, WorkspaceConfig, WorkspaceEntry } from "./types.js";

export interface WorkspaceUnitStatus {
  name: string;
  kind: "panel" | "worker" | "extension" | "app";
  source: string;
  displayName?: string;
  status: "running" | "stopped" | "error" | "pending-approval" | "building" | "available";
  version?: string;
  ev?: string | null;
  activeEv?: string | null;
  activeBundleKey?: string | null;
  activeRuntimeDepsKey?: string | null;
  lastError?: string | null;
  lastErrorDetails?: unknown;
  target?: string;
  canRollback?: boolean;
  rollbackRetentionLimit?: number;
  previousVersions?: WorkspaceAppVersionRecord[];
  health?: unknown;
  methods?: string[];
  hasFetch?: boolean;
  respawn?: {
    attempts: number;
    nextAttemptAt: number | null;
  } | null;
  inspectorUrl?: string | null;
}

export interface WorkspaceAppVersionRecord {
  version: string;
  target: string;
  capabilities: string[];
  activeEv: string | null;
  activeSha: string | null;
  activeBundleKey: string;
  activeDependencyEvs: Record<string, string>;
  activeExternalDeps: Record<string, string>;
  activeRuntimeDepsKey: string | null;
  activatedAt: number;
}

export interface WorkspaceAppVersions {
  current: WorkspaceAppVersionRecord | null;
  previous: WorkspaceAppVersionRecord[];
  retentionLimit: number;
}

export interface WorkspaceUnitLogRecord {
  workspaceId: string;
  unitName: string;
  kind: "extension" | "worker" | "panel" | "app";
  timestamp: number;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields?: Record<string, unknown>;
  source?: "stdout" | "stderr" | "ctx.log" | "console" | "lifecycle" | "system";
  /** Monotonic per-unit sequence — exact resume cursor for `sinceSeq` polling. */
  seq?: number;
}

export interface WorkspaceUnitDiagnostics {
  unit: WorkspaceUnitStatus | null;
  logs: WorkspaceUnitLogRecord[];
  errors: WorkspaceUnitLogRecord[];
  dropped: {
    entries: number;
    errors: number;
  };
  capacity: {
    entries: number;
    errors: number;
  };
}

export interface WorkspaceUnitsClient {
  list(): Promise<WorkspaceUnitStatus[]>;
  watch(): AsyncIterable<WorkspaceUnitStatus[]>;
  inspector(name: string): Promise<{ url: string } | null>;
  restart(name: string): Promise<void>;
  logs(
    name: string,
    opts?: {
      since?: number;
      sinceSeq?: number;
      level?: WorkspaceUnitLogRecord["level"];
      limit?: number;
    }
  ): Promise<WorkspaceUnitLogRecord[]>;
  diagnostics(
    name: string,
    opts?: {
      since?: number;
      sinceSeq?: number;
      level?: WorkspaceUnitLogRecord["level"];
      limit?: number;
      errorLimit?: number;
    }
  ): Promise<WorkspaceUnitDiagnostics>;
  versions(name: string): Promise<WorkspaceAppVersions>;
  rollback(name: string, opts?: { buildKey?: string }): Promise<unknown>;
}

type WorkspaceRpc = RpcCaller & {
  on?: (event: string, listener: (event: { payload: unknown }) => void) => () => void;
};

export interface WorkspaceClient {
  list(): Promise<WorkspaceEntry[]>;
  getActive(): Promise<string>;
  getActiveEntry(): Promise<WorkspaceEntry>;
  getConfig(): Promise<WorkspaceConfig>;
  create(name: string, opts?: { forkFrom?: string }): Promise<WorkspaceEntry>;
  delete(name: string): Promise<void>;
  setInitPanels(entries: InitPanelEntry[]): Promise<void>;
  setConfigField(key: string, value: unknown): Promise<void>;
  switchTo(name: string): Promise<void>;
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
      diagnostics: (name, opts) =>
        rpc.call("main", "workspace.units.diagnostics", [name, opts]),
      versions: (name) => rpc.call("main", "workspace.units.versions", [name]),
      rollback: (name, opts) => rpc.call("main", "workspace.units.rollback", [name, opts]),
    },
  };
}

function createUnitsWatch(
  rpc: WorkspaceRpc,
  listUnits: () => Promise<WorkspaceUnitStatus[]>
): AsyncIterable<WorkspaceUnitStatus[]> {
  return {
    [Symbol.asyncIterator]() {
      let closed = false;
      let pendingResolve: ((result: IteratorResult<WorkspaceUnitStatus[]>) => void) | null = null;
      const queue: WorkspaceUnitStatus[][] = [];
      const pushSnapshot = () => {
        void listUnits()
          .then((snapshot) => {
            if (closed) return;
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
        rpc.on?.("event:extensions:status", pushSnapshot),
        rpc.on?.("event:extensions:health", pushSnapshot),
        rpc.on?.("event:extensions:error", pushSnapshot),
        rpc.on?.("event:apps:available", pushSnapshot),
        rpc.on?.("event:apps:status", pushSnapshot),
        rpc.on?.("event:apps:lifecycle", pushSnapshot),
        rpc.on?.("event:workspace:unit-log", pushSnapshot),
      ].filter((unsubscribe): unsubscribe is () => void => typeof unsubscribe === "function");

      pushSnapshot();
      return {
        next(): Promise<IteratorResult<WorkspaceUnitStatus[]>> {
          if (queue.length > 0) {
            return Promise.resolve({ done: false, value: queue.shift()! });
          }
          if (closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve) => {
            pendingResolve = resolve;
          });
        },
        return(): Promise<IteratorResult<WorkspaceUnitStatus[]>> {
          closed = true;
          for (const unsubscribe of unsubscribers) unsubscribe();
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
