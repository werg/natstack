import { PanelRegistry } from "@natstack/shared/panelRegistry";
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
import type {
  IndexablePanel,
  PanelSearchIndex,
  PanelSearchResult,
} from "@natstack/shared/panelSearchTypes";
import type { MobileTransport } from "../services/mobileTransport";
import { parseHostConfig } from "../services/panelUrls";
import { createMobileLocalViewStateStore } from "./localViewState";

export function createMobileShellCore(deps: {
  workspaceId: string;
  serverUrl: string;
  transport: MobileTransport;
  onTreeUpdated?: (tree: import("@natstack/shared/types").Panel[]) => void;
}) {
  const registry = new PanelRegistry({ onTreeUpdated: deps.onTreeUpdated });
  const host = parseHostConfig(deps.serverUrl);
  const hostWithPort = `${host.host}${host.port ? `:${host.port}` : ""}`;

  const call = <T>(method: string, args: unknown[]) =>
    deps.transport.call("main", method, args) as Promise<T>;

  const workspaceState: WorkspaceStateClient = {
    listSlots: () => call<SlotRow[]>("workspace-state.slot.list", []),
    getSlot: (slotId) => call<SlotRow | null>("workspace-state.slot.get", [slotId]),
    getSlotHistory: (slotId) => call<SlotHistoryRow[]>("workspace-state.slot.history", [slotId]),
    resolveActiveEntity: (id) =>
      call<EntityRecord | null>("workspace-state.entity.resolveActive", [id]),
    createSlot: (input: SlotCreateInput) => call<void>("workspace-state.slot.create", [input]),
    appendSlotHistory: (slotId, entry: SlotHistoryEntryInput) =>
      call<number>("workspace-state.slot.appendHistory", [slotId, entry]),
    setSlotCurrent: (slotId, entryKey) =>
      call<void>("workspace-state.slot.setCurrent", [slotId, entryKey]),
    updateCurrentStateArgs: (slotId, stateArgs) =>
      call<void>("workspace-state.slot.updateCurrentStateArgs", [slotId, stateArgs]),
    replaceSlotHistory: (slotId, entries, cursor) =>
      call<void>("workspace-state.slot.replaceHistory", [slotId, entries, cursor]),
    setSlotParent: (slotId, parentSlotId) =>
      call<void>("workspace-state.slot.setParent", [slotId, parentSlotId]),
    setSlotPosition: (slotId, positionId) =>
      call<void>("workspace-state.slot.setPosition", [slotId, positionId]),
    moveSlot: (slotId, parentSlotId, positionId) =>
      call<void>("workspace-state.slot.move", [slotId, parentSlotId, positionId]),
    closeSlot: (slotId) => call<void>("workspace-state.slot.close", [slotId]),
  };

  const runtime: RuntimeClient = {
    createEntity: (spec: RuntimeEntityCreateSpec) =>
      call<RuntimeEntityHandle>("runtime.createEntity", [spec]),
    retireEntity: (id) => call<void>("runtime.retireEntity", [{ id }]),
  };

  const searchIndex: PanelSearchIndex = {
    indexPanel: (panel: IndexablePanel) =>
      call<void>("workspace-state.panel.index", [panel]),
    search: (query: string, limit?: number) =>
      call<PanelSearchResult[]>("workspace-state.panel.search", [query, limit]),
    incrementAccessCount: (panelId: string) =>
      call<void>("workspace-state.panel.incrementAccess", [panelId]),
    updateTitle: (panelId: string, title: string) =>
      call<void>("workspace-state.panel.updateTitle", [panelId, title]),
    rebuildIndex: () => call<void>("workspace-state.panel.rebuildIndex", []),
  };

  const panelManager = new PanelManager({
    registry,
    workspaceState,
    runtime,
    searchIndex,
    activationClient: {
      markPanelActive: (panelId) => call<void>("presence.markPanelActive", [panelId]),
    },
    viewState: createMobileLocalViewStateStore(deps.workspaceId),
    workspacePath: "",
    allowMissingManifests: true,
    serverInfo: {
      gatewayConfig: { serverUrl: `${host.protocol}://${hostWithPort}` },
    },
    grantConnection: (panelId) => call<{ token: string }>("auth.grantConnection", [panelId]),
  });

  return {
    registry,
    panelManager,
  };
}
