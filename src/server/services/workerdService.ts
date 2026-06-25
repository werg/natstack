/**
 * workerd RPC service — manages worker instances via WorkerdManager.
 *
 * Methods: createInstance, destroyInstance, updateInstance, listInstances,
 * getInstanceStatus, listInstanceSources, getPort, restartAll, cloneDO, destroyDO.
 */

import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { DORefParam } from "@natstack/shared/userlandServiceRpc";
import type { WorkerdManager, WorkerCreateOptions } from "../workerdManager.js";
import type { BuildSystemV2 } from "../buildV2/index.js";
import type { ServiceContext, DeferredResult } from "@natstack/shared/serviceDispatcher";
import type {
  ApprovalOperationDescriptor,
  PendingCapabilityApproval,
} from "@natstack/shared/approvals";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { withCapability, type CapabilityPermissionResource } from "./capabilityPermission.js";

const createOptionsSchema = z
  .object({
    source: z.string(),
    contextId: z.string(),
    name: z.string().optional(),
    env: z.record(z.string()).optional(),
    bindings: z.record(z.unknown()).optional(),
    stateArgs: z.record(z.unknown()).optional(),
    parentId: z.string().optional(),
    parentEntityId: z.string().optional(),
    parentKind: z.enum(["panel", "worker", "do"]).optional(),
    ref: z.string().optional(),
  })
  .strict();

const updateOptionsSchema = z
  .object({
    env: z.record(z.string()).optional(),
    bindings: z.record(z.unknown()).optional(),
    stateArgs: z.record(z.unknown()).optional(),
    ref: z.string().optional(),
  })
  .strict();

const doRefSchema = z.object({
  source: z.string(),
  className: z.string(),
  objectKey: z.string(),
});

export function createWorkerdService(deps: {
  workerdManager: WorkerdManager;
  buildSystem: BuildSystemV2;
  approvalQueue?: ApprovalQueue;
  grantStore?: CapabilityGrantStore;
}): ServiceDefinition {
  // Capability gate (Layer B). Userland callers (panel/app/worker/do) need a
  // user-approved grant for sensitive worker/DO-storage mutations; server/shell/
  // extension (system-initiated) are trusted and bypass. The server approval
  // system owns scope + persistence (the user picks once/session/version) — a
  // granted caller runs inline; an ungranted agent defers the approve-then-act
  // continuation out-of-band via `withCapability`.
  const gate = <T>(
    ctx: ServiceContext,
    capability: string,
    resource: CapabilityPermissionResource,
    title: string,
    description: string,
    severity: PendingCapabilityApproval["severity"] | undefined,
    operation: ApprovalOperationDescriptor | undefined,
    action: () => Promise<T>
  ): Promise<T> | DeferredResult => {
    const kind = ctx.caller.runtime.kind;
    // Gate the direct userland drivers (panel/app/agent-do). Workers bypass: an
    // infra/spawned worker that starts a child already operates under the authority
    // that created it (avoids breaking fork + worker-spawns-worker; the deputy chain
    // is bounded by the initial grant). server/shell/extension are trusted too.
    const gated = kind === "panel" || kind === "app" || kind === "do";
    if (!gated) return action();
    if (!deps.grantStore || !deps.approvalQueue) {
      throw new Error(`${title}: approval is unavailable`);
    }
    return withCapability(
      { approvalQueue: deps.approvalQueue, grantStore: deps.grantStore },
      ctx,
      {
        capability,
        resource,
        title,
        description,
        ...(severity ? { severity } : {}),
        ...(operation ? { operation } : {}),
        deniedReason: `${title} denied`,
      },
      async (auth) => {
        if (!auth.allowed) throw new Error(auth.reason ?? `${title} denied`);
        return action();
      }
    );
  };
  // cloneDO/destroyDO are fork/storage PRIMITIVES, not userland features (only the
  // fork worker + server use them). They are not "userland-useful but sensitive", so
  // per the closure rule they are CLOSED to userland callers rather than approval-gated
  // (approval there would break fork and give confusing "clone DO storage?" UX).
  const requireInfraCaller = (ctx: ServiceContext, op: string): void => {
    const kind = ctx.caller.runtime.kind;
    if (kind === "panel" || kind === "app" || kind === "do") {
      throw new Error(`${op}: not permitted for ${kind} callers (fork/storage primitive)`);
    }
  };
  return {
    name: "workerd",
    description: "Worker instance management (workerd runtime)",
    policy: { allowed: ["server", "panel", "app", "worker", "do", "extension"] },
    methods: {
      createInstance: {
        description:
          "Create a worker instance and return its handle. Use the returned `id` for getInstanceStatus, updateInstance, and destroyInstance.",
        args: z.tuple([createOptionsSchema]),
      },
      destroyInstance: {
        description: "Destroy a worker instance by the `id` returned from workerd.createInstance.",
        args: z.tuple([z.string()]),
      },
      updateInstance: {
        description: "Update a worker instance by the `id` returned from workerd.createInstance.",
        args: z.tuple([z.string(), updateOptionsSchema]),
      },
      listInstances: { args: z.tuple([]) },
      getInstanceStatus: {
        description: "Get worker instance status by the `id` returned from workerd.createInstance.",
        args: z.tuple([z.string()]),
      },
      listInstanceSources: { args: z.tuple([]) },
      getPort: { args: z.tuple([]) },
      restartAll: { args: z.tuple([]) },
      cloneDO: {
        description: "Clone a DO's SQLite storage to a new object key",
        args: z.tuple([doRefSchema, z.string()]),
      },
      destroyDO: {
        description: "Destroy a DO's SQLite storage",
        args: z.tuple([doRefSchema]),
      },
    },
    handler: async (ctx, method, args) => {
      const wm = deps.workerdManager;

      const stripToken = <T extends { token: string }>(inst: T): Omit<T, "token"> => {
        const { token: _token, ...rest } = inst;
        return rest;
      };

      switch (method) {
        case "createInstance": {
          const opts = createOptionsSchema.parse(args[0]) as WorkerCreateOptions;
          return gate(
            ctx,
            "workerd.lifecycle",
            { type: "worker-source", label: "Worker", value: opts.source, key: opts.source },
            `Spawn ${opts.source}`,
            `Allow this code to start the worker "${opts.source}".`,
            undefined,
            {
              kind: "worker-lifecycle",
              verb: "spawn",
              object: { type: "worker-source", label: "Worker", value: opts.source },
              groupKey: `runtime-open:${opts.contextId}:${opts.source}`,
            },
            async () => stripToken(await wm.createInstance(opts))
          );
        }
        case "destroyInstance": {
          const name = args[0] as string;
          return gate(
            ctx,
            "workerd.lifecycle",
            { type: "worker-instance", label: "Worker instance", value: name, key: name },
            `Destroy ${name}`,
            `Allow this code to stop the worker instance "${name}".`,
            "severe",
            {
              kind: "worker-lifecycle",
              verb: "destroy",
              object: { type: "worker-instance", label: "Worker instance", value: name },
              groupKey: `worker-destroy:${name}`,
            },
            async () => wm.destroyInstance(name)
          );
        }
        case "updateInstance": {
          const name = args[0] as string;
          const upd = updateOptionsSchema.parse(args[1]) as Partial<WorkerCreateOptions>;
          return gate(
            ctx,
            "workerd.lifecycle",
            { type: "worker-instance", label: "Worker instance", value: name, key: name },
            `Update ${name}`,
            `Allow this code to reconfigure the worker instance "${name}".`,
            undefined,
            {
              kind: "worker-lifecycle",
              verb: "update",
              object: { type: "worker-instance", label: "Worker instance", value: name },
              groupKey: `worker-update:${name}`,
            },
            async () => stripToken(await wm.updateInstance(name, upd))
          );
        }
        case "listInstances":
          return wm.listInstances();
        case "getInstanceStatus":
          return wm.getInstanceStatus(args[0] as string);
        case "listInstanceSources": {
          const graph = deps.buildSystem.getGraph();
          return graph
            .allNodes()
            .filter((n) => n.kind === "worker")
            .map((n) => ({
              name: n.name,
              source: n.relativePath,
              title: n.manifest.title,
            }));
        }
        case "getPort":
          return wm.getPort();
        case "restartAll":
          return wm.restartAll();
        case "cloneDO": {
          requireInfraCaller(ctx, "workerd.cloneDO");
          return wm.cloneDO(doRefSchema.parse(args[0]) as DORefParam, args[1] as string);
        }
        case "destroyDO": {
          requireInfraCaller(ctx, "workerd.destroyDO");
          await wm.destroyDO(doRefSchema.parse(args[0]) as DORefParam);
          return { ok: true };
        }
        default:
          throw new Error(`Unknown workerd method: ${method}`);
      }
    },
  };
}
