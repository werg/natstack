import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { PanelAccessOperation } from "@natstack/shared/panelAccessPolicy";
import type {
  PanelAccessPermissionDeps,
  PanelAccessPermissionTarget,
} from "./panelAccessPermission.js";
import { requirePanelAccessPermission } from "./panelAccessPermission.js";

export interface PanelTreeBridgeRequest {
  callerId: string;
  callerKind: string;
  method: string;
  args: unknown[];
}

export interface PanelTreeServiceDeps extends PanelAccessPermissionDeps {
  bridge(request: PanelTreeBridgeRequest): Promise<unknown>;
}

const METHOD_ACCESS: Partial<Record<string, PanelAccessOperation>> = {
  reload: "reload",
  close: "close",
  archive: "archive",
  unload: "unload",
  movePanel: "movePanel",
  navigate: "replacePanel",
  navigateHistory: "replacePanel",
  takeOver: "takeOver",
  openDevTools: "openDevTools",
  rebuildPanel: "rebuildPanel",
  rebuildAndReload: "rebuildAndReload",
  updatePanelState: "updatePanelState",
  setStateArgs: "stateArgs.set",
};

const READONLY_AGENT_METHODS = new Set([
  "_agent.snapshot",
  "_agent.tree",
  "_agent.state",
  "_agent.routes",
]);

const methodSchemas = {
  list: { args: z.tuple([z.string().nullable().optional()]) },
  roots: { args: z.tuple([]) },
  create: {
    args: z.tuple([
      z.string(),
      z
        .object({
          parentId: z.string().nullable().optional(),
          name: z.string().optional(),
          focus: z.boolean().optional(),
          ref: z.string().optional(),
          stateArgs: z.record(z.unknown()).optional(),
        })
        .optional(),
    ]),
  },
  ensureLoaded: { args: z.tuple([z.string()]) },
  focus: { args: z.tuple([z.string()]) },
  getRuntimeLease: { args: z.tuple([z.string()]) },
  getStateArgs: { args: z.tuple([z.string()]) },
  setStateArgs: { args: z.tuple([z.string(), z.record(z.unknown())]) },
  reload: { args: z.tuple([z.string()]) },
  close: { args: z.tuple([z.string()]) },
  archive: { args: z.tuple([z.string()]) },
  unload: { args: z.tuple([z.string()]) },
  movePanel: {
    args: z.tuple([
      z.object({
        panelId: z.string(),
        newParentId: z.string().nullable(),
        targetPosition: z.number().int(),
      }),
    ]),
  },
  navigate: {
    args: z.tuple([
      z.string(),
      z.string(),
      z
        .object({
          ref: z.string().optional(),
          contextId: z.string().optional(),
          env: z.record(z.string()).optional(),
          stateArgs: z.record(z.unknown()).optional(),
        })
        .optional(),
    ]),
  },
  navigateHistory: {
    args: z.tuple([z.string(), z.union([z.literal(-1), z.literal(1)])]),
  },
  takeOver: { args: z.tuple([z.string()]) },
  openDevTools: { args: z.tuple([z.string(), z.enum(["detach", "right", "bottom"]).optional()]) },
  rebuildPanel: { args: z.tuple([z.string()]) },
  rebuildAndReload: { args: z.tuple([z.string()]) },
  updatePanelState: { args: z.tuple([z.string(), z.record(z.unknown())]) },
  snapshot: { args: z.tuple([z.string()]) },
  callAgent: { args: z.tuple([z.string(), z.string(), z.array(z.unknown()).optional()]) },
  metadata: { args: z.tuple([z.string()]) },
} satisfies ServiceDefinition["methods"];

export function createPanelTreeService(deps: PanelTreeServiceDeps): ServiceDefinition {
  async function bridge(ctx: ServiceContext, method: string, args: unknown[]): Promise<unknown> {
    return deps.bridge({
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
      method,
      args,
    });
  }

  async function targetFor(
    ctx: ServiceContext,
    panelId: string
  ): Promise<PanelAccessPermissionTarget> {
    const meta = (await bridge(ctx, "metadata", [panelId])) as PanelAccessPermissionTarget | null;
    if (!meta) return { id: panelId };
    return { ...meta, id: panelId };
  }

  function operationFor(method: string, args: unknown[]): PanelAccessOperation | undefined {
    if (method === "callAgent") {
      const agentMethod = args[1];
      if (agentMethod === "_agent.setMode") return "updatePanelState";
      return undefined;
    }
    return METHOD_ACCESS[method];
  }

  function assertAllowedAgentMethod(method: string, args: unknown[]): void {
    if (method !== "callAgent") return;
    const agentMethod = args[1];
    if (agentMethod === "_agent.setMode" || READONLY_AGENT_METHODS.has(String(agentMethod))) return;
    throw new Error(`Unknown panel agent method: ${String(agentMethod)}`);
  }

  return {
    name: "panelTree",
    description: "Server-mediated panel tree handles and control operations",
    // shell/shell-remote/server: trusted chrome — desktop routes via the
    // electron-main serverClient (identity "server"); mobile routes via its
    // transport (identity "shell"/"shell-remote").
    policy: { allowed: ["panel", "worker", "do", "shell", "shell-remote", "server"] },
    methods: methodSchemas,
    handler: async (ctx, method, args) => {
      assertAllowedAgentMethod(method, args);
      const op = operationFor(method, args);
      if (op) {
        const panelId =
          method === "movePanel" ? (args[0] as { panelId: string }).panelId : (args[0] as string);
        const target = await targetFor(ctx, panelId as string);
        const permission = await requirePanelAccessPermission(deps, ctx, op, target);
        if (!permission.allowed) {
          throw new Error(permission.reason ?? `${method} denied for panel ${target.id}`);
        }
      }

      switch (method) {
        case "ensureLoaded":
          return bridge(ctx, "ensureLoaded", args);
        case "focus":
        case "list":
        case "roots":
        case "create":
        case "getRuntimeLease":
        case "getStateArgs":
        case "setStateArgs":
        case "reload":
        case "close":
        case "archive":
        case "unload":
        case "movePanel":
        case "navigate":
        case "navigateHistory":
        case "takeOver":
        case "openDevTools":
        case "rebuildPanel":
        case "rebuildAndReload":
        case "updatePanelState":
        case "snapshot":
        case "callAgent":
        case "metadata":
          return bridge(ctx, method, args);
        default:
          throw new Error(`Unknown panelTree method: ${method}`);
      }
    },
  };
}
