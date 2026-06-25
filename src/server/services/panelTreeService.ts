import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { PanelAccessOperation } from "@natstack/shared/panelAccessPolicy";
import { panelTreeMethods } from "@natstack/shared/serviceSchemas/panelTree";
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

export interface PanelTreeSourceValidationRequest {
  method: "create" | "navigate";
  source: string;
  options: Record<string, unknown>;
  targetPanelId?: string;
}

export interface PanelTreeServiceDeps extends PanelAccessPermissionDeps {
  bridge(request: PanelTreeBridgeRequest): Promise<unknown>;
  validateOpenPanelSource?(request: PanelTreeSourceValidationRequest): Promise<void>;
}

const METHOD_ACCESS: Partial<Record<string, PanelAccessOperation>> = {
  create: "openPanel",
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
  setCollapsed: "updatePanelState",
  setStateArgs: "stateArgs.set",
};

const READONLY_AGENT_METHODS = new Set([
  "_agent.snapshot",
  "_agent.tree",
  "_agent.state",
  "_agent.routes",
]);

function toOptionsRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

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

  async function targetForCreate(
    ctx: ServiceContext,
    args: unknown[]
  ): Promise<PanelAccessPermissionTarget> {
    const source = typeof args[0] === "string" ? args[0] : undefined;
    const options = (args[1] ?? {}) as { parentId?: string | null; contextId?: string | null };
    const requestedContextId =
      typeof options.contextId === "string" && options.contextId.length > 0
        ? options.contextId
        : undefined;
    const enrich = (target: PanelAccessPermissionTarget): PanelAccessPermissionTarget => ({
      ...target,
      ...(source ? { requestedSource: source } : {}),
      ...(requestedContextId ? { requestedContextId } : {}),
      ...(source
        ? { operationGroupKey: `runtime-open:${requestedContextId ?? ""}:${source}` }
        : {}),
    });
    if (typeof options.parentId === "string" && options.parentId.length > 0) {
      return enrich(await targetFor(ctx, options.parentId));
    }
    if (ctx.caller.runtime.kind === "panel" && deps.resolveRequesterPanel) {
      const requesterPanel = await deps.resolveRequesterPanel(ctx.caller);
      if (requesterPanel) return enrich(requesterPanel);
    }
    return enrich({ id: "workspace-root", title: "Workspace root", source: "workspace-root" });
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

  async function validatePanelSourceBeforeMutation(method: string, args: unknown[]): Promise<void> {
    if (!deps.validateOpenPanelSource) return;
    if (method === "create" && typeof args[0] === "string") {
      await deps.validateOpenPanelSource({
        method,
        source: args[0],
        options: toOptionsRecord(args[1]),
      });
      return;
    }
    if (method === "navigate" && typeof args[1] === "string") {
      await deps.validateOpenPanelSource({
        method,
        source: args[1],
        options: toOptionsRecord(args[2]),
        targetPanelId: typeof args[0] === "string" ? args[0] : undefined,
      });
    }
  }

  return {
    name: "panelTree",
    description: "Server-mediated panel tree handles and control operations",
    // Authorized chrome gets full access through requirePanelAccessPermission.
    // Runtime callers (panel/worker/do/app) may also reach this service but are
    // scoped by resource grants unless they hold the chrome capability.
    policy: { allowed: ["panel", "worker", "do", "shell", "server", "app"] },
    methods: panelTreeMethods,
    handler: async (ctx, method, args) => {
      assertAllowedAgentMethod(method, args);
      await validatePanelSourceBeforeMutation(method, args);
      const op = operationFor(method, args);
      if (op) {
        const target =
          method === "create"
            ? await targetForCreate(ctx, args)
            : await targetFor(
                ctx,
                method === "movePanel"
                  ? (args[0] as { panelId: string }).panelId
                  : (args[0] as string)
              );
        const permission = await requirePanelAccessPermission(deps, ctx, op, target);
        if (!permission.allowed) {
          throw new Error(permission.reason ?? `${method} denied for panel ${target.id}`);
        }
      }
      if (method === "expandIds") {
        const panelIds = Array.isArray(args[0]) ? (args[0] as string[]) : [];
        for (const panelId of panelIds) {
          const target = await targetFor(ctx, panelId);
          const permission = await requirePanelAccessPermission(
            deps,
            ctx,
            "updatePanelState",
            target
          );
          if (!permission.allowed) {
            throw new Error(permission.reason ?? `${method} denied for panel ${target.id}`);
          }
        }
      }

      switch (method) {
        case "ensureLoaded":
          return bridge(ctx, "ensureLoaded", args);
        case "focus":
        case "list":
        case "roots":
        case "getTreeSnapshot":
        case "getFocusedPanelId":
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
        case "getCollapsedIds":
        case "setCollapsed":
        case "expandIds":
          return bridge(ctx, method, args);
        default:
          throw new Error(`Unknown panelTree method: ${method}`);
      }
    },
  };
}
