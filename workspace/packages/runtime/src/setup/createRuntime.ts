/**
 * Panel runtime factory — extends createBaseRuntime with panel-specific features.
 *
 * Adds: stateArgs bridge, unified panel handles, panel lifecycle methods.
 */

import type { RpcTransport } from "@natstack/rpc";
import { createBaseRuntime, type BaseRuntimeDeps } from "./createBaseRuntime.js";
import {
  type PanelContract,
  type PanelHandle,
  type PanelHandleFromContract,
  type EndpointInfo,
  type GitConfig,
  type Rpc,
} from "../core/index.js";
import type { GatewayConfig } from "../shared/globals.js";
import {
  createNoPanelHandle,
  createPanelHandle,
  type PanelHandleHostOps,
  type PanelHandleMetadata,
} from "../shared/handles.js";
import { createCdpAutomation } from "../panel/cdpAutomation.js";
import type { RuntimeFs, ThemeAppearance } from "../types.js";
import { _applyStateArgsFromHost, _initStateArgsRuntime } from "../panel/stateArgs.js";
import { exposeAgentApi, registerAgentApi } from "../panel/agentApi.js";
import type { PanelEntityId, PanelSlotId } from "@natstack/shared/panel/ids";
import type { PanelLifecycleResult } from "@natstack/shared/types";

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
  gitConfig?: GitConfig | null;
}

interface PanelTreeItem {
  id?: string;
  panelId?: string;
  title?: string;
  source?: string;
  kind?: "workspace" | "browser";
  parentId?: string | null;
  contextId?: string | null;
  runtimeEntityId?: string | null;
  effectiveVersion?: string | null;
  ref?: string | null;
}

export function createRuntime(deps: RuntimeDeps) {
  const entityId = deps.entityId;
  const slotId = deps.slotId ?? (entityId as unknown as PanelSlotId);
  const parentRuntimeId = deps.parentEntityId ?? deps.parentId;
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
  registerAgentApi(shell);
  exposeAgentApi(base.expose);
  if (typeof shell?.addEventListener === "function") {
    shell.addEventListener((event: string, payload: unknown) => {
      if (event === "runtime:stateArgsChanged") {
        _applyStateArgsFromHost((payload ?? {}) as Record<string, unknown>);
      }
    });
  }

  const panelCall = <T>(method: string, args: unknown[]) =>
    base.rpc.call<T>("main", `panelTree.${method}`, args);
  const itemToMetadata = (item: PanelTreeItem): PanelHandleMetadata => {
    const id = item.panelId ?? item.id ?? "";
    return {
      id,
      title: item.title ?? id,
      source: item.source ?? id,
      kind: item.kind ?? (item.source?.startsWith("browser:") ? "browser" : "workspace"),
      parentId: item.parentId ?? null,
      contextId: item.contextId ?? null,
      rpcTargetId: item.runtimeEntityId ?? id,
      effectiveVersion: item.effectiveVersion ?? null,
      ref: item.ref ?? null,
    };
  };
  const metadataForId = (id: string): PanelHandleMetadata => ({
    id,
    title: id,
    source: id,
    kind: "workspace",
    parentId: null,
    contextId: null,
    rpcTargetId: id,
    effectiveVersion: null,
  });
  const hydrateRuntimeHandle = (metadata: PanelHandleMetadata): PanelHandle =>
    createPanelHandle({
      rpc: base.rpc,
      metadata,
      cdp: createCdpAutomation(base.rpc, metadata.id, {
        kind: metadata.kind,
        requesterPanelId: slotId,
      }),
      ops: panelHandleOps,
    });
  const panelHandleOps: PanelHandleHostOps = {
    refresh: async (id) => {
      const meta = await panelCall<PanelTreeItem | null>("metadata", [id]);
      return meta ? itemToMetadata(meta) : metadataForId(id);
    },
    children: async (id) => {
      const children = await panelCall<PanelTreeItem[]>("list", [id]);
      return children.map((item) => hydrateRuntimeHandle(itemToMetadata(item)));
    },
    parent: (_id, parentId) => (parentId ? hydrateRuntimeHandle(metadataForId(parentId)) : null),
    ensureLoaded: (id) => panelCall("ensureLoaded", [id]),
    isLoaded: async (id) => {
      try {
        const lease = await panelCall<{ leased?: boolean } | null>("getRuntimeLease", [id]);
        return Boolean(lease?.leased);
      } catch {
        return false;
      }
    },
    reload: (id) => panelCall<PanelLifecycleResult>("reload", [id]),
    close: (id) => panelCall<PanelLifecycleResult>("close", [id]),
    archive: (id) => panelCall("archive", [id]),
    unload: (id) => panelCall<PanelLifecycleResult>("unload", [id]),
    movePanel: (id, newParentId, targetPosition) =>
      panelCall("movePanel", [{ panelId: id, newParentId, targetPosition }]),
    takeOver: (id) => panelCall("takeOver", [id]),
    openDevTools: (id, mode) => panelCall("openDevTools", [id, mode]),
    rebuildPanel: (id) => panelCall<PanelLifecycleResult>("rebuildPanel", [id]),
    rebuildAndReload: (id) => panelCall<PanelLifecycleResult>("rebuildAndReload", [id]),
    updatePanelState: (id, state) => panelCall("updatePanelState", [id, state]),
    focus: (id) => panelCall("focus", [id]),
    stateArgs: {
      get: (id) => panelCall("getStateArgs", [id]),
      set: (id, updates) => panelCall("setStateArgs", [id, updates]),
    },
    snapshot: (id) => panelCall("snapshot", [id]),
    callAgent: (id, method, args) => panelCall("callAgent", [id, method, args]),
  };

  const parentHandleOrNull = parentRuntimeId
    ? (() => {
        const parentSlotId = deps.parentId ?? parentRuntimeId;
        return createPanelHandle({
          rpc: base.rpc,
          metadata: {
            id: parentSlotId,
            title: parentSlotId,
            source: parentSlotId,
            kind: "workspace",
            parentId: null,
            rpcTargetId: parentRuntimeId,
          },
          cdp: createCdpAutomation(base.rpc, parentSlotId, {
            kind: "workspace",
            requesterPanelId: slotId,
          }),
          ops: panelHandleOps,
        });
      })()
    : null;
  const parent: PanelHandle = parentHandleOrNull ?? createNoPanelHandle();

  const getParent = <
    T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
    E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
    EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap,
  >(): PanelHandle<T, E, EmitE> | null => {
    return parentHandleOrNull as PanelHandle<T, E, EmitE> | null;
  };

  const getParentWithContract = <C extends PanelContract>(
    contract: C
  ): PanelHandleFromContract<C, "parent"> | null => {
    return getParent()?.withContract(contract, "parent") ?? null;
  };

  return {
    id: base.id,
    entityId: base.id,
    slotId,
    parentId: deps.parentId,
    parentEntityId: deps.parentEntityId ?? null,

    rpc: base.rpc,
    fs: base.fs,
    workers,

    parent,
    getParent,
    getParentWithContract,

    onConnectionError: base.onConnectionError,

    getInfo: () => shell.getInfo() as Promise<EndpointInfo>,
    focusPanel: (panelId: string) => shell.focusPanel(panelId),
    getWorkspaceTree: base.getWorkspaceTree,
    listBranches: base.listBranches,
    listCommits: base.listCommits,

    getTheme: base.getTheme,
    onThemeChange: base.onThemeChange,

    onFocus: base.onFocus,

    expose: base.expose,

    gitConfig: base.gitConfig,
    contextId: base.contextId,
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
