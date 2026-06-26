/**
 * workerd RPC service — fork/storage DO primitives (cloneDO, destroyDO).
 *
 * Worker instance lifecycle is owned by `runtime.createEntity`/`retireEntity`;
 * the parallel `workerd.*` lifecycle surface was deleted. Only the two infra
 * DO-storage primitives remain here, closed to userland callers.
 */

import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { DORefParam } from "@natstack/shared/userlandServiceRpc";
import type { WorkerdManager } from "../workerdManager.js";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";

const doRefSchema = z.object({
  source: z.string(),
  className: z.string(),
  objectKey: z.string(),
});

export function createWorkerdService(deps: { workerdManager: WorkerdManager }): ServiceDefinition {
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
    description: "Worker DO-storage primitives (clone/destroy)",
    policy: { allowed: ["server", "panel", "app", "worker", "do", "extension"] },
    methods: {
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

      switch (method) {
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
