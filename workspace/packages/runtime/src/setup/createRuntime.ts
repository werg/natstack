/**
 * Panel runtime factory — extends createBaseRuntime with panel-specific features.
 *
 * Adds: stateArgs bridge, unified panel handles, panel lifecycle methods.
 */

import type { RpcTransport } from "@natstack/rpc";
import { createBaseRuntime } from "./createBaseRuntime.js";
import type { EndpointInfo } from "../core/index.js";
import type { GatewayConfig } from "../shared/globals.js";
import { createParentHandleApi } from "../shared/handles.js";
import { createPanelRuntime } from "../shared/panelRuntime.js";
import type { RuntimeFs, ThemeAppearance } from "../types.js";
import { _applyStateArgsFromHost, _initStateArgsRuntime } from "../panel/stateArgs.js";
import { exposeAgentApi } from "../panel/agentApi.js";
import type { PanelEntityId, PanelSlotId } from "@natstack/shared/panel/ids";

export interface RuntimeDeps {
  selfId: PanelEntityId;
  createTransport: () => RpcTransport;
  entityId: PanelEntityId;
  id?: PanelEntityId;
  slotId?: PanelSlotId;
  contextId: string;
  parentId: PanelSlotId | null;
  parentEntityId?: PanelEntityId | null;
  initialTheme: ThemeAppearance;
  fs: RuntimeFs;
  setupGlobals?: () => void;
  gatewayConfig?: GatewayConfig | null;
  effectiveVersion?: string | null;
}

export function createRuntime(deps: RuntimeDeps) {
  const entityId = deps.entityId;
  const slotId = deps.slotId ?? (entityId as unknown as PanelSlotId);
  const parentRuntimeId = deps.parentEntityId ?? deps.parentId ?? null;
  const base = createBaseRuntime({ ...deps, id: entityId });
  const workers = {
    ...base.workers,
    create: (options: Parameters<typeof base.workers.create>[0]) =>
      base.workers.create({
        parentId: slotId,
        parentEntityId: entityId,
        parentKind: "panel",
        ...options,
      }),
  };
  const shell = (globalThis as any).__natstackShell ?? (globalThis as any).__natstackElectron;

  _initStateArgsRuntime(slotId, (service, method, args) => base.rpc.call(service, method, args));
  exposeAgentApi(base.expose);
  if (typeof shell?.addEventListener === "function") {
    shell.addEventListener((event: string, payload: unknown) => {
      if (event === "runtime:stateArgsChanged") {
        _applyStateArgsFromHost((payload ?? {}) as Record<string, unknown>);
      }
    });
  }

  const parentSlotId = parentRuntimeId ? (deps.parentId ?? parentRuntimeId) : null;
  const panelRuntime = createPanelRuntime({
    rpc: base.rpc,
    selfId: slotId,
    selfRpcTargetId: entityId,
    parentId: deps.parentId,
    defaultOpenParentId: slotId,
    requesterPanelId: slotId,
    effectiveVersion: deps.effectiveVersion ?? null,
    initialMetadata: parentSlotId
      ? [
          {
            id: parentSlotId,
            title: parentSlotId,
            source: parentSlotId,
            kind: "workspace",
            parentId: null,
            rpcTargetId: parentRuntimeId,
          },
        ]
      : [],
  });

  const parentHandleOrNull = parentSlotId ? panelRuntime.getPanelHandle(parentSlotId) : null;
  // The barrel feeds this resolver to the host so `createHostedRuntime` derives
  // the portable `parent`/`getParent`/`getParentWithContract`. The same handles
  // are also exposed here for the panel runtime's own (non-barrel) consumers.
  const resolveParent = () => parentHandleOrNull;
  const parentApi = createParentHandleApi(resolveParent);

  return {
    id: base.id,
    entityId: base.id,
    slotId,
    parentId: deps.parentId,
    parentEntityId: deps.parentEntityId ?? null,

    rpc: base.rpc,
    callMain: base.callMain,
    fs: base.fs,
    workers,

    resolveParent,
    parent: parentApi.parent,
    getParent: parentApi.getParent,
    getParentWithContract: parentApi.getParentWithContract,

    onConnectionError: base.onConnectionError,

    getInfo: () => shell.getInfo() as Promise<EndpointInfo>,
    focusPanel: (panelId: string) => shell.focusPanel(panelId),

    getTheme: base.getTheme,
    onThemeChange: base.onThemeChange,

    onFocus: base.onFocus,

    expose: base.expose,

    contextId: base.contextId,
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
