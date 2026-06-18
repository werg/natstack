import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import type { Panel, ThemeAppearance } from "@natstack/shared/types";
import type { WorkspaceConfig } from "@natstack/shared/workspace/types";
import { Appearance } from "react-native";
import { WorkspaceClient } from "@natstack/shared/shell/workspaceClient";
import { SettingsClient } from "@natstack/shared/shell/settingsClient";
import { EventsClient } from "@natstack/shared/shell/eventsClient";
import { createRecoveryCoordinator } from "@natstack/shared/shell/recoveryCoordinator";
import type { RecoveryCoordinator } from "@natstack/shared/shell/recoveryCoordinator";
import type { PanelManager } from "@natstack/shared/shell/panelManager";
import type {
  PanelRuntimeLeaseChangedEvent,
  RuntimeLeaseSnapshot,
} from "@natstack/shared/panel/panelLease";
import { asPanelSlotId } from "@natstack/shared/panel/ids";
import {
  getSharedBrowserAddressOptions,
  getSharedPanelAddressOptions,
  type BrowserAddressOptions,
  type PanelAddressOptions,
  type PanelRepoState,
} from "@natstack/shared/panelChrome";
import {
  createBrowserDataRpcClient,
  type BrowserDataClient,
  type RecordHistoryVisitRequest,
  type UpdateHistoryTitleRequest,
} from "@natstack/browser-data/client";
import { createBridgeAdapter, type MobilePanelRuntimeHost } from "./bridgeAdapter";
import { MobileRpcClient, type ConnectionStatus } from "./mobileTransport";
import { createMobileShellCore } from "../shellCore/createMobileShellCore";
import type { Credentials } from "./auth";
import { issueConnectionGrant } from "./auth";
import { drainWorkspaceMutationQueue } from "./backgroundActionQueue";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import { shellApprovalMethods } from "@natstack/shared/serviceSchemas/shellApproval";
import { panelRuntimeMethods } from "@natstack/shared/serviceSchemas/panelRuntime";
import { credentialsMethods } from "@natstack/shared/serviceSchemas/credentials";
import { pushMethods } from "@natstack/shared/serviceSchemas/push";
import { workspaceMethods } from "@natstack/shared/serviceSchemas/workspace";
import { vcsMethods } from "@natstack/shared/serviceSchemas/vcs";
import type { HostTargetLaunchResult } from "@natstack/shared/hostTargets";
import type { PendingUnitBatchApproval } from "@natstack/shared/approvals";

function smokePhase(phase: string, details?: Record<string, unknown>): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[NatStackMobileSmoke] phase=${phase}${suffix}`);
}

export interface ShellClientConfig {
  credentials: Credentials;
  onTreeUpdated?: (tree: Panel[]) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
}
function createShellApprovalClient(transport: MobileRpcClient) {
  return createTypedServiceClient("shellApproval", shellApprovalMethods, (service, method, args) =>
    transport.call("main", `${service}.${method}`, args)
  );
}

function createPanelRuntimeClient(transport: MobileRpcClient) {
  return createTypedServiceClient("panelRuntime", panelRuntimeMethods, (service, method, args) =>
    transport.call("main", `${service}.${method}`, args)
  );
}

function createCredentialsClient(transport: MobileRpcClient) {
  return createTypedServiceClient("credentials", credentialsMethods, (service, method, args) =>
    transport.call("main", `${service}.${method}`, args)
  );
}

function createPushClient(transport: MobileRpcClient) {
  return createTypedServiceClient("push", pushMethods, (service, method, args) =>
    transport.call("main", `${service}.${method}`, args)
  );
}

function createWorkspaceRpcClient(transport: MobileRpcClient) {
  return createTypedServiceClient("workspace", workspaceMethods, (service, method, args) =>
    transport.call("main", `${service}.${method}`, args)
  );
}

function createVcsClient(transport: MobileRpcClient) {
  return createTypedServiceClient("vcs", vcsMethods, (service, method, args) =>
    transport.call("main", `${service}.${method}`, args)
  );
}

type ShellApprovalClient = ReturnType<typeof createShellApprovalClient>;
type PanelRuntimeClient = ReturnType<typeof createPanelRuntimeClient>;
type CredentialsClient = ReturnType<typeof createCredentialsClient>;
type PushClient = ReturnType<typeof createPushClient>;
type WorkspaceRpcClient = ReturnType<typeof createWorkspaceRpcClient>;
type VcsClient = ReturnType<typeof createVcsClient>;
type WorkspaceInfo = Awaited<ReturnType<WorkspaceClient["getInfo"]>>;

export class MobileHostTargetApprovalRequiredError extends Error {
  readonly approvals: PendingUnitBatchApproval[];

  constructor(approvals: PendingUnitBatchApproval[]) {
    super("Approve the workspace mobile app before opening panels.");
    this.name = "MobileHostTargetApprovalRequiredError";
    this.approvals = approvals;
  }
}

function formatHostTargetLaunchUnavailable(
  launch: Extract<HostTargetLaunchResult, { status: "unavailable" }>
): string {
  const details = launch.details.length ? `: ${launch.details.join("; ")}` : "";
  return `${launch.reason || "No launchable mobile workspace app is available"}${details}`;
}

class MobilePanels {
  private panelManager: PanelManager | null = null;
  private registryInstance: PanelRegistry | null = null;
  private bridgeAdapterInstance: ReturnType<typeof createBridgeAdapter> | null = null;
  private readonly panelRuntime: PanelRuntimeClient;
  private readonly browserData: BrowserDataClient;
  private readonly workspaceRpc: WorkspaceRpcClient;
  private readonly vcs: VcsClient;
  constructor(
    private readonly deps: {
      serverUrl: string;
      transport: MobileRpcClient;
      onTreeUpdated?: (tree: Panel[]) => void;
      navigateToPanel: (panelId: string) => void;
      clientSessionId: string;
    }
  ) {
    this.panelRuntime = createPanelRuntimeClient(this.deps.transport);
    this.workspaceRpc = createWorkspaceRpcClient(this.deps.transport);
    this.vcs = createVcsClient(this.deps.transport);
    this.browserData = createBrowserDataRpcClient({
      call: (service: string, method: string, args: unknown[]) =>
        this.deps.transport.call("main", `${service}.${method}`, args),
    });
  }
  get registry(): PanelRegistry {
    if (!this.registryInstance) throw new Error("Panels not initialized");
    return this.registryInstance;
  }
  /**
   * Tree mutations route through the single server authority (panelTree); the
   * mobile mirror updates reactively from the panel-tree-updated broadcast (the
   * UI materializes panels from the tree atom). Mobile connects as a "shell"
   * host, which panelTree's policy allows.
   */
  private callPanelTree<T = unknown>(method: string, args: unknown[]): Promise<T> {
    return this.deps.transport.call("main", `panelTree.${method}`, args) as Promise<T>;
  }
  async init(workspaceId: string, workspaceConfig?: WorkspaceConfig): Promise<void> {
    if (!this.panelManager) {
      const core = createMobileShellCore({
        workspaceId,
        serverUrl: this.deps.serverUrl,
        transport: this.deps.transport,
        onTreeUpdated: this.deps.onTreeUpdated,
      });
      this.panelManager = core.panelManager;
      this.registryInstance = core.registry;
      this.bridgeAdapterInstance = createBridgeAdapter({
        panelManager: core.panelManager,
        registry: core.registry,
        transport: this.deps.transport,
        callbacks: {
          navigateToPanel: this.deps.navigateToPanel,
        },
      });
    }
    const initialTheme = Appearance.getColorScheme() === "light" ? "light" : "dark";
    this.panelManager.setCurrentTheme(initialTheme);
    await this.panelRuntime.registerClient({
      clientSessionId: this.deps.clientSessionId,
      label: "Mobile",
      platform: "mobile",
    });
    const tree = await this.panelManager.syncSnapshot();
    await this.syncRuntimeLeases();
    if (tree.rootPanels.length > 0) return;
    const entries = workspaceConfig?.initPanels ?? [];
    for (const entry of entries) {
      // Root init panel: no parentId ⇒ server creates it as a root.
      await this.callPanelTree("create", [entry.source, { stateArgs: entry.stateArgs }]);
    }
    const nextTree = await this.panelManager.syncSnapshot();
    await this.syncRuntimeLeases();
    const firstRoot = nextTree.rootPanels[0];
    if (firstRoot) {
      await this.panelManager.notifyFocused(asPanelSlotId(firstRoot.id));
      this.deps.navigateToPanel(firstRoot.id);
    }
  }
  async refresh(): Promise<void> {
    await this.requireManager().syncSnapshot();
    await this.syncRuntimeLeases();
  }
  async recoverSnapshot(): Promise<void> {
    await this.requireManager().syncSnapshot();
    await this.syncRuntimeLeases();
  }
  getTree(): Panel[] {
    return this.registry.getSerializablePanelTree();
  }
  getCollapsedIds(): string[] {
    return this.registry.getCollapsedIds();
  }
  async archive(panelId: string): Promise<void> {
    await this.callPanelTree("archive", [panelId]);
  }
  async movePanel(
    panelId: string,
    newParentId: string | null,
    targetPosition: number
  ): Promise<void> {
    await this.callPanelTree("movePanel", [{ panelId, newParentId, targetPosition }]);
  }
  async createAboutPanel(page: string): Promise<{
    id: string;
    title: string;
  }> {
    const result = await this.callPanelTree<{ id: string; title: string }>("create", [
      `about/${page}`,
      { name: `${page}~${Date.now().toString(36)}` },
    ]);
    this.deps.navigateToPanel(result.id);
    return result;
  }
  async createFromSource(
    source: string,
    options?: {
      name?: string;
      stateArgs?: Record<string, unknown>;
    }
  ): Promise<{
    id: string;
    title: string;
  }> {
    const result = await this.callPanelTree<{ id: string; title: string }>("create", [
      source,
      { name: options?.name, stateArgs: options?.stateArgs },
    ]);
    this.deps.navigateToPanel(result.id);
    return result;
  }
  async createChildPanel(
    parentId: string,
    source: string,
    options?: {
      name?: string;
      contextId?: string;
      focus?: boolean;
      ref?: string;
      stateArgs?: Record<string, unknown>;
    }
  ): Promise<{
    id: string;
    title: string;
  }> {
    const result = await this.callPanelTree<{ id: string; title: string }>("create", [
      source,
      { parentId, name: options?.name, ref: options?.ref, stateArgs: options?.stateArgs },
    ]);
    if (options?.focus !== false) this.deps.navigateToPanel(result.id);
    return result;
  }
  async createBrowserUrlPanel(
    parentId: string | null,
    url: string,
    options?: {
      name?: string;
      focus?: boolean;
    }
  ): Promise<{
    id: string;
    title: string;
  }> {
    const result = await this.callPanelTree<{ id: string; title: string }>("create", [
      url,
      { parentId: parentId ?? undefined, name: options?.name },
    ]);
    if (options?.focus !== false) this.deps.navigateToPanel(result.id);
    return result;
  }
  async createRootPanel(
    source: string,
    options?: {
      ref?: string;
    }
  ): Promise<{
    id: string;
    title: string;
  }> {
    const result = await this.callPanelTree<{ id: string; title: string }>("create", [
      source,
      { ref: options?.ref },
    ]);
    this.deps.navigateToPanel(result.id);
    return result;
  }
  async setCollapsed(panelId: string, collapsed: boolean): Promise<void> {
    await this.requireManager().setCollapsed(asPanelSlotId(panelId), collapsed);
  }
  async expandIds(panelIds: string[]): Promise<void> {
    await this.requireManager().expandIds(panelIds.map(asPanelSlotId));
  }
  async notifyFocused(panelId: string): Promise<void> {
    await this.requireManager().notifyFocused(asPanelSlotId(panelId));
  }
  async updateStateArgs(
    panelId: string,
    updates: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.callPanelTree<Record<string, unknown>>("setStateArgs", [panelId, updates]);
  }
  async updateTitle(panelId: string, title: string): Promise<void> {
    await this.requireManager().updateTitle(asPanelSlotId(panelId), title);
    this.deps.onTreeUpdated?.(this.getTree());
  }
  async updateBrowserUrl(panelId: string, url: string): Promise<void> {
    await this.requireManager().replaceCurrentSnapshot(asPanelSlotId(panelId), {
      source: `browser:${url}`,
    });
    this.deps.onTreeUpdated?.(this.getTree());
  }
  async navigatePanel(
    panelId: string,
    source: string,
    options?: {
      ref?: string;
      contextId?: string;
      stateArgs?: Record<string, unknown>;
    }
  ): Promise<{
    id: string;
    title: string;
  }> {
    const result = await this.callPanelTree<{ id?: string; title?: string }>("navigate", [
      panelId,
      source,
      options,
    ]);
    return { id: result?.id ?? panelId, title: result?.title ?? "" };
  }
  async getAddressOptions(source: string, ref?: string): Promise<PanelAddressOptions> {
    return getSharedPanelAddressOptions({
      source,
      ref,
      repoProvider: {
        sourceTree: () => this.workspaceRpc.sourceTree(),
        findUnitForPath: (path) => this.workspaceRpc.findUnitForPath(path),
        unitStatus: async (unitPath) => {
          const status = await this.vcs.unitStatus(unitPath);
          return {
            unitPath: status.unitPath,
            head: status.head,
            stateHash: status.stateHash,
            dirty: status.dirty,
          } satisfies PanelRepoState & { unitPath: string };
        },
      },
    });
  }
  async getBrowserAddressOptions(query: string): Promise<BrowserAddressOptions> {
    return getSharedBrowserAddressOptions({
      query,
      panels: this.getTree(),
      browserData: {
        searchHistoryForAutocomplete: (searchQuery, limit) =>
          this.browserData.history.searchForAutocomplete(searchQuery, limit),
        getHistory: (historyQuery) => this.browserData.history.get(historyQuery),
        searchBookmarks: (searchQuery) => this.browserData.bookmarks.search(searchQuery),
        getSearchEngines: () => this.browserData.searchEngines.getAll(),
      },
    });
  }
  async recordHistoryVisit(request: RecordHistoryVisitRequest): Promise<void> {
    await this.browserData.history.recordVisit(request);
  }
  async updateHistoryTitle(request: UpdateHistoryTitleRequest): Promise<void> {
    await this.browserData.history.updateTitle(request);
  }
  async updateTheme(theme: ThemeAppearance): Promise<void> {
    this.requireManager().setCurrentTheme(theme);
  }
  async unload(_panelId: string): Promise<void> {}
  async getPanelInit(panelId: string): Promise<unknown> {
    return this.requireManager().getPanelInit(asPanelSlotId(panelId));
  }
  async acquireLease(
    panelId: string,
    runtimeEntityId: string,
    opts: { connectionId: string }
  ): Promise<{ acquired: boolean; lease?: { holderLabel: string } }> {
    return this.panelRuntime.acquire(runtimeEntityId, {
      slotId: panelId,
      clientSessionId: this.deps.clientSessionId,
      connectionId: opts.connectionId,
    });
  }
  async takeOverLease(
    panelId: string,
    runtimeEntityId: string,
    opts: { connectionId: string }
  ): Promise<{ acquired: boolean; lease?: { holderLabel: string } }> {
    return this.panelRuntime.takeOver(runtimeEntityId, {
      slotId: panelId,
      clientSessionId: this.deps.clientSessionId,
      connectionId: opts.connectionId,
    });
  }
  applyRuntimeLeaseEvent(event: PanelRuntimeLeaseChangedEvent): void {
    this.registry.applyRuntimeLeaseChanged(event);
    this.deps.onTreeUpdated?.(this.getTree());
  }
  setRuntimeHost(host: MobilePanelRuntimeHost | null): void {
    this.bridgeAdapterInstance?.setRuntimeHost(host);
  }
  async syncRuntimeLeases(): Promise<void> {
    const snapshot = await this.panelRuntime.getSnapshot();
    this.registry.applyRuntimeLeaseSnapshot(snapshot);
    this.deps.onTreeUpdated?.(this.getTree());
  }
  async handleBridgeCall(panelId: string, method: string, args: unknown[]): Promise<unknown> {
    if (!this.bridgeAdapterInstance) throw new Error("Panels not initialized");
    return this.bridgeAdapterInstance.handle(panelId, method, args);
  }
  private requireManager(): PanelManager {
    if (!this.panelManager) throw new Error("Panels not initialized");
    return this.panelManager;
  }
}
export class ShellClient {
  readonly transport: MobileRpcClient;
  readonly panels: MobilePanels;
  readonly workspaces: WorkspaceClient;
  readonly settings: SettingsClient;
  readonly events: EventsClient;
  readonly shellApproval: ShellApprovalClient;
  readonly panelRuntime: PanelRuntimeClient;
  readonly credentialService: CredentialsClient;
  readonly push: PushClient;
  readonly recovery: RecoveryCoordinator;
  readonly credentials: Credentials;
  readonly serverUrl: string;
  private statusUnsub: (() => void) | null = null;
  private navigationListeners = new Set<(panelId: string) => void>();
  private periodicSyncTimer: ReturnType<typeof setInterval> | null = null;
  private panelRecoveryUnsubs: Array<() => void> | null = null;
  private workspaceInfo: WorkspaceInfo | null = null;
  private panelsInitialized = false;
  constructor(config: ShellClientConfig) {
    this.credentials = config.credentials;
    this.serverUrl = config.credentials.serverUrl;
    this.transport = new MobileRpcClient({
      serverUrl: config.credentials.serverUrl,
      issueConnectionGrant,
    });
    if (config.onStatusChange) {
      this.statusUnsub = this.transport.onStatusChange(config.onStatusChange);
    }
    this.recovery = createRecoveryCoordinator();
    this.transport.onRecovery("resubscribe", () => this.recovery.run("resubscribe"));
    this.transport.onRecovery("cold-recover", () => this.recovery.run("cold-recover"));
    this.panels = new MobilePanels({
      serverUrl: config.credentials.serverUrl,
      transport: this.transport,
      onTreeUpdated: config.onTreeUpdated,
      clientSessionId: config.credentials.deviceId,
      navigateToPanel: (panelId) => {
        for (const listener of this.navigationListeners) listener(panelId);
      },
    });
    this.workspaces = new WorkspaceClient(this.transport);
    this.settings = new SettingsClient(this.transport);
    this.events = new EventsClient(this.transport, this.recovery);
    this.shellApproval = createShellApprovalClient(this.transport);
    this.panelRuntime = createPanelRuntimeClient(this.transport);
    this.credentialService = createCredentialsClient(this.transport);
    this.push = createPushClient(this.transport);
    this.transport.on("event:panel:runtimeLeaseChanged", (event) => {
      this.panels.applyRuntimeLeaseEvent(event.payload as PanelRuntimeLeaseChangedEvent);
    });
    // Reflect tree mutations made by ANY client (desktop/terminal/other mobile):
    // the server broadcasts panel-tree-updated after every authoritative change
    // (including the Phase 0 self-heal), so mobile re-syncs its mirror to match.
    this.transport.on("event:panel-tree-updated", () => {
      void this.panels.refresh().catch(() => {});
    });
  }
  async init(): Promise<void> {
    const info = await this.connectWorkspace();
    await this.ensureReactNativeHostTargetReady();
    await this.initPanels(info);
  }

  private async connectWorkspace(): Promise<WorkspaceInfo> {
    if (this.workspaceInfo) return this.workspaceInfo;
    smokePhase("workspace-shell-init-start", { serverUrl: this.serverUrl });
    await this.transport.connectAndWait(null);
    smokePhase("workspace-ws-authenticated");
    const info = await this.workspaces.getInfo();
    smokePhase("workspace-info-loaded", { workspaceId: info.config.id });
    this.workspaceInfo = info;
    return info;
  }

  private async ensureReactNativeHostTargetReady(): Promise<void> {
    const launch = await this.workspaces.launchHostTarget("react-native");
    if (launch.status === "ready") {
      smokePhase("workspace-host-target-ready", {
        target: launch.target,
        appId: launch.appId,
        source: launch.source,
      });
      return;
    }
    if (launch.status === "approval-required") {
      smokePhase("workspace-host-target-approval-required", {
        target: launch.target,
        count: launch.approvals.length,
      });
      throw new MobileHostTargetApprovalRequiredError(launch.approvals);
    }
    throw new Error(formatHostTargetLaunchUnavailable(launch));
  }

  private async initPanels(info: WorkspaceInfo): Promise<void> {
    if (this.panelsInitialized) return;
    await this.panels.init(info.config.id, info.config);
    smokePhase("workspace-panels-initialized");
    await this.events.subscribe("panel:runtimeLeaseChanged");
    await this.events.subscribe("panel-tree-updated");
    await this.panels.syncRuntimeLeases();
    await drainWorkspaceMutationQueue(this);
    this.registerPanelRecoveryHandlers();
    this.panelsInitialized = true;
  }
  startPeriodicSync(intervalMs = 30000): void {
    this.stopPeriodicSync();
    this.periodicSyncTimer = setInterval(() => {
      void this.panels.refresh().catch(() => {});
    }, intervalMs);
  }
  stopPeriodicSync(): void {
    if (this.periodicSyncTimer) {
      clearInterval(this.periodicSyncTimer);
      this.periodicSyncTimer = null;
    }
  }
  reconnect(): void {
    this.transport.reconnect();
  }
  onNavigateToPanel(listener: (panelId: string) => void): () => void {
    this.navigationListeners.add(listener);
    return () => {
      this.navigationListeners.delete(listener);
    };
  }
  async handlePanelBridgeCall(panelId: string, method: string, args: unknown[]): Promise<unknown> {
    return this.panels.handleBridgeCall(panelId, method, args);
  }
  private registerPanelRecoveryHandlers(): void {
    if (this.panelRecoveryUnsubs) return;
    this.panelRecoveryUnsubs = [
      this.recovery.registerResubscribeHandler("mobile-panel-tree", async () => {
        await drainWorkspaceMutationQueue(this);
        await this.panels.refresh();
      }),
      this.recovery.registerColdRecoverHandler("mobile-panel-tree", async () => {
        await drainWorkspaceMutationQueue(this);
        await this.panels.recoverSnapshot();
      }),
    ];
  }
  dispose(): void {
    this.stopPeriodicSync();
    for (const unsubscribe of this.panelRecoveryUnsubs ?? []) unsubscribe();
    this.panelRecoveryUnsubs = null;
    void (async () => {
      await this.panelRuntime.unregisterClient(this.credentials.deviceId).catch(() => {});
      this.transport.disconnect();
    })();
    this.statusUnsub?.();
    this.statusUnsub = null;
  }
}
export type MobilePanelsClient = InstanceType<typeof MobilePanels>;
