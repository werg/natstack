/**
 * Panel-init resolution for the headless host — a port of mobile's
 * createMobileShellCore (workspace/apps/mobile/src/shellCore/) minus the
 * mobile-only pieces: the shared PanelManager over plain RPC delegates,
 * with in-memory view state. getPanelInit() returns the bootstrap config
 * (incl. a fresh single-use auth.grantConnection token — never cache it).
 */
import { PanelRegistry } from "@natstack/shared/panelRegistry";
import { PanelManager } from "@natstack/shared/shell/panelManager";
import type {
  CreatePanelResult,
  NavigatePanelOptions,
} from "@natstack/shared/shell/panelManager";
import { asPanelSlotId, type PanelSlotId } from "@natstack/shared/panel/ids";
import { buildPanelUrl } from "@natstack/shared/panelFactory";
import type { PanelRuntimeAcquireResult } from "@natstack/shared/panel/panelLease";
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
import type { RpcClient } from "@natstack/rpc";

export interface PanelLoadInfo {
  panelUrl: string;
  contextId: string;
  source: string;
  /** Bootstrap payload incl. leaseConnectionId — inject as __natstackPanelInit. */
  panelInit: Record<string, unknown>;
}

export class PanelInitClient {
  private readonly panelManager: PanelManager;

  constructor(
    private readonly rpc: Pick<RpcClient, "call">,
    private readonly serverUrl: string,
    private readonly clientLabel: string,
    private readonly clientSessionId: string
  ) {
    const call = <T>(method: string, args: unknown[]) =>
      rpc.call<T>("main", method, args) as Promise<T>;
    const callVoid = (method: string, args: unknown[]) =>
      call<unknown>(method, args).then(() => undefined);

    const workspaceState: WorkspaceStateClient = {
      listSlots: () => call<SlotRow[]>("workspace-state.slot.list", []),
      getSlot: (slotId) => call<SlotRow | null>("workspace-state.slot.get", [slotId]),
      getSlotHistory: (slotId) => call<SlotHistoryRow[]>("workspace-state.slot.history", [slotId]),
      resolveActiveEntity: (id) =>
        call<EntityRecord | null>("workspace-state.entity.resolveActive", [id]),
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

    this.panelManager = new PanelManager({
      registry: new PanelRegistry({}),
      workspaceState,
      runtime,
      // The headless host never surfaces search UI; keep index ops as no-ops
      // so transient hosting doesn't churn the workspace search state.
      searchIndex: {
        indexPanel: async () => undefined,
        search: async () => [],
        incrementAccessCount: async () => undefined,
        updateTitle: async () => undefined,
        rebuildIndex: async () => undefined,
      },
      viewState: { load: () => ({ collapsedIds: [] }), save: () => undefined },
      metadataResolver: {
        getPanelMetadata: (source) =>
          call<{ title?: string } | null>("build.getPanelMetadata", [source]),
      },
      workspacePath: "",
      allowMissingManifests: true,
      serverInfo: { gatewayConfig: { serverUrl } },
      grantConnection: (entityId) => call<{ token: string }>("auth.grantConnection", [entityId]),
    });
  }

  /**
   * Resolve everything needed to host a panel: URL + bootstrap payload with
   * the lease connectionId merged in. Fetch fresh on every (re)load — the
   * embedded gateway token is single-use.
   */
  async getPanelLoadInfo(slotId: string, leaseConnectionId: string): Promise<PanelLoadInfo> {
    const init = (await this.panelManager.getPanelInit(asPanelSlotId(slotId))) as Record<
      string,
      unknown
    >;
    const source = String(init["sourceRepo"] ?? "");
    const contextId = String(init["contextId"] ?? "");
    if (!source) throw new Error(`panel ${slotId} has no source`);

    const url = new URL(this.serverUrl);
    const basePath = url.pathname.replace(/\/+$/, "");
    const panelUrl = source.startsWith("browser:")
      ? source.slice("browser:".length)
      : buildPanelUrl({
          source,
          contextId,
          ref: undefined,
          gatewayPort: Number.parseInt(url.port, 10) || (url.protocol === "https:" ? 443 : 80),
          externalHost: url.hostname,
          protocol: url.protocol === "https:" ? "https" : "http",
          basePath: basePath === "/" ? "" : basePath,
        });

    return {
      panelUrl,
      contextId,
      source,
      panelInit: {
        ...init,
        leaseConnectionId,
        clientLabel: this.clientLabel,
      },
    };
  }

  async navigatePanel(
    slotId: string,
    source: string,
    options: NavigatePanelOptions | undefined,
    leaseConnectionId: string
  ): Promise<CreatePanelResult> {
    const normalizedSlotId = asPanelSlotId(slotId);
    const result = await this.panelManager.navigate(normalizedSlotId, source, options);
    await this.acquireCurrentPanelLease(normalizedSlotId, slotId, leaseConnectionId);
    return result;
  }

  async navigatePanelHistory(
    slotId: string,
    delta: -1 | 1,
    leaseConnectionId: string
  ): Promise<{ id: string; title: string } | null> {
    const normalizedSlotId = asPanelSlotId(slotId);
    const panel = await this.panelManager.navigateHistory(normalizedSlotId, delta);
    if (!panel) return null;
    await this.acquireCurrentPanelLease(normalizedSlotId, slotId, leaseConnectionId);
    return { id: panel.id, title: panel.title };
  }

  private async acquireCurrentPanelLease(
    normalizedSlotId: PanelSlotId,
    slotId: string,
    leaseConnectionId: string
  ): Promise<void> {
    const runtimeEntityId = await this.panelManager.getCurrentEntityId(normalizedSlotId);
    const acquired = await this.rpc.call<PanelRuntimeAcquireResult>(
      "main",
      "panelRuntime.acquire",
      [
        runtimeEntityId,
        {
          slotId,
          clientSessionId: this.clientSessionId,
          hostConnectionId: this.clientSessionId,
          connectionId: leaseConnectionId,
        },
      ]
    );
    if (!acquired.acquired) {
      throw new Error(
        `Panel ${slotId} is running on ${acquired.lease?.holderLabel ?? "another client"}`
      );
    }
  }
}
