import type { PanelRegistry } from "@natstack/shared/panelRegistry";
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
import type { ServerClient } from "../serverClient.js";
import { createElectronLocalViewStateStore } from "./localViewState.js";

export function createElectronShellCore(deps: {
  statePath: string;
  workspaceId: string;
  workspacePath: string;
  allowMissingManifests?: boolean;
  registry: PanelRegistry;
  serverClient: ServerClient;
  gatewayConfig: { serverUrl: string };
  workspaceConfig?: import("@natstack/shared/workspace/types").WorkspaceConfig;
}) {
  const call = <T>(service: string, method: string, args: unknown[]) =>
    deps.serverClient.call(service, method, args) as Promise<T>;

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
    registry: deps.registry,
    workspaceState,
    runtime,
    activationClient: {
      markPanelActive: (panelId) => call<undefined>("presence", "markPanelActive", [panelId]),
    },
    viewState: createElectronLocalViewStateStore(deps.statePath),
    metadataResolver: {
      getPanelMetadata: (source) =>
        call<{ title?: string } | null>("build", "getPanelMetadata", [source]),
    },
    workspacePath: deps.workspacePath,
    allowMissingManifests: deps.allowMissingManifests,
    searchIndex,
    workspaceConfig: deps.workspaceConfig,
    serverInfo: {
      gatewayConfig: deps.gatewayConfig,
    },
    grantConnection: (panelId) => call<{ token: string }>("auth", "grantConnection", [panelId]),
  });

  return {
    panelManager,
    shutdown: () => {},
  };
}
