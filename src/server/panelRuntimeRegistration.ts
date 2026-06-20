/**
 * Panel runtime registration for shell-owned panel state.
 *
 * The server still owns shared services like builds, workspace metadata,
 * filesystem access, and token minting, but panel trees no longer live here.
 */

import { randomUUID } from "crypto";
import { createDevLogger } from "@natstack/dev-log";
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
  HostTargetLaunchResult,
  HostTargetLaunchSessionSnapshot,
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
import { resolveOwningPanelSlot } from "@natstack/shared/panel/owningPanelSlot";
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
import type { AppCapability } from "@natstack/shared/unitManifest";
import type {
  IndexablePanel,
  PanelSearchIndex,
  PanelSearchResult,
} from "@natstack/shared/panelSearchTypes";

const log = createDevLogger("PanelRuntimeRegistration");

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

function normalizePanelTreeNavigateOptions(input: unknown):
  | {
      ref?: string;
      contextId?: string;
      env?: Record<string, string>;
      stateArgs?: Record<string, unknown>;
    }
  | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const env =
    record["env"] && typeof record["env"] === "object"
      ? Object.fromEntries(
          Object.entries(record["env"] as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        )
      : undefined;
  const stateArgs =
    record["stateArgs"] && typeof record["stateArgs"] === "object"
      ? (record["stateArgs"] as Record<string, unknown>)
      : undefined;
  return {
    ...(typeof record["ref"] === "string" ? { ref: record["ref"] } : {}),
    ...(typeof record["contextId"] === "string" ? { contextId: record["contextId"] } : {}),
    ...(env ? { env } : {}),
    ...(stateArgs ? { stateArgs } : {}),
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

export async function createServerPanelTreeBridge(
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
    resolveSlotByEntity: (entityId) =>
      call<string | null>("workspace-state", "slot.resolveByEntity", [entityId]),
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
  const sync = async (options: { force?: boolean } = {}) => {
    if (panelTreeLoaded && !options.force) return;
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

  // Serialize bridge operations against the self-heal. The self-heal does a full
  // registry replace (sync force → loadTree); if it races an in-flight
  // create/navigate it can read an intermediate DB state and broadcast a stale
  // tree, making every client mirror OSCILLATE (e.g. 2 roots → 1 → 2), which
  // crashes mid-build attachCreatedPanel and spuriously prunes views. A single
  // op-chain makes mutations and the self-heal mutually exclusive. (Bridge
  // requests never re-enter the handler, so this can't deadlock.)
  let opChain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = opChain.then(fn, fn);
    opChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  // Self-heal: whenever the authoritative slot tree changes (any client, via the
  // shared workspace-state service), force a fresh sync and re-broadcast so every
  // client mirror converges. Debounced — one logical mutation (e.g. a navigate)
  // emits several slot writes. Reads only, so it never re-triggers itself.
  let selfHealRunning = false;
  let selfHealQueued = false;
  const runSelfHeal = async () => {
    if (selfHealRunning) {
      selfHealQueued = true;
      return;
    }
    selfHealRunning = true;
    selfHealQueued = false;
    try {
      await serialize(async () => {
        await sync({ force: true });
        emitTreeSnapshot();
      });
    } catch (error) {
      log.warn(
        `Panel tree self-heal failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      selfHealRunning = false;
      if (selfHealQueued) queueMicrotask(() => void runSelfHeal());
    }
  };
  let selfHealTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSelfHeal = () => {
    if (selfHealTimer) return;
    selfHealTimer = setTimeout(() => {
      selfHealTimer = null;
      void runSelfHeal();
    }, 16);
  };
  deps.registerSlotStateListener?.(scheduleSelfHeal);

  deps.registerEntityTitleListener?.(async (entityId, title, origin) => {
    if (origin === "mirror") return;
    const normalized = title?.trim();
    if (!normalized) return;
    const target = await panelManager.resolveTitleTargetSlot(entityId);
    if (!target) return;
    if (!target.titleIsAlreadyPersistedForSlot && origin !== "set-explicit") return;
    if (!target.titleIsAlreadyPersistedForSlot) {
      await panelManager.updateTitle(asPanelSlotId(target.slotId), normalized);
    }
    deps.eventService?.emit("panel-title-updated", {
      panelId: target.slotId,
      title: normalized,
      explicit: origin === "set-explicit",
    });
  });
  const withRuntimeEntity = async <T extends { panelId: string }>(
    item: T
  ): Promise<T & { runtimeEntityId: string; effectiveVersion?: string | null }> => {
    const slotId = asPanelSlotId(item.panelId);
    const source = await panelManager.getCurrentEntitySource(slotId);
    return {
      ...item,
      runtimeEntityId: await panelManager.getCurrentEntityId(slotId),
      effectiveVersion: source?.effectiveVersion ?? null,
    };
  };
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
    let assigned = deps.panelRuntimeCoordinator?.ensureDefaultCdpHostForSlot(
      panelId,
      runtimeEntityId,
      { isHostAvailable: (hostConnectionId) => cdpBridge.isProviderConnected(hostConnectionId) }
    );
    if (
      assigned &&
      !assigned.assigned &&
      assigned.reason === "no_default_cdp_host" &&
      deps.ensureDefaultHeadlessHost
    ) {
      // Renderer of last resort: spawn the headless host and retry once.
      if (await deps.ensureDefaultHeadlessHost()) {
        assigned = deps.panelRuntimeCoordinator?.ensureDefaultCdpHostForSlot(
          panelId,
          runtimeEntityId,
          { isHostAvailable: (hostConnectionId) => cdpBridge.isProviderConnected(hostConnectionId) }
        );
      }
    }
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

  const handleBridgeRequest = async (
    request: import("./services/panelTreeService.js").PanelTreeBridgeRequest
  ): Promise<unknown> => {
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
      case "getTreeSnapshot": {
        await sync();
        return registry.getPanelTreeSnapshot();
      }
      case "getFocusedPanelId": {
        await sync();
        return registry.getFocusedPanelId();
      }
      case "metadata": {
        await sync();
        const panelId = String(args[0]);
        let panel = registry.getPanel(panelId);
        if (!panel) {
          await sync({ force: true });
          panel = registry.getPanel(panelId);
        }
        if (!panel) return null;
        const snapshot = getCurrentSnapshot(panel);
        return {
          id: panelId,
          title: panel.title,
          source: getPanelSource(panel),
          kind: getPanelSource(panel).startsWith("browser:") ? "browser" : "workspace",
          parentId: registry.findParentId(panelId),
          runtimeEntityId: await panelManager.getCurrentEntityId(asPanelSlotId(panelId)),
          effectiveVersion:
            (await panelManager.getCurrentEntitySource(asPanelSlotId(panelId)))?.effectiveVersion ??
            null,
          contextId: getPanelContextId(panel),
          ref: snapshot.options.ref,
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
          ref?: string;
          stateArgs?: Record<string, unknown>;
        };
        // Resolve the owning panel TREE SLOT once, durably. Explicit null = root; an explicit id or
        // the implicit caller = walk the entity lineage to the nearest OPEN panel and return its slot
        // id (parity for panel/worker/agent/eval callers + removal-robustness, in one resolver). This
        // is the single fix for the nav-id-vs-slot-id mismatch that rooted agent/eval-launched panels.
        const explicitParentProvided =
          options.parentId === null || typeof options.parentId === "string";
        const parentStartId = explicitParentProvided ? options.parentId : request.callerId;
        const parentId =
          parentStartId == null
            ? undefined
            : await resolveOwningPanelSlot(parentStartId, {
                isOpenSlot: (id) => Boolean(registry.getPanel(id)),
                resolveOpenSlotForEntity: async (id) =>
                  (await workspaceState.resolveSlotByEntity(id)) ?? undefined,
                resolveParentId: async (id) =>
                  (await workspaceState.resolveActiveEntity(id))?.parentId,
              });
        const isBrowser = /^https?:\/\//i.test(source);
        // A null parent means a root panel. addPanel() treats a null parent
        // WITHOUT addAsRoot as "replace the tree with this single panel", so root
        // creates MUST set addAsRoot/isRoot — otherwise a root create would wipe
        // the in-memory mirror to one panel before the next sync restores it.
        const isRoot = parentId == null;
        const created = isBrowser
          ? await panelManager.createBrowser(parentId ?? null, source, {
              name: options.name,
              addAsRoot: isRoot,
            })
          : await panelManager.create(source, {
              ...options,
              parentId,
              isRoot,
              addAsRoot: isRoot,
            });
        emitTreeSnapshot();
        const runtimeEntityId = await panelManager.getCurrentEntityId(
          asPanelSlotId(created.panelId)
        );
        const entitySource = await panelManager.getCurrentEntitySource(
          asPanelSlotId(created.panelId)
        );
        return {
          id: created.panelId,
          title: created.title,
          kind: isBrowser ? "browser" : "workspace",
          contextId: created.contextId,
          source: created.source,
          runtimeEntityId,
          effectiveVersion: entitySource?.effectiveVersion ?? null,
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
        await sync();
        const runtimeEntityId = await panelManager.getCurrentEntityId(
          asPanelSlotId(String(args[0]))
        );
        return deps.panelRuntimeCoordinator?.getLease(runtimeEntityId) ?? null;
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
        const panelId = String(args[0]);
        const result = await panelManager.close(asPanelSlotId(String(args[0])));
        emitTreeSnapshot();
        return {
          panelId,
          operation: "close",
          status: "closed",
          loaded: false,
          rebuilt: false,
          reloaded: false,
          closedIds: Array.isArray((result as { closedIds?: unknown }).closedIds)
            ? (result as { closedIds: unknown[] }).closedIds
            : undefined,
        };
      }
      case "unload": {
        const panelId = String(args[0]);
        const lease = deps.panelRuntimeCoordinator?.unloadSlot(panelId) ?? null;
        return {
          panelId,
          operation: "unload",
          status: lease ? "unloaded" : "already_unloaded",
          loaded: false,
          rebuilt: false,
          reloaded: false,
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
      case "navigate": {
        const panelId = String(args[0]);
        const source = String(args[1]);
        const options = normalizePanelTreeNavigateOptions(args[2]);
        // Server is the sole writer: mutate WorkspaceDO here, then broadcast.
        // The hosting client reloads the panel's view reactively from the new
        // snapshot (no per-mutation host command).
        const result = await panelManager.navigate(asPanelSlotId(panelId), source, options);
        emitTreeSnapshot();
        return {
          id: result.panelId,
          title: result.title,
          kind: result.source.startsWith("browser:") ? "browser" : "workspace",
          source: result.source,
          contextId: result.contextId,
        };
      }
      case "navigateHistory": {
        const panelId = String(args[0]);
        const delta = (args[1] === 1 ? 1 : -1) as -1 | 1;
        // Server is the sole writer; the hosting client rebuilds the view from
        // this response (source/contextId) after refreshing its entity cache.
        const panel = await panelManager.navigateHistory(asPanelSlotId(panelId), delta);
        emitTreeSnapshot();
        if (!panel) return null;
        const snap = getCurrentSnapshot(panel);
        return { id: panel.id, title: panel.title, source: snap.source, contextId: snap.contextId };
      }
      case "updatePanelState":
        await panelManager.updatePanelState(
          asPanelSlotId(String(args[0])),
          normalizePanelNavigationState((args[1] ?? {}) as Record<string, unknown>)
        );
        emitTreeSnapshot();
        return;
      case "getCollapsedIds":
        return panelManager.getCollapsedIds();
      case "setCollapsed":
        await panelManager.setCollapsed(asPanelSlotId(String(args[0])), Boolean(args[1]));
        return;
      case "expandIds":
        await panelManager.expandIds(
          Array.isArray(args[0]) ? (args[0] as unknown[]).map((id) => String(id)) : []
        );
        return;
      case "reload": {
        const panelId = String(args[0]);
        const cdpBridge = await ensureHostCommandTargetReady(panelId);
        const result = await cdpBridge.sendHostCommand(panelId, "reloadPanel", []);
        emitTreeSnapshot();
        return result;
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
      case "rebuildAndReload": {
        const panelId = String(args[0]);
        const cdpBridge = await ensureHostCommandTargetReady(panelId);
        return cdpBridge.sendHostCommand(panelId, "rebuildAndReload", []);
      }
      default:
        throw new Error(`Unknown panelTree bridge method: ${method}`);
    }
  };

  // Every bridge request runs on the shared op-chain so mutations and the
  // self-heal reload never interleave (prevents mirror oscillation).
  return (request) => serialize(() => handleBridgeRequest(request));
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
  treeScanner?: import("./gadVcs/workspaceTree.js").WorkspaceTreeScanner;
  adminToken: string;
  centralData: CentralDataManager | null;
  hostConfig: HostConfig;
  isIpcMode: boolean;
  tokenManager?: import("@natstack/shared/tokenManager").TokenManager;
  eventService?: import("@natstack/shared/eventsService").EventService;
  grantStore?: import("./services/capabilityGrantStore.js").CapabilityGrantStore;
  /** Whether a workspace-app caller declares a capability (e.g. panel-hosting). */
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
  panelRuntimeCoordinator?: import("./panelRuntimeCoordinator.js").PanelRuntimeCoordinator;
  /**
   * Renderer of last resort: spawn (or reuse) the standalone headless host
   * and resolve true once a default CDP host is registered + bridge-connected.
   * Callers retry default lease assignment after a true result.
   */
  ensureDefaultHeadlessHost?: () => Promise<boolean>;
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
  unitDiagnostics?: (
    name: string,
    opts?: {
      since?: number;
      level?: import("./services/workspaceService.js").WorkspaceUnitLogRecord["level"];
      limit?: number;
      errorLimit?: number;
    }
  ) =>
    | Promise<import("./services/workspaceService.js").WorkspaceUnitDiagnostics>
    | import("./services/workspaceService.js").WorkspaceUnitDiagnostics;
  bakeAppDist?: (sourceOrName: string, opts?: { outDir?: string }) => Promise<unknown> | unknown;
  listAppVersions?: (
    sourceOrName: string
  ) =>
    | Promise<import("./services/workspaceService.js").WorkspaceAppVersions>
    | import("./services/workspaceService.js").WorkspaceAppVersions;
  rollbackAppVersion?: (sourceOrName: string, buildKey?: string) => Promise<unknown> | unknown;
  listRecurringJobs?: () =>
    | Promise<import("./services/workspaceService.js").WorkspaceRecurringJobStatus[]>
    | import("./services/workspaceService.js").WorkspaceRecurringJobStatus[];
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
  prepareHostTargetPinnedRef?: (
    target: HostTarget,
    sourceOrName: string,
    ref: string
  ) => Promise<unknown> | unknown;
  launchHostTarget?: (
    target: HostTarget
  ) => Promise<HostTargetLaunchResult> | HostTargetLaunchResult;
  beginHostTargetLaunch?: (
    target: HostTarget
  ) => Promise<HostTargetLaunchSessionSnapshot> | HostTargetLaunchSessionSnapshot;
  getHostTargetLaunchSession?: (
    sessionId: string
  ) => Promise<HostTargetLaunchSessionSnapshot | null> | HostTargetLaunchSessionSnapshot | null;
  resolveHostTargetLaunchSessionApproval?: (
    sessionId: string,
    decision: "once" | "deny"
  ) => Promise<HostTargetLaunchSessionSnapshot> | HostTargetLaunchSessionSnapshot;
  cancelHostTargetLaunchSession?: (sessionId: string) => Promise<void> | void;
  approvalQueue?: ApprovalQueue;
  getEffectiveVersion?: (source: string) => Promise<string | undefined>;
  registerEntityTitleListener?: (
    listener: (
      entityId: string,
      title: string | undefined,
      origin: "set" | "set-explicit" | "mirror" | "clear"
    ) => void | Promise<void>
  ) => () => void;
  /**
   * Register a listener fired whenever the authoritative panel slot/history tree
   * changes (any client). The panel-tree bridge uses it to re-sync its in-memory
   * mirror and re-broadcast `panel-tree-updated` so every client converges.
   */
  registerSlotStateListener?: (listener: () => void) => () => void;
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
  let serverPanelTreeBridgePromise: Promise<
    (request: import("./services/panelTreeService.js").PanelTreeBridgeRequest) => Promise<unknown>
  > | null = null;
  const getPanelTreeBridge = () => {
    serverPanelTreeBridgePromise ??= createServerPanelTreeBridge(deps);
    return serverPanelTreeBridgePromise;
  };
  const serverCtx: ServiceContext = { caller: createVerifiedCaller("server", "server") };
  const isKnownPanelSlot = async (targetId: string): Promise<boolean> => {
    try {
      const slot = (await deps.dispatcher.dispatch(serverCtx, "workspace-state", "slot.get", [
        targetId,
      ])) as SlotRow | null;
      return Boolean(slot && slot.closed_at == null);
    } catch {
      return false;
    }
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

    container.registerRpc(
      createWorkspaceService({
        workspace,
        treeScanner: deps.treeScanner,
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
        unitDiagnostics: deps.unitDiagnostics,
        bakeAppDist: deps.bakeAppDist,
        listAppVersions: deps.listAppVersions,
        rollbackAppVersion: deps.rollbackAppVersion,
        listRecurringJobs: deps.listRecurringJobs,
        listHostTargetCandidates: deps.listHostTargetCandidates,
        getHostTargetSelection: deps.getHostTargetSelection,
        setHostTargetSelection: deps.setHostTargetSelection,
        clearHostTargetSelection: deps.clearHostTargetSelection,
        listHostTargetVersions: deps.listHostTargetVersions,
        prepareHostTargetPinnedRef: deps.prepareHostTargetPinnedRef,
        launchHostTarget: deps.launchHostTarget,
        beginHostTargetLaunch: deps.beginHostTargetLaunch,
        getHostTargetLaunchSession: deps.getHostTargetLaunchSession,
        resolveHostTargetLaunchSessionApproval: deps.resolveHostTargetLaunchSessionApproval,
        cancelHostTargetLaunchSession: deps.cancelHostTargetLaunchSession,
        hasAppCapability: deps.hasAppCapability,
        approvalQueue: deps.approvalQueue,
      })
    );
  }

  {
    const { PanelHttpServer } = await import("./panelHttpServer.js");
    container.registerManaged({
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
    container.registerManaged({
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
            if (!entry || entry.callerKind !== "shell") return false;
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
          getTargetInfo: async (targetId) => {
            const target = await requestPanelMetadataForServices(targetId);
            if (!target) return null;
            return { kind: target.kind, source: target.source };
          },
          isPanelKnown: isKnownPanelSlot,
          // Keep a CDP-automated panel loaded (and eviction-exempt) on its
          // serving host while ≥1 CDP client is connected to its target.
          onTargetClientPinChange: (targetId, pinned) => {
            if (pinned) deps.panelRuntimeCoordinator?.pinSlotLoaded(targetId);
            else deps.panelRuntimeCoordinator?.unpinSlotLoaded(targetId);
          },
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
    container.registerManaged({
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
          hasAppCapability: deps.hasAppCapability,
          hasApprovalSession: () => shellPresence.internal.isAnyShellActive(),
          getTarget: (panelId) => requestPanelMetadataForServices(panelId),
          getEndpoint: async (panelId, requesterEntityId) => {
            await ensureCdpTargetReady(panelId);
            const endpoint = bridge.getCdpEndpoint(panelId, requesterEntityId);
            if (!endpoint) throw new Error(`CDP endpoint unavailable for panel: ${panelId}`);
            return endpoint;
          },
          drive: async (panelId, requesterEntityId, command, args) => {
            await ensureCdpTargetReady(panelId);
            if (command === "navigate") {
              const url = typeof args[0] === "string" ? args[0] : "";
              if (!url) throw new Error("Panel navigation URL is required");
              return bridge.sendTargetCommand(panelId, requesterEntityId, command, args);
            }
            return bridge.sendTargetCommand(panelId, requesterEntityId, command, args);
          },
          consoleHistory: async (panelId, _requesterEntityId, options) => {
            await ensureCdpTargetReady(panelId);
            return bridge.sendHostCommand(panelId, "consoleHistory", [options ?? {}]) as Promise<
              import("./services/panelCdpService.js").PanelConsoleHistoryResult
            >;
          },
          logAccess: (event) => {
            const message = event.denied ? "Panel CDP access denied" : "Panel CDP access";
            const payload = {
              method: event.method,
              requesterId: event.requesterId,
              requesterKind: event.requesterKind,
              targetId: event.targetId,
              targetKind: event.targetKind,
              targetSource: event.targetSource,
              ...(event.reason ? { reason: event.reason } : {}),
            };
            if (event.denied) log.warn(message, payload);
            else log.info(message, payload);
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
          const coordinator = deps.panelRuntimeCoordinator;
          if (!holder && coordinator) {
            const assign = () =>
              coordinator.ensureDefaultCdpHostForSlot(panelId, runtimeEntityId, {
                isHostAvailable: (hostConnectionId) => bridge.isProviderConnected(hostConnectionId),
              });
            let assigned = assign();
            if (
              !assigned.assigned &&
              assigned.reason === "no_default_cdp_host" &&
              deps.ensureDefaultHeadlessHost
            ) {
              // Renderer of last resort: spawn the headless host and retry once.
              if (await deps.ensureDefaultHeadlessHost()) assigned = assign();
            }
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
    container.registerManaged({
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
          hasAppCapability: deps.hasAppCapability,
          hasApprovalSession: () => shellPresence.internal.isAnyShellActive(),
          bridge: await getPanelTreeBridge(),
        });
      },
      getServiceDefinition() {
        if (!panelTreeDefinition) throw new Error("panelTree service not initialized");
        return panelTreeDefinition;
      },
    });
  }

  container.registerManaged({
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
    const { createFsServiceDefinition } = await import("./services/fsServiceDef.js");
    let fsServiceInstance: import("@natstack/shared/fsService").FsService;
    container.registerManaged({
      name: "fsRpc",
      dependencies: ["fsService"],
      async start(resolve) {
        fsServiceInstance = assertPresent(
          resolve<import("@natstack/shared/fsService").FsService>("fsService")
        );
      },
      getServiceDefinition() {
        return createFsServiceDefinition(() => fsServiceInstance);
      },
    });
  }
}
