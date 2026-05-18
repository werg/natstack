import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type {
  AppendPanelOpsResult,
  PanelOpsSinceResult,
  PanelSnapshotResult,
  SubmittedPanelOp,
} from "@natstack/shared/panelOpsTypes";
import type { EventService } from "@natstack/shared/eventsService";
import type { DODispatch } from "../doDispatch.js";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";

const ref = (workspaceId: string) => ({
  source: INTERNAL_DO_SOURCE,
  className: "PanelStoreDO",
  objectKey: workspaceId,
});

export function createWorkspaceSyncService(deps: {
  doDispatch: DODispatch;
  workspaceId: string;
  eventService?: Pick<EventService, "emit">;
}): ServiceDefinition {
  const dispatch = <T>(method: string, args: unknown[]) =>
    deps.doDispatch.dispatch(ref(deps.workspaceId), method, ...args) as Promise<T>;

  return {
    name: "workspace-sync",
    description: "Workspace op-log sync service",
    policy: { allowed: ["shell", "server"] },
    methods: {
      getSnapshot: { args: z.tuple([]) },
      getOpsSince: { args: z.tuple([z.number(), z.number().optional()]) },
      submitOps: { args: z.tuple([z.number(), z.array(z.record(z.unknown()))]) },
      compactOps: { args: z.tuple([z.number().optional()]) },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "getSnapshot":
          return await dispatch<PanelSnapshotResult>("getSnapshot", []);
        case "getOpsSince": {
          const [baseRevision, limit] = args as [number, number | undefined];
          return await dispatch<PanelOpsSinceResult>("getOpsSince", [baseRevision, limit]);
        }
        case "submitOps": {
          const [_baseRevision, ops] = args as [number, SubmittedPanelOp[]];
          const result = await dispatch<AppendPanelOpsResult>("appendOps", [ops, ctx.callerId]);
          if (result.acceptedOps.length > 0) {
            deps.eventService?.emit("workspace:revision-bumped", {
              workspaceId: deps.workspaceId,
              revision: result.revision,
            });
          }
          return result;
        }
        case "compactOps":
          return await dispatch("compactOps", args);
        default:
          throw new Error(`Unknown workspace-sync method: ${method}`);
      }
    },
  };
}
