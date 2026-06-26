/**
 * Worker/DO orchestration and state inspection helpers.
 */
import { contextId, createDurableObjectServiceClient, rpc, workspace } from "@workspace/runtime";
import type { WorkspaceUnitStatus } from "@workspace/runtime";

export type UnitDiagnostics = Awaited<ReturnType<typeof workspace.units.diagnostics>>;
import { activeTestContext } from "./run.js";
import { waitFor } from "./panels.js";

export interface CompactUnitStatus {
  name: string;
  kind: WorkspaceUnitStatus["kind"];
  source: string;
  status: WorkspaceUnitStatus["status"];
  version?: string;
  lastError?: string | null;
}

function compact(unit: WorkspaceUnitStatus): CompactUnitStatus {
  return {
    name: unit.name,
    kind: unit.kind,
    source: unit.source,
    status: unit.status,
    version: unit.version,
    lastError: unit.lastError ?? undefined,
  };
}

/** All workspace units (panels/workers/extensions/apps) in compact form. */
export async function listUnits(filter?: {
  kind?: CompactUnitStatus["kind"];
  status?: CompactUnitStatus["status"];
}): Promise<CompactUnitStatus[]> {
  const units = await workspace.units.list();
  return units
    .filter((unit) => !filter?.kind || unit.kind === filter.kind)
    .filter((unit) => !filter?.status || unit.status === filter.status)
    .map(compact);
}

/** Logs + errors for a unit since a timestamp, via RuntimeDiagnosticsStore. */
export async function unitDiagnostics(
  name: string,
  opts?: { since?: number; level?: "debug" | "info" | "warn" | "error"; limit?: number }
): Promise<UnitDiagnostics> {
  return workspace.units.diagnostics(name, opts);
}

/** Call a method on a Durable Object-backed service. */
export async function callDO<T = unknown>(
  query: string,
  method: string,
  args: unknown[] = [],
  opts?: { objectKey?: string | null }
): Promise<T> {
  const client = createDurableObjectServiceClient(query, opts?.objectKey ?? null);
  return (await client.call(method, ...args)) as T;
}

/** Ensure a worker instance exists for `source` and is running; auto-watch it. */
export async function ensureWorker(
  source: string,
  opts?: {
    name?: string;
    env?: Record<string, string>;
    stateArgs?: Record<string, unknown>;
    timeoutMs?: number;
  }
): Promise<CompactUnitStatus> {
  const name = opts?.name ?? source.split("/").pop() ?? source;
  // Worker status is source-keyed: workspace.units.list reports one row per
  // worker source, whose status reflects the running instance. A graph worker
  // always has a row, so "needs launch" means "not currently live".
  const find = async (): Promise<WorkspaceUnitStatus | null> => {
    const units = await workspace.units.list();
    return units.find((unit) => unit.kind === "worker" && unit.source === source) ?? null;
  };
  const existing = await find().catch(() => null);
  const live = existing?.status === "running" || existing?.status === "building";
  if (!live) {
    await rpc.call("main", "runtime.createEntity", [
      {
        kind: "worker",
        source,
        key: name,
        contextId,
        env: opts?.env,
        stateArgs: opts?.stateArgs,
      },
    ]);
  }
  const running = await waitFor(
    async () => {
      const status = await find();
      if (status?.status === "error") {
        throw new Error(`worker ${name} entered error state`);
      }
      return status?.status === "running" ? status : undefined;
    },
    { timeoutMs: opts?.timeoutMs ?? 60_000, label: `worker ${name} running` }
  );
  activeTestContext()?.supervisor.watchUnit(name);
  return {
    name: running.name,
    kind: "worker",
    source: running.source,
    status: "running",
  };
}

export async function restartUnit(name: string): Promise<void> {
  await workspace.units.restart(name);
}
