/**
 * workerd RPC service — manages worker instances via WorkerdManager.
 *
 * Methods: createInstance, destroyInstance, updateInstance, listInstances,
 * getInstanceStatus, listSources, getPort, restartAll, cloneDO, destroyDO.
 */

import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { WorkerdManager } from "../workerdManager.js";
import type { BuildSystemV2 } from "../buildV2/index.js";

const limitsSchema = z.object({
  cpuMs: z.number().int().positive(),
  subrequests: z.number().int().nonnegative().optional(),
});

const createOptionsSchema = z.object({
  source: z.string(),
  contextId: z.string(),
  limits: limitsSchema,
  name: z.string().optional(),
  env: z.record(z.string()).optional(),
  bindings: z.record(z.unknown()).optional(),
  stateArgs: z.record(z.unknown()).optional(),
  ref: z.string().optional(),
});

const doRefSchema = z.object({
  source: z.string(),
  className: z.string(),
  objectKey: z.string(),
});

export function createWorkerdService(deps: {
  workerdManager: WorkerdManager;
  buildSystem: BuildSystemV2;
}): ServiceDefinition {
  return {
    name: "workerd",
    description: "Worker instance management (workerd runtime)",
    policy: { allowed: ["server", "panel", "worker"] },
    methods: {
      createInstance: { args: z.tuple([createOptionsSchema]) },
      destroyInstance: { args: z.tuple([z.string()]) },
      updateInstance: { args: z.tuple([z.string(), z.record(z.unknown())]) },
      listInstances: { args: z.tuple([]) },
      getInstanceStatus: { args: z.tuple([z.string()]) },
      listSources: { args: z.tuple([]) },
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
    handler: async (_ctx, method, args) => {
      const wm = deps.workerdManager;

      const stripToken = <T extends { token: string }>(inst: T): Omit<T, "token"> => {
        const { token: _token, ...rest } = inst;
        return rest;
      };

      switch (method) {
        case "createInstance":
          return stripToken(await wm.createInstance(args[0] as any));
        case "destroyInstance":
          return wm.destroyInstance(args[0] as string);
        case "updateInstance":
          return stripToken(await wm.updateInstance(args[0] as string, args[1] as any));
        case "listInstances":
          return wm.listInstances();
        case "getInstanceStatus":
          return wm.getInstanceStatus(args[0] as string);
        case "listSources": {
          const graph = deps.buildSystem.getGraph();
          return graph.allNodes()
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
        case "cloneDO":
          return wm.cloneDO(args[0] as any, args[1] as string);
        case "destroyDO":
          await wm.destroyDO(args[0] as any);
          return { ok: true };
        default:
          throw new Error(`Unknown workerd method: ${method}`);
      }
    },
  };
}
