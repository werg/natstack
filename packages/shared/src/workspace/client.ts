/**
 * Typed workspace client — derives its RPC call surface from the shared
 * `workspaceMethods` schema table (`../serviceSchemas/workspace.ts`), the
 * single source of truth for the workspace service's wire contract. Only the
 * non-RPC conveniences (`switchTo` alias, `units.watch()` event subscription)
 * are hand-written here.
 */

import type { RpcCaller } from "@natstack/rpc";
import { createTypedServiceClient, type TypedServiceClient } from "../typedServiceClient.js";
import { workspaceMethods, type WorkspaceUnitStatus } from "../serviceSchemas/workspace.js";

export type { InitPanelEntry, WorkspaceConfig } from "./types.js";
export type {
  WorkspaceEntry,
  WorkspaceAppVersionRecord,
  WorkspaceAppVersions,
  WorkspaceUnitStatus,
  WorkspaceUnitLogRecord,
  WorkspaceUnitBuildEvent,
  WorkspaceUnitDiagnostics,
} from "../serviceSchemas/workspace.js";

type WorkspaceTypedClient = TypedServiceClient<typeof workspaceMethods>;

export type WorkspaceUnitsClient = WorkspaceTypedClient["units"] & {
  /**
   * Live unit-status snapshots: emits a fresh `units.list()` result on every
   * unit-related event (status, health, lifecycle, logs). Best-effort — fetch
   * errors are swallowed; call `list()` directly to observe them.
   */
  watch(): AsyncIterable<WorkspaceUnitStatus[]>;
};

export type WorkspaceClient = Omit<WorkspaceTypedClient, "units"> & {
  /** Alias for the wire method `workspace.select` (switch + relaunch). */
  switchTo(name: string): Promise<void>;
  units: WorkspaceUnitsClient;
};

type WorkspaceRpc = RpcCaller & {
  on?: (event: string, listener: (event: { payload: unknown }) => void) => () => void;
};

export function createWorkspaceClient(rpc: WorkspaceRpc): WorkspaceClient {
  const typed = createTypedServiceClient("workspace", workspaceMethods, (svc, method, args) =>
    rpc.call("main", `${svc}.${method}`, args)
  );
  const listUnits = () => typed.units.list();
  return {
    ...typed,
    switchTo: (name) => typed.select(name),
    units: {
      ...typed.units,
      watch: () => createUnitsWatch(rpc, listUnits),
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
