import { PanelRegistry } from "@natstack/shared/panelRegistry";
import { PanelManager } from "@natstack/shared/shell/panelManager";
import type { Panel, PanelTreeSnapshot } from "@natstack/shared/types";
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
import type {
  IndexablePanel,
  PanelSearchIndex,
  PanelSearchResult,
} from "@natstack/shared/panelSearchTypes";
import type { MobileRpcClient } from "../services/mobileTransport";
import { parseHostConfig } from "../services/panelUrls";
import { createMobileLocalViewStateStore } from "./localViewState";

export function createMobileShellCore(deps: {
  workspaceId: string;
  serverUrl: string;
  transport: MobileRpcClient;
  onTreeUpdated?: (tree: Panel[]) => void;
}) {
  const registry = new PanelRegistry({
    onTreeUpdated: (snapshot: PanelTreeSnapshot) => deps.onTreeUpdated?.(snapshot.rootPanels),
  });
  const host = parseHostConfig(deps.serverUrl);
  const hostWithPort = `${host.host}${host.port ? `:${host.port}` : ""}`;
  const serverUrl = `${host.protocol}://${hostWithPort}${host.basePath}`;

  const call = <T>(method: string, args: unknown[]) =>
    deps.transport.call("main", method, args) as Promise<T>;
  const callVoid = (method: string, args: unknown[]) =>
    call<unknown>(method, args).then(() => undefined);

  const workspaceState: WorkspaceStateClient = {
    listSlots: () => call<SlotRow[]>("workspace-state.slot.list", []),
    getSlot: (slotId) => call<SlotRow | null>("workspace-state.slot.get", [slotId]),
    getSlotHistory: (slotId) => call<SlotHistoryRow[]>("workspace-state.slot.history", [slotId]),
    resolveActiveEntity: (id) =>
      call<EntityRecord | null>("workspace-state.entity.resolveActive", [id]),
    resolveSlotByEntity: (entityId) =>
      call<string | null>("workspace-state.slot.resolveByEntity", [entityId]),
    createSlot: (input: SlotCreateInput) => callVoid("workspace-state.slot.create", [input]),
    appendSlotHistory: (slotId, entry: SlotHistoryEntryInput) =>
      call<number>("workspace-state.slot.appendHistory", [slotId, entry]),
    setSlotCurrent: (slotId, entryKey) =>
      callVoid("workspace-state.slot.setCurrent", [slotId, entryKey]),
    updateCurrentStateArgs: (slotId, stateArgs) =>
      callVoid("workspace-state.slot.updateCurrentStateArgs", [slotId, stateArgs]),
    replaceSlotHistory: (slotId, entries, cursor) =>
      callVoid("workspace-state.slot.replaceHistory", [slotId, entries, cursor]),
    setSlotParent: (slotId, parentSlotId) =>
      callVoid("workspace-state.slot.setParent", [slotId, parentSlotId]),
    setSlotPosition: (slotId, positionId) =>
      callVoid("workspace-state.slot.setPosition", [slotId, positionId]),
    moveSlot: (slotId, parentSlotId, positionId) =>
      callVoid("workspace-state.slot.move", [slotId, parentSlotId, positionId]),
    closeSlot: (slotId) => callVoid("workspace-state.slot.close", [slotId]),
  };

  const runtime: RuntimeClient = {
    createEntity: (spec: RuntimeEntityCreateSpec) =>
      call<RuntimeEntityHandle>("runtime.createEntity", [spec]),
    retireEntity: (id) => callVoid("runtime.retireEntity", [{ id }]),
  };

  const searchIndex: PanelSearchIndex = {
    indexPanel: (panel: IndexablePanel) => callVoid("workspace-state.panel.index", [panel]),
    search: (query: string, limit?: number) =>
      call<PanelSearchResult[]>("workspace-state.panel.search", [query, limit]),
    incrementAccessCount: (panelId: string) =>
      callVoid("workspace-state.panel.incrementAccess", [panelId]),
    updateTitle: (panelId: string, title: string) =>
      callVoid("workspace-state.panel.updateTitle", [panelId, title]),
    rebuildIndex: () => callVoid("workspace-state.panel.rebuildIndex", []),
  };

  const panelManager = new PanelManager({
    registry,
    workspaceState,
    runtime,
    searchIndex,
    activationClient: {
      markPanelActive: (panelId) => callVoid("presence.markPanelActive", [panelId]),
    },
    viewState: createMobileLocalViewStateStore(deps.workspaceId),
    metadataResolver: {
      getPanelMetadata: (source) =>
        call<{ title?: string } | null>("build.getPanelMetadata", [source]),
    },
    workspacePath: "",
    allowMissingManifests: true,
    serverInfo: {
      gatewayConfig: { serverUrl },
    },
    grantConnection: (panelId) => call<{ token: string }>("auth.grantConnection", [panelId]),
  });

  return {
    registry,
    panelManager,
  };
}
