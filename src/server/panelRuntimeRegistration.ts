/**
 * Panel runtime registration for shell-owned panel state.
 *
 * The server still owns shared services like builds, workspace metadata,
 * filesystem access, and token minting, but panel trees no longer live here.
 */

import { randomUUID } from "crypto";
import { z } from "zod";
import type { ServiceContainer } from "@natstack/shared/serviceContainer";
import {
  createVerifiedCaller,
  type ServiceContext,
  type ServiceDispatcher,
} from "@natstack/shared/serviceDispatcher";
import type { Workspace, WorkspaceConfig } from "@natstack/shared/workspace/types";
import type { CentralDataManager } from "@natstack/shared/centralData";
import type { HostConfig } from "@natstack/shared/hostConfig";
import type {
  HostTarget,
  HostTargetCandidate,
  HostTargetSelection,
  HostTargetSelectionInput,
} from "@natstack/shared/hostTargets";
import type { ApprovalQueue } from "./services/approvalQueue.js";
import { assertPresent } from "../lintHelpers";
import { PanelRegistry } from "@natstack/shared/panelRegistry";
import {
  getCurrentSnapshot,
  getPanelContextId,
  getPanelSource,
  getPanelStateArgs,
} from "@natstack/shared/panel/accessors";
import { asPanelSlotId } from "@natstack/shared/panel/ids";
import { PanelManager } from "@natstack/shared/shell/panelManager";
import type {
  RuntimeClient,
  SlotCreateInput,
  SlotHistoryEntryInput,
  SlotHistoryRow,
  SlotRow,
  WorkspaceStateClient,
} from "@natstack/shared/shell/workspaceStateClient";
import type {
  EntityRecord,
  RuntimeEntityCreateSpec,
  RuntimeEntityHandle,
} from "@natstack/shared/runtime/entitySpec";
import type { PanelNavigationState } from "@natstack/shared/types";
import type {
  IndexablePanel,
  PanelSearchIndex,
  PanelSearchResult,
} from "@natstack/shared/panelSearchTypes";

type PanelAccessMetadata =
  import("./services/panelAccessPermission.js").PanelAccessPermissionTarget;

async function waitForCdpTargetRegistered(
  bridge: import("./cdpBridge.js").CdpBridge,
  panelId: string,
  hostConnectionId?: string,
  timeoutMs = 5_000
): Promise<void> {
  const isReady = () =>
    hostConnectionId
      ? bridge.isTargetRegisteredForHost(panelId, hostConnectionId)
      : bridge.isTargetRegistered(panelId);
  if (isReady()) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (isReady()) return;
  }
  throw new Error(`CDP endpoint unavailable for panel: ${panelId}`);
}

function normalizePanelNavigationState(input: Record<string, unknown>): PanelNavigationState {
  return {
    ...(typeof input["url"] === "string" ? { url: input["url"] } : {}),
    ...(typeof input["pageTitle"] === "string" ? { pageTitle: input["pageTitle"] } : {}),
    ...(typeof input["isLoading"] === "boolean" ? { isLoading: input["isLoading"] } : {}),
    ...(typeof input["canGoBack"] === "boolean" ? { canGoBack: input["canGoBack"] } : {}),
    ...(typeof input["canGoForward"] === "boolean" ? { canGoForward: input["canGoForward"] } : {}),
  };
}

export function cdpDefaultHostAssignmentError(
  panelId: string,
  reason: "already_held" | "mobile_held" | "no_default_cdp_host"
): Error | null {
  if (reason === "mobile_held") {
    return Object.assign(
      new Error(`CDP is unavailable while panel ${panelId} is held by a non-CDP host`),
      { code: "cdp_unavailable_mobile_held" }
    );
  }
  if (reason === "no_default_cdp_host") {
    return Object.assign(new Error(`No CDP-capable host is available for panel: ${panelId}`), {
      code: "cdp_no_default_host",
    });
  }
  return null;
}

export function panelHostCommandAssignmentError(
  panelId: string,
  reason: "already_held" | "mobile_held" | "no_default_cdp_host"
): Error | null {
  if (reason === "mobile_held") {
    return Object.assign(new Error(`Panel ${panelId} is held by a non-CDP host`), {
      code: "panel_host_command_unavailable_mobile_held",
    });
  }
  if (reason === "no_default_cdp_host") {
    return Object.assign(new Error(`No CDP-capable host is available for panel: ${panelId}`), {
      code: "panel_host_command_no_default_cdp_host",
    });
  }
  return null;
}

export function resolveImplicitCreateParentId(input: {
  explicitParentId?: string | null;
  callerId: string;
  callerKind: string;
  getCallerLeaseSlotId?: (callerId: string) => string | undefined;
  hasPanel: (panelId: string) => boolean;
}): ReturnType<typeof asPanelSlotId> | undefined {
  if (typeof input.explicitParentId === "string") {
    return asPanelSlotId(input.explicitParentId);
  }
  const callerSlotId =
    input.callerKind === "panel"
      ? (input.getCallerLeaseSlotId?.(input.callerId) ?? input.callerId)
      : input.callerId;
  return input.hasPanel(callerSlotId) ? asPanelSlotId(callerSlotId) : undefined;
}

async function createServerPanelTreeBridge(
  deps: CommonDeps
): Promise<
  (request: import("./services/panelTreeService.js").PanelTreeBridgeRequest) => Promise<unknown>
> {
  const registry = new PanelRegistry({});
  const serverCtx: ServiceContext = { caller: createVerifiedCaller("server", "server") };
  const call = <T>(service: string, method: string, args: unknown[]) =>
    deps.dispatcher.dispatch(serverCtx, service, method, args) as Promise<T>;
  const workspaceState: WorkspaceStateClient = {
    listSlots: () => call<SlotRow[]>("workspace-state", "slot.list", []),
    getSlot: (slotId) => call<SlotRow | null>("workspace-state", "slot.get", [slotId]),
    getSlotHistory: (slotId) => call<SlotHistoryRow[]>("workspace-state", "slot.history", [slotId]),
    resolveActiveEntity: (id) =>
      call<EntityRecord | null>("workspace-state", "entity.resolveActive", [id]),
    createSlot: (input: SlotCreateInput) =>
      call<undefined>("workspace-state", "slot.create", [input]),
    appendSlotHistory: (slotId, entry: SlotHistoryEntryInput) =>
      call<number>("workspace-state", "slot.appendHistory", [slotId, entry]),
    setSlotCurrent: (slotId, entryKey) =>
      call<undefined>("workspace-state", "slot.setCurrent", [slotId, entryKey]),
    updateCurrentStateArgs: (slotId, stateArgs) =>
      call<undefined>("workspace-state", "slot.updateCurrentStateArgs", [slotId, stateArgs]),
    replaceSlotHistory: (slotId, entries, cursor) =>
      call<undefined>("workspace-state", "slot.replaceHistory", [slotId, entries, cursor]),
    setSlotParent: (slotId, parentSlotId) =>
      call<undefined>("workspace-state", "slot.setParent", [slotId, parentSlotId]),
    setSlotPosition: (slotId, positionId) =>
      call<undefined>("workspace-state", "slot.setPosition", [slotId, positionId]),
    moveSlot: (slotId, parentSlotId, positionId) =>
      call<undefined>("workspace-state", "slot.move", [slotId, parentSlotId, positionId]),
    closeSlot: (slotId) => call<undefined>("workspace-state", "slot.close", [slotId]),
  };
  const runtime: RuntimeClient = {
    createEntity: (spec: RuntimeEntityCreateSpec) =>
      call<RuntimeEntityHandle>("runtime", "createEntity", [spec]),
    retireEntity: (id) => call<undefined>("runtime", "retireEntity", [{ id }]),
  };
  const searchIndex: PanelSearchIndex = {
    indexPanel: (panel: IndexablePanel) =>
      call<undefined>("workspace-state", "panel.index", [panel]),
    search: (query: string, limit?: number) =>
      call<PanelSearchResult[]>("workspace-state", "panel.search", [query, limit]),
    incrementAccessCount: (panelId: string) =>
      call<undefined>("workspace-state", "panel.incrementAccess", [panelId]),
    updateTitle: (panelId: string, title: string) =>
      call<undefined>("workspace-state", "panel.updateTitle", [panelId, title]),
    rebuildIndex: () => call<undefined>("workspace-state", "panel.rebuildIndex", []),
  };
  const panelManager = new PanelManager({
    registry,
    workspaceState,
    runtime,
    activationClient: {
      markPanelActive: (panelId) => call<undefined>("presence", "markPanelActive", [panelId]),
    },
    viewState: {
      load: () => ({ collapsedIds: [] }),
      save: () => {},
    },
    metadataResolver: {
      getPanelMetadata: (source) =>
        call<{ title?: string } | null>("build", "getPanelMetadata", [source]),
    },
    workspacePath: deps.workspacePath,
    allowMissingManifests: true,
    searchIndex,
    workspaceConfig: deps.workspaceConfig,
    serverInfo: {
      gatewayConfig: { serverUrl: `http://127.0.0.1:${deps.getGatewayPort?.() ?? 0}` },
    },
    grantConnection: (panelId) => call<{ token: string }>("auth", "grantConnection", [panelId]),
  });

  let panelTreeLoaded = false;
  let panelTreeLoadPromise: Promise<void> | null = null;
  const sync = async () => {
    if (panelTreeLoaded) return;
    panelTreeLoadPromise ??= panelManager
      .loadTree()
      .then(() => {
        panelTreeLoaded = true;
      })
      .finally(() => {
        panelTreeLoadPromise = null;
      });
    await panelTreeLoadPromise;
  };
  const emitTreeSnapshot = () => {
    deps.eventService?.emit("panel-tree-updated", registry.getPanelTreeSnapshot());
  };
  deps.registerEntityTitleListener?.(async (entityId, title) => {
    const normalized = title?.trim();
    if (!normalized) return;
    await sync();
    const target = await panelManager.resolveTitleTargetSlot(entityId);
    if (!target) return;
    const panel = registry.getPanel(target.slotId);
    if (panel?.title === normalized) return;
    if (target.titleIsAlreadyPersistedForSlot) {
      registry.updateTitle(target.slotId, normalized);
    } else {
      await panelManager.updateTitle(asPanelSlotId(target.slotId), normalized);
    }
    emitTreeSnapshot();
  });
  const withRuntimeEntity = async <T extends { panelId: string }>(
    item: T
  ): Promise<T & { runtimeEntityId: string }> => ({
    ...item,
    runtimeEntityId: await panelManager.getCurrentEntityId(asPanelSlotId(item.panelId)),
  });
  const panelToListItem = (
    panel: import("@natstack/shared/types").Panel,
    parentId: string | null
  ) => ({
    panelId: panel.id,
    title: panel.title,
    source: getPanelSource(panel),
    kind: getPanelSource(panel).startsWith("browser:")
      ? ("browser" as const)
      : ("workspace" as const),
    parentId,
    contextId: getPanelContextId(panel),
  });
  const ensureDefaultLoaded = async (panelId: string) => {
    await sync();
    const runtimeEntityId = await panelManager.getCurrentEntityId(asPanelSlotId(panelId));
    const cdpBridge = deps.container.get<import("./cdpBridge.js").CdpBridge>("cdpBridge");
    const assigned = deps.panelRuntimeCoordinator?.ensureDefaultCdpHostForSlot(
      panelId,
      runtimeEntityId,
      { isHostAvailable: (hostConnectionId) => cdpBridge.isProviderConnected(hostConnectionId) }
    );
    return {
      panelId,
      status:
        assigned?.assigned || assigned?.reason === "already_held"
          ? "loaded"
          : (assigned?.reason ?? "no_default_cdp_host"),
      focused: false,
      loaded: Boolean(assigned?.assigned || assigned?.reason === "already_held"),
      holderLabel: assigned?.lease?.holderLabel,
    };
  };
  const ensureHostCommandTargetReady = async (panelId: string) => {
    const cdpBridge = deps.container.get<import("./cdpBridge.js").CdpBridge>("cdpBridge");
    let holder = deps.panelRuntimeCoordinator?.resolveHostForSlot(panelId) ?? null;
    if (holder && !holder.supportsCdp) {
      throw Object.assign(new Error(`Panel ${panelId} is held by a non-CDP host`), {
        code: "panel_host_command_unavailable_mobile_held",
      });
    }
    if (holder && !cdpBridge.isProviderConnected(holder.hostConnectionId)) {
      throw Object.assign(new Error(`CDP host provider unavailable for panel: ${panelId}`), {
        code: "panel_host_command_unavailable_cdp_host",
      });
    }
    if (!holder || !cdpBridge.isTargetRegisteredForHost(panelId, holder.hostConnectionId)) {
      const loaded = await ensureDefaultLoaded(panelId);
      if (loaded.status === "mobile_held" || loaded.status === "no_default_cdp_host") {
        throw panelHostCommandAssignmentError(panelId, loaded.status);
      }
      holder = deps.panelRuntimeCoordinator?.resolveHostForSlot(panelId) ?? holder;
    }
    if (holder && !holder.supportsCdp) {
      throw Object.assign(new Error(`Panel ${panelId} is held by a non-CDP host`), {
        code: "panel_host_command_unavailable_mobile_held",
      });
    }
    if (holder) {
      await waitForCdpTargetRegistered(cdpBridge, panelId, holder.hostConnectionId);
    } else if (!cdpBridge.isTargetRegistered(panelId)) {
      await waitForCdpTargetRegistered(cdpBridge, panelId);
    }
    return cdpBridge;
  };

  return async (request) => {
    const method = request.method;
    const args = request.args;
    switch (method) {
      case "list": {
        await sync();
        const parentId = typeof args[0] === "string" ? args[0] : null;
        const panels = parentId ? registry.getChildren(parentId) : registry.listPanels();
        return Promise.all(panels.map((panel) => withRuntimeEntity(panel)));
      }
      case "roots": {
        await sync();
        return Promise.all(
          registry.getRootPanels().map((panel) => withRuntimeEntity(panelToListItem(panel, null)))
        );
      }
      case "metadata": {
        await sync();
        const panelId = String(args[0]);
        const panel = registry.getPanel(panelId);
        if (!panel) return null;
        const snapshot = getCurrentSnapshot(panel);
        return {
          id: panelId,
          title: panel.title,
          source: getPanelSource(panel),
          kind: getPanelSource(panel).startsWith("browser:") ? "browser" : "workspace",
          parentId: registry.findParentId(panelId),
          runtimeEntityId: await panelManager.getCurrentEntityId(asPanelSlotId(panelId)),
          privileged:
            snapshot.privileged === true || (snapshot as { shell?: boolean }).shell === true,
        };
      }
      case "create": {
        await sync();
        const source = String(args[0]);
        const options = (args[1] ?? {}) as {
          parentId?: string | null;
          name?: string;
          focus?: boolean;
          stateArgs?: Record<string, unknown>;
        };
        const parentId = resolveImplicitCreateParentId({
          explicitParentId: options.parentId,
          callerId: request.callerId,
          callerKind: request.callerKind,
          getCallerLeaseSlotId: (callerId) =>
            deps.panelRuntimeCoordinator?.getLease(callerId)?.slotId,
          hasPanel: (panelId) => Boolean(registry.getPanel(panelId)),
        });
        const isBrowser = /^https?:\/\//i.test(source);
        const created = isBrowser
          ? await panelManager.createBrowser(parentId ?? null, source, options)
          : await panelManager.create(source, { ...options, parentId });
        emitTreeSnapshot();
        const runtimeEntityId = await panelManager.getCurrentEntityId(
          asPanelSlotId(created.panelId)
        );
        return {
          id: created.panelId,
          title: created.title,
          kind: isBrowser ? "browser" : "workspace",
          runtimeEntityId,
        };
      }
      case "focus":
        await panelManager.notifyFocused(asPanelSlotId(String(args[0])));
        emitTreeSnapshot();
        return { panelId: String(args[0]), status: "focused", focused: true, loaded: false };
      case "ensureLoaded": {
        const panelId = String(args[0]);
        return ensureDefaultLoaded(panelId);
      }
      case "getRuntimeLease": {
        const host = deps.panelRuntimeCoordinator?.resolveHostForSlot(String(args[0])) ?? null;
        return host ? { leased: true, ...host } : { leased: false };
      }
      case "getStateArgs": {
        await sync();
        const panel = registry.getPanel(String(args[0]));
        if (!panel) throw new Error(`Panel not found: ${String(args[0])}`);
        return (getPanelStateArgs(panel) ?? {}) as Record<string, unknown>;
      }
      case "setStateArgs": {
        const result = await panelManager.updateStateArgs(
          asPanelSlotId(String(args[0])),
          (args[1] ?? {}) as Record<string, unknown>
        );
        emitTreeSnapshot();
        return result;
      }
      case "close":
      case "archive": {
        const result = await panelManager.close(asPanelSlotId(String(args[0])));
        emitTreeSnapshot();
        return result;
      }
      case "unload": {
        const panelId = String(args[0]);
        const lease = deps.panelRuntimeCoordinator?.unloadSlot(panelId) ?? null;
        return {
          panelId,
          status: lease ? "unloaded" : "already_unloaded",
          loaded: false,
          focused: false,
        };
      }
      case "movePanel": {
        const payload = (args[0] ?? {}) as {
          panelId?: unknown;
          newParentId?: unknown;
          targetPosition?: unknown;
        };
        const result = await panelManager.movePanel(
          asPanelSlotId(String(payload.panelId)),
          typeof payload.newParentId === "string" ? asPanelSlotId(payload.newParentId) : null,
          typeof payload.targetPosition === "number" ? payload.targetPosition : 0
        );
        emitTreeSnapshot();
        return result;
      }
      case "updatePanelState":
        await panelManager.updatePanelState(
          asPanelSlotId(String(args[0])),
          normalizePanelNavigationState((args[1] ?? {}) as Record<string, unknown>)
        );
        emitTreeSnapshot();
        return;
      case "reload": {
        const panelId = String(args[0]);
        const currentHolder = deps.panelRuntimeCoordinator?.resolveHostForSlot(panelId) ?? null;
        if (currentHolder && !currentHolder.supportsCdp) {
          throw Object.assign(
            new Error(`Cannot reload panel ${panelId} while it is held by a non-CDP host`),
            { code: "panel_reload_unavailable_mobile_held" }
          );
        }
        deps.panelRuntimeCoordinator?.unloadSlot(panelId);
        const result = await ensureDefaultLoaded(panelId);
        emitTreeSnapshot();
        return { ...result, status: result.loaded ? "reloaded" : result.status };
      }
      case "snapshot": {
        const panelId = String(args[0]);
        await sync();
        const panel = registry.getPanel(panelId);
        if (!panel) throw new Error(`Panel not found: ${panelId}`);
        if (getPanelSource(panel).startsWith("browser:")) {
          const cdpBridge = deps.container.get<import("./cdpBridge.js").CdpBridge>("cdpBridge");
          return snapshotBrowserPanelFromCdpBridge(cdpBridge, panelId);
        }
        const runtimeEntityId = await panelManager.getCurrentEntityId(asPanelSlotId(panelId));
        const { server: rpcServer } = deps.container.get<{
          server: import("./rpcServer.js").RpcServer;
        }>("rpcServer");
        return rpcServer.callTarget(runtimeEntityId, "_agent.snapshot");
      }
      case "callAgent": {
        const panelId = String(args[0]);
        const runtimeEntityId = await panelManager.getCurrentEntityId(asPanelSlotId(panelId));
        const { server: rpcServer } = deps.container.get<{
          server: import("./rpcServer.js").RpcServer;
        }>("rpcServer");
        return rpcServer.callTarget(
          runtimeEntityId,
          String(args[1]),
          ...(Array.isArray(args[2]) ? args[2] : [])
        );
      }
      case "takeOver": {
        if (request.callerKind !== "panel") {
          throw new Error("takeOver requires a panel caller with an active host lease");
        }
        const requesterLease = deps.panelRuntimeCoordinator?.getLease(request.callerId) ?? null;
        if (!requesterLease) {
          throw new Error("takeOver requires the caller panel to be loaded on a host");
        }
        const panelId = String(args[0]);
        await sync();
        const runtimeEntityId = await panelManager.getCurrentEntityId(asPanelSlotId(panelId));
        const result = deps.panelRuntimeCoordinator?.takeOver(runtimeEntityId, {
          slotId: panelId,
          clientSessionId: requesterLease.clientSessionId,
          hostConnectionId: requesterLease.hostConnectionId,
          connectionId: `takeover-${panelId}-${randomUUID()}`,
        });
        if (!result?.acquired) throw new Error(`Unable to take over panel ${panelId}`);
        await panelManager.notifyFocused(asPanelSlotId(panelId));
        emitTreeSnapshot();
        return {
          panelId,
          status: "taken_over",
          focused: true,
          loaded: true,
          holderLabel: result.lease.holderLabel,
        };
      }
      case "openDevTools": {
        const panelId = String(args[0]);
        const mode = args[1] === "right" || args[1] === "bottom" ? args[1] : "detach";
        const cdpBridge = await ensureHostCommandTargetReady(panelId);
        return cdpBridge.sendHostCommand(panelId, "openDevTools", [mode]);
      }
      case "rebuildPanel": {
        const panelId = String(args[0]);
        const cdpBridge = await ensureHostCommandTargetReady(panelId);
        return cdpBridge.sendHostCommand(panelId, "rebuildPanel", []);
      }
      default:
        throw new Error(`Unknown panelTree bridge method: ${method}`);
    }
  };
}

export async function snapshotBrowserPanelFromCdpBridge(
  cdpBridge: Pick<import("./cdpBridge.js").CdpBridge, "isTargetRegistered" | "sendHostCommand">,
  panelId: string
): Promise<{ kind: "ax"; text: string; structure: unknown[] }> {
  if (!cdpBridge.isTargetRegistered(panelId)) {
    throw new Error(`target-not-loaded: ${panelId}`);
  }
  const nodes = (await cdpBridge.sendHostCommand(panelId, "accessibilityTree", [])) as unknown[];
  return {
    kind: "ax",
    text: summarizeAxNodes(nodes),
    structure: nodes,
  };
}

function summarizeAxNodes(nodes: unknown[]): string {
  const labels: string[] = [];
  for (const node of nodes.slice(0, 200)) {
    const record = node as {
      role?: { value?: unknown };
      name?: { value?: unknown };
      value?: { value?: unknown };
    };
    const role = typeof record.role?.value === "string" ? record.role.value : "";
    const name = typeof record.name?.value === "string" ? record.name.value : "";
    const value = typeof record.value?.value === "string" ? record.value.value : "";
    const line = [role, name || value].filter(Boolean).join(": ");
    if (line) labels.push(line);
  }
  return labels.join("\n");
}

export interface CommonDeps {
  container: ServiceContainer;
  dispatcher: ServiceDispatcher;
  workspace: Workspace;
  workspacePath: string;
  workspaceConfig: WorkspaceConfig;
  adminToken: string;
  centralData: CentralDataManager | null;
  hostConfig: HostConfig;
  isIpcMode: boolean;
  tokenManager?: import("@natstack/shared/tokenManager").TokenManager;
  eventService?: import("@natstack/shared/eventsService").EventService;
  grantStore?: import("./services/capabilityGrantStore.js").CapabilityGrantStore;
  panelRuntimeCoordinator?: import("./panelRuntimeCoordinator.js").PanelRuntimeCoordinator;
  getGatewayPort?: () => number | null;
  requestRelaunch?: (name: string) => void;
  /** IPC proxy: fetch workspace list from Electron main when centralData is null. */
  requestWorkspaceList?: () => Promise<unknown[]>;
  listWorkspaceUnits?: () =>
    | Promise<import("./services/workspaceService.js").WorkspaceUnitStatus[]>
    | import("./services/workspaceService.js").WorkspaceUnitStatus[];
  restartWorkspaceUnit?: (
    ctx: import("@natstack/shared/serviceDispatcher").ServiceContext,
    name: string
  ) => Promise<void>;
  listWorkspaceUnitLogs?: (
    name: string,
    opts?: {
      since?: number;
      level?: import("./services/workspaceService.js").WorkspaceUnitLogRecord["level"];
      limit?: number;
    }
  ) =>
    | Promise<import("./services/workspaceService.js").WorkspaceUnitLogRecord[]>
    | import("./services/workspaceService.js").WorkspaceUnitLogRecord[];
  bakeAppDist?: (sourceOrName: string, opts?: { outDir?: string }) => Promise<unknown> | unknown;
  listAppVersions?: (
    sourceOrName: string
  ) =>
    | Promise<import("./services/workspaceService.js").WorkspaceAppVersions>
    | import("./services/workspaceService.js").WorkspaceAppVersions;
  rollbackAppVersion?: (sourceOrName: string, buildKey?: string) => Promise<unknown> | unknown;
  listHostTargetCandidates?: (
    target: HostTarget
  ) => Promise<HostTargetCandidate[]> | HostTargetCandidate[];
  getHostTargetSelection?: (
    target: HostTarget
  ) =>
    | Promise<{ selection: HostTargetSelection | null; valid: boolean; reason?: string }>
    | { selection: HostTargetSelection | null; valid: boolean; reason?: string };
  setHostTargetSelection?: (
    target: HostTarget,
    input: HostTargetSelectionInput
  ) => Promise<HostTargetSelection> | HostTargetSelection;
  clearHostTargetSelection?: (target: HostTarget) => Promise<void> | void;
  listHostTargetVersions?: (
    target: HostTarget,
    sourceOrName: string
  ) =>
    | Promise<import("./services/workspaceService.js").WorkspaceAppVersions>
    | import("./services/workspaceService.js").WorkspaceAppVersions;
  prepareHostTargetPinnedCommit?: (
    target: HostTarget,
    sourceOrName: string,
    commit: string
  ) => Promise<unknown> | unknown;
  launchHostTarget?: (target: HostTarget) => Promise<boolean> | boolean;
  approvalQueue?: ApprovalQueue;
  getEffectiveVersion?: (source: string) => Promise<string | undefined>;
  registerEntityTitleListener?: (
    listener: (entityId: string, title: string | undefined) => void | Promise<void>
  ) => () => void;
}

export async function registerPanelServices(deps: CommonDeps): Promise<void> {
  const {
    container,
    workspace,
    workspacePath,
    workspaceConfig,
    adminToken,
    centralData,
    hostConfig,
  } = deps;
  const path = await import("path");
  const { rpcService } = await import("@natstack/shared/managedService");
  let serverPanelTreeBridgePromise: Promise<
    (request: import("./services/panelTreeService.js").PanelTreeBridgeRequest) => Promise<unknown>
  > | null = null;
  const getPanelTreeBridge = () => {
    serverPanelTreeBridgePromise ??= createServerPanelTreeBridge(deps);
    return serverPanelTreeBridgePromise;
  };
  const requestPanelMetadataForServices = async (
    panelId: string,
    caller: { id: string; kind: string } = { id: "server", kind: "server" }
  ): Promise<PanelAccessMetadata | null> => {
    const bridge = await getPanelTreeBridge();
    const meta = (await bridge({
      callerId: caller.id,
      callerKind: caller.kind,
      method: "metadata",
      args: [panelId],
    })) as PanelAccessMetadata | null;
    if (!meta) return null;
    return { ...meta, id: panelId };
  };
  const resolveRequesterPanelMetadataForServices = async (
    caller: import("@natstack/shared/serviceDispatcher").VerifiedCaller
  ): Promise<PanelAccessMetadata | null> => {
    if (caller.runtime.kind !== "panel") return null;
    const lease = deps.panelRuntimeCoordinator?.getLease(caller.runtime.id);
    const slotId = lease?.slotId ?? caller.runtime.id;
    return requestPanelMetadataForServices(slotId, {
      id: caller.runtime.id,
      kind: caller.runtime.kind,
    });
  };

  {
    const { createWorkspaceService } = await import("./services/workspaceService.js");
    const { createWorkspaceConfigManager, createAndRegisterWorkspace, deleteWorkspaceDir } =
      await import("@natstack/shared/workspace/loader");
    const wsConfigPath = path.join(workspacePath, "meta/natstack.yml");
    const wsConfigManager = createWorkspaceConfigManager(wsConfigPath, workspaceConfig);

    container.register(
      rpcService(
        createWorkspaceService({
          workspace,
          getConfig: wsConfigManager.get,
          setConfigField: wsConfigManager.set as (key: string, value: unknown) => void,
          centralData: centralData ?? null,
          createWorkspace: (name, opts) => {
            if (!centralData) throw new Error("Workspace creation not available");
            return createAndRegisterWorkspace(name, centralData, opts);
          },
          deleteWorkspaceDir,
          requestRelaunch: deps.requestRelaunch,
          requestWorkspaceList: deps.requestWorkspaceList,
          listUnits: deps.listWorkspaceUnits,
          restartUnit: deps.restartWorkspaceUnit,
          listUnitLogs: deps.listWorkspaceUnitLogs,
          bakeAppDist: deps.bakeAppDist,
          listAppVersions: deps.listAppVersions,
          rollbackAppVersion: deps.rollbackAppVersion,
          listHostTargetCandidates: deps.listHostTargetCandidates,
          getHostTargetSelection: deps.getHostTargetSelection,
          setHostTargetSelection: deps.setHostTargetSelection,
          clearHostTargetSelection: deps.clearHostTargetSelection,
          listHostTargetVersions: deps.listHostTargetVersions,
          prepareHostTargetPinnedCommit: deps.prepareHostTargetPinnedCommit,
          launchHostTarget: deps.launchHostTarget,
          approvalQueue: deps.approvalQueue,
        })
      )
    );
  }

  {
    const { PanelHttpServer } = await import("./panelHttpServer.js");
    container.register({
      name: "panelHttpServer",
      async start() {
        const server = new PanelHttpServer(
          hostConfig.bindHost,
          adminToken,
          hostConfig.externalHost,
          hostConfig.protocol
        );
        server.initHandlers();
        return { server, port: 0 };
      },
      async stop(instance: {
        server: import("./panelHttpServer.js").PanelHttpServer;
        port: number;
      }) {
        await instance?.server?.stop();
      },
    });
    container.register({
      name: "cdpBridge",
      dependencies: ["panelHttpServer"],
      async start(resolve) {
        const { server } = assertPresent(
          resolve<{
            server: import("./panelHttpServer.js").PanelHttpServer;
          }>("panelHttpServer")
        );
        const { CdpBridge } = await import("./cdpBridge.js");
        const cdpBridge = new CdpBridge({
          adminToken,
          port: deps.getGatewayPort?.() ?? hostConfig.gatewayPort,
          protocol: hostConfig.protocol,
          externalHost: hostConfig.externalHost,
          authenticateHostProvider: (token, hostConnectionId) => {
            if (deps.tokenManager?.validateAdminToken(token)) return true;
            const entry = deps.tokenManager?.validateToken(token);
            if (!entry || entry.callerKind !== "shell-remote") return false;
            return Boolean(
              hostConnectionId &&
              deps.panelRuntimeCoordinator?.hasClientHostConnection(
                hostConnectionId,
                entry.callerId
              )
            );
          },
          canRegisterHostProvider: (hostConnectionId) =>
            Boolean(deps.panelRuntimeCoordinator?.hasClientHostConnection(hostConnectionId)),
          resolveHostForTarget: (targetId) => {
            const resolved = deps.panelRuntimeCoordinator?.resolveHostForSlot(targetId);
            if (!resolved) return null;
            return resolved.supportsCdp ? resolved.hostConnectionId : null;
          },
          isPanelKnown: async (targetId) =>
            Boolean(await requestPanelMetadataForServices(targetId)),
        });
        deps.panelRuntimeCoordinator?.onLeaseChanged((event) => {
          cdpBridge.handleRuntimeLeaseChanged(event);
        });
        server.setCdpBridge(cdpBridge);
        return cdpBridge;
      },
      async stop(instance: import("./cdpBridge.js").CdpBridge) {
        await instance?.stop();
      },
    });
  }

  {
    let panelCdpDefinition: import("@natstack/shared/serviceDefinition").ServiceDefinition;
    container.register({
      name: "panelCdp",
      dependencies: ["cdpBridge", "shellPresence"],
      async start(resolve) {
        const bridge = assertPresent(resolve<import("./cdpBridge.js").CdpBridge>("cdpBridge"));
        const shellPresence = assertPresent(
          resolve<import("./services/shellPresenceService.js").ShellPresenceServiceResult>(
            "shellPresence"
          )
        );
        const { createPanelCdpService } = await import("./services/panelCdpService.js");
        panelCdpDefinition = createPanelCdpService({
          approvalQueue: assertPresent(deps.approvalQueue),
          grantStore: assertPresent(deps.grantStore),
          resolveRequesterPanel: resolveRequesterPanelMetadataForServices,
          hasApprovalSession: () => shellPresence.internal.isAnyShellActive(),
          approvalTimeoutMs: 30_000,
          getTarget: (panelId) => requestPanelMetadataForServices(panelId),
          getEndpoint: async (panelId, requesterEntityId) => {
            await ensureCdpTargetReady(panelId);
            const endpoint = bridge.getCdpEndpoint(panelId, requesterEntityId);
            if (!endpoint) throw new Error(`CDP endpoint unavailable for panel: ${panelId}`);
            return endpoint;
          },
          drive: async (panelId, requesterEntityId, command, args) => {
            await ensureCdpTargetReady(panelId);
            return bridge.sendTargetCommand(panelId, requesterEntityId, command, args);
          },
        });

        async function ensureCdpTargetReady(panelId: string): Promise<void> {
          const loadViaPanelTree = async () => {
            const panelTreeBridge = await getPanelTreeBridge();
            await panelTreeBridge({
              callerId: "server",
              callerKind: "server",
              method: "ensureLoaded",
              args: [panelId],
            });
          };

          const target = await requestPanelMetadataForServices(panelId);
          const runtimeEntityId = target?.runtimeEntityId ?? panelId;
          let holder = deps.panelRuntimeCoordinator?.resolveHostForSlot(panelId) ?? null;
          if (holder && !holder.supportsCdp) {
            throw Object.assign(
              new Error(`CDP is unavailable while panel ${panelId} is held by a non-CDP host`),
              { code: "cdp_unavailable_mobile_held" }
            );
          }
          if (!holder && deps.panelRuntimeCoordinator) {
            const assigned = deps.panelRuntimeCoordinator.ensureDefaultCdpHostForSlot(
              panelId,
              runtimeEntityId,
              {
                isHostAvailable: (hostConnectionId) => bridge.isProviderConnected(hostConnectionId),
              }
            );
            if (assigned.lease) {
              holder = {
                hostConnectionId: assigned.lease.hostConnectionId,
                supportsCdp: assigned.lease.supportsCdp,
              };
            }
            if (!assigned.assigned) {
              const error = cdpDefaultHostAssignmentError(panelId, assigned.reason);
              if (error) throw error;
            }
          }
          if (holder && !bridge.isProviderConnected(holder.hostConnectionId)) {
            throw Object.assign(new Error(`CDP host provider unavailable for panel: ${panelId}`), {
              code: "cdp_host_unavailable",
            });
          }
          if (holder && bridge.isTargetRegisteredForHost(panelId, holder.hostConnectionId)) return;
          if (!holder && bridge.isTargetRegistered(panelId)) return;
          if (holder) {
            await waitForCdpTargetRegistered(bridge, panelId, holder.hostConnectionId);
          } else {
            await loadViaPanelTree();
            await waitForCdpTargetRegistered(bridge, panelId);
          }
          if (holder && !bridge.isTargetRegisteredForHost(panelId, holder.hostConnectionId)) {
            throw new Error(`CDP endpoint unavailable for panel: ${panelId}`);
          }
          if (!holder && !bridge.isTargetRegistered(panelId)) {
            throw new Error(`CDP endpoint unavailable for panel: ${panelId}`);
          }
        }
      },
      getServiceDefinition() {
        if (!panelCdpDefinition) throw new Error("panelCdp service not initialized");
        return panelCdpDefinition;
      },
    });
  }

  {
    let panelTreeDefinition: import("@natstack/shared/serviceDefinition").ServiceDefinition;
    container.register({
      name: "panelTree",
      dependencies: ["shellPresence"],
      async start(resolve) {
        const shellPresence = assertPresent(
          resolve<import("./services/shellPresenceService.js").ShellPresenceServiceResult>(
            "shellPresence"
          )
        );
        const { createPanelTreeService } = await import("./services/panelTreeService.js");
        panelTreeDefinition = createPanelTreeService({
          approvalQueue: assertPresent(deps.approvalQueue),
          grantStore: assertPresent(deps.grantStore),
          resolveRequesterPanel: resolveRequesterPanelMetadataForServices,
          hasApprovalSession: () => shellPresence.internal.isAnyShellActive(),
          approvalTimeoutMs: 30_000,
          bridge: await getPanelTreeBridge(),
        });
      },
      getServiceDefinition() {
        if (!panelTreeDefinition) throw new Error("panelTree service not initialized");
        return panelTreeDefinition;
      },
    });
  }

  container.register({
    name: "panelHttpWiring",
    dependencies: ["panelHttpServer", "buildSystem", "rpcServer"],
    async start(resolve) {
      const { server: panelHttpServer } = assertPresent(
        resolve<{
          server: import("./panelHttpServer.js").PanelHttpServer;
        }>("panelHttpServer")
      );
      const buildSystem = assertPresent(
        resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
      );
      const { server: rpcServer } = assertPresent(
        resolve<{ server: import("./rpcServer.js").RpcServer }>("rpcServer")
      );

      const graph = buildSystem.getGraph();
      const panelNodes = graph.allNodes().filter((n) => n.kind === "panel");
      const entries = panelNodes.map((n) => ({
        source: n.relativePath,
        name: n.manifest.title ?? n.name,
      }));
      panelHttpServer.populateSourceRegistry(entries);

      panelHttpServer.setCallbacks({
        listPanels: () => [],
        getBuild: (source, ref) => buildSystem.getBuild(source, ref),
        onBuildComplete: (source, error) => {
          rpcServer.broadcastToControlPlane({
            type: "ws:event",
            event: "build:complete",
            payload: { source, error },
          } as import("@natstack/shared/ws/protocol").WsServerMessage);
        },
      });

      buildSystem.onPushBuild((source) => {
        panelHttpServer.invalidateBuild(source);
      });
    },
  });

  {
    const { handleFsCall } = await import("@natstack/shared/fsService");
    let fsServiceInstance: import("@natstack/shared/fsService").FsService;
    container.register({
      name: "fsRpc",
      dependencies: ["fsService"],
      async start(resolve) {
        fsServiceInstance = assertPresent(
          resolve<import("@natstack/shared/fsService").FsService>("fsService")
        );
      },
      getServiceDefinition() {
        const fsMethodSchema = { args: z.tuple([z.string()]).rest(z.unknown()) };
        // `mktemp` takes an optional prefix string; no leading path arg.
        const mktempSchema = { args: z.tuple([z.string().optional()]) };
        // Per-method policy for sandbox-escape primitives. `symlink` and
        // `chown` were Wave-1 audit findings (#38, #39): even though the
        // implementation in `fsService.ts` was hardened (sandbox-target
        // resolution, lstat parent walk), exposing them to `panel` /
        // `worker` callers gives attackers a TOCTOU primitive. Restrict
        // both to trusted native-code callers only — internal server callers
        // needing these ops can bypass the dispatcher, and extensions already
        // have equivalent raw Node access after install approval. App callers
        // are pre-gated by the Electron host's fs-read/fs-write capabilities.
        return {
          name: "fs",
          description: "Per-context filesystem operations (sandboxed to context folder)",
          policy: { allowed: ["panel", "app", "server", "worker", "do", "extension"] },
          methods: {
            readFile: fsMethodSchema,
            writeFile: fsMethodSchema,
            readdir: fsMethodSchema,
            mkdir: fsMethodSchema,
            stat: fsMethodSchema,
            open: fsMethodSchema,
            close: fsMethodSchema,
            read: fsMethodSchema,
            write: fsMethodSchema,
            mktemp: mktempSchema,
            symlink: { ...fsMethodSchema, policy: { allowed: ["shell", "extension"] } },
            chown: { ...fsMethodSchema, policy: { allowed: ["shell", "extension"] } },
          },
          handler: async (ctx, method, serviceArgs) => {
            return handleFsCall(fsServiceInstance, ctx, method, serviceArgs as unknown[]);
          },
        };
      },
    });
  }
}
