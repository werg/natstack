import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import type { Panel, ThemeAppearance } from "@natstack/shared/types";
import type { BranchInfo, CommitInfo, WorkspaceNode } from "@natstack/shared/types";
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
} from "@natstack/browser-data";
import { createBridgeAdapter, type MobilePanelRuntimeHost } from "./bridgeAdapter";
import { MobileTransport, type ConnectionStatus } from "./mobileTransport";
import { createMobileShellCore } from "../shellCore/createMobileShellCore";
import type { Credentials } from "./auth";
import { refreshShellToken } from "./auth";
import { drainWorkspaceMutationQueue } from "./backgroundActionQueue";
export interface ShellClientConfig {
  credentials: Credentials;
  onTreeUpdated?: (tree: Panel[]) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
}
class MobilePanels {
  private panelManager: PanelManager | null = null;
  private registryInstance: PanelRegistry | null = null;
  private bridgeAdapterInstance: ReturnType<typeof createBridgeAdapter> | null = null;
  private readonly browserData: BrowserDataClient;
  constructor(
    private readonly deps: {
      serverUrl: string;
      transport: MobileTransport;
      onTreeUpdated?: (tree: Panel[]) => void;
      navigateToPanel: (panelId: string) => void;
      clientSessionId: string;
    }
  ) {
    this.browserData = createBrowserDataRpcClient({
      call: (service, method, args) =>
        this.deps.transport.call("main", `${service}.${method}`, args),
    });
  }
  get registry(): PanelRegistry {
    if (!this.registryInstance) throw new Error("Panels not initialized");
    return this.registryInstance;
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
    await this.deps.transport.call("main", "panelRuntime.registerClient", [
      {
        clientSessionId: this.deps.clientSessionId,
        label: "Mobile",
        platform: "mobile",
      },
    ]);
    const tree = await this.panelManager.syncSnapshot();
    await this.syncRuntimeLeases();
    if (tree.rootPanels.length > 0) return;
    const entries = workspaceConfig?.initPanels ?? [];
    for (const entry of entries) {
      await this.panelManager.create(entry.source, {
        isRoot: true,
        addAsRoot: true,
        stateArgs: entry.stateArgs,
      });
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
    await this.requireManager().close(asPanelSlotId(panelId));
  }
  async movePanel(
    panelId: string,
    newParentId: string | null,
    targetPosition: number
  ): Promise<void> {
    await this.requireManager().movePanel(
      asPanelSlotId(panelId),
      newParentId ? asPanelSlotId(newParentId) : null,
      targetPosition
    );
  }
  async createAboutPanel(page: string): Promise<{
    id: string;
    title: string;
  }> {
    const result = await this.requireManager().createAboutPanel(page);
    await this.requireManager().notifyFocused(asPanelSlotId(result.id));
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
    const result = await this.requireManager().createFromSource(source, options);
    await this.requireManager().notifyFocused(asPanelSlotId(result.id));
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
    const result = await this.requireManager().create(source, {
      parentId: asPanelSlotId(parentId),
      name: options?.name,
      contextId: options?.contextId,
      ref: options?.ref,
      stateArgs: options?.stateArgs,
    });
    if (options?.focus !== false) {
      await this.requireManager().notifyFocused(result.panelId);
      this.deps.navigateToPanel(result.panelId);
    }
    return { id: result.panelId, title: result.title };
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
    const result = await this.requireManager().createBrowser(parentId ? asPanelSlotId(parentId) : null, url, {
      name: options?.name,
      addAsRoot: parentId == null,
    });
    if (options?.focus !== false) {
      await this.requireManager().notifyFocused(result.panelId);
      this.deps.navigateToPanel(result.panelId);
    }
    return { id: result.panelId, title: result.title };
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
    const result = await this.requireManager().create(source, {
      isRoot: true,
      addAsRoot: true,
      ref: options?.ref,
    });
    await this.requireManager().notifyFocused(result.panelId);
    this.deps.navigateToPanel(result.panelId);
    return { id: result.panelId, title: result.title };
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
    return this.requireManager().updateStateArgs(asPanelSlotId(panelId), updates);
  }
  async updateTitle(panelId: string, title: string): Promise<void> {
    await this.requireManager().updateTitle(asPanelSlotId(panelId), title);
    this.deps.onTreeUpdated?.(this.getTree());
  }
  async updateBrowserUrl(panelId: string, url: string): Promise<void> {
    await this.requireManager().replaceCurrentSnapshot(asPanelSlotId(panelId), { source: `browser:${url}` });
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
    const result = await this.requireManager().navigate(asPanelSlotId(panelId), source, options);
    this.deps.onTreeUpdated?.(this.getTree());
    return { id: result.panelId, title: result.title };
  }
  async getAddressOptions(source: string, ref?: string): Promise<PanelAddressOptions> {
    return getSharedPanelAddressOptions({
      source,
      ref,
      git: {
        getWorkspaceTree: () =>
          this.deps.transport.call<{
            children: WorkspaceNode[];
          }>("main", "git.getWorkspaceTree", []),
        findRepoForPath: (path) =>
          this.deps.transport.call<{
            repoPath: string;
            relativePath: string;
          } | null>("main", "git.findRepoForPath", [path]),
        status: (repoPath) =>
          this.deps.transport.call<
            PanelRepoState & {
              repoPath: string;
            }
          >("main", "git.status", [repoPath]),
        listBranches: (repoPath) =>
          this.deps.transport.call<BranchInfo[]>("main", "git.listBranches", [repoPath]),
        listCommits: (repoPath, commitRef, limit) =>
          this.deps.transport.call<CommitInfo[]>("main", "git.listCommits", [
            repoPath,
            commitRef,
            limit,
          ]),
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
    return this.deps.transport.call("main", "panelRuntime.acquire", [
      runtimeEntityId,
      {
        slotId: panelId,
        clientSessionId: this.deps.clientSessionId,
        connectionId: opts.connectionId,
      },
    ]);
  }
  async takeOverLease(
    panelId: string,
    runtimeEntityId: string,
    opts: { connectionId: string }
  ): Promise<{ acquired: boolean; lease?: { holderLabel: string } }> {
    return this.deps.transport.call("main", "panelRuntime.takeOver", [
      runtimeEntityId,
      {
        slotId: panelId,
        clientSessionId: this.deps.clientSessionId,
        connectionId: opts.connectionId,
      },
    ]);
  }
  applyRuntimeLeaseEvent(event: PanelRuntimeLeaseChangedEvent): void {
    this.registry.applyRuntimeLeaseChanged(event);
    this.deps.onTreeUpdated?.(this.getTree());
  }
  setRuntimeHost(host: MobilePanelRuntimeHost | null): void {
    this.bridgeAdapterInstance?.setRuntimeHost(host);
  }
  async syncRuntimeLeases(): Promise<void> {
    const snapshot = await this.deps.transport.call<RuntimeLeaseSnapshot>(
      "main",
      "panelRuntime.getSnapshot",
      []
    );
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
  readonly transport: MobileTransport;
  readonly panels: MobilePanels;
  readonly workspaces: WorkspaceClient;
  readonly settings: SettingsClient;
  readonly events: EventsClient;
  readonly recovery: RecoveryCoordinator;
  readonly credentials: Credentials;
  readonly serverUrl: string;
  private statusUnsub: (() => void) | null = null;
  private navigationListeners = new Set<(panelId: string) => void>();
  private periodicSyncTimer: ReturnType<typeof setInterval> | null = null;
  constructor(config: ShellClientConfig) {
    this.credentials = config.credentials;
    this.serverUrl = config.credentials.serverUrl;
    this.transport = new MobileTransport({
      serverUrl: config.credentials.serverUrl,
      refreshShellToken: async () => (await refreshShellToken(this.credentials)).shellToken,
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
    this.transport.onEvent("event:panel:runtimeLeaseChanged", (_from: string, payload: unknown) => {
      this.panels.applyRuntimeLeaseEvent(payload as PanelRuntimeLeaseChangedEvent);
    });
    this.recovery.registerResubscribeHandler("mobile-panel-tree", async () => {
      await drainWorkspaceMutationQueue(this);
      await this.panels.refresh();
    });
    this.recovery.registerColdRecoverHandler("mobile-panel-tree", async () => {
      await drainWorkspaceMutationQueue(this);
      await this.panels.recoverSnapshot();
    });
  }
  async init(): Promise<void> {
    this.transport.connect();
    await this.waitForConnection(10000);
    const info = await this.transport.call<{
      config: WorkspaceConfig;
    }>("main", "workspace.getInfo", []);
    await this.panels.init(info.config.id, info.config);
    await this.events.subscribe("panel:runtimeLeaseChanged");
    await this.panels.syncRuntimeLeases();
    await drainWorkspaceMutationQueue(this);
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
  dispose(): void {
    this.stopPeriodicSync();
    this.transport.disconnect();
    this.statusUnsub?.();
    this.statusUnsub = null;
  }
  private waitForConnection(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.transport.status === "connected") {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        unsub();
        reject(new Error(`Connection timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const unsub = this.transport.onStatusChange((status) => {
        if (status === "connected") {
          clearTimeout(timeout);
          unsub();
          resolve();
        } else if (status === "disconnected") {
          clearTimeout(timeout);
          unsub();
          const info = this.transport.getLastCloseInfo();
          const detail = info?.reason
            ? `${info.reason} (code ${info.code ?? "?"})`
            : info?.code
              ? `close code ${info.code}`
              : `could not reach ${this.serverUrl} — check LAN / firewall / server running`;
          reject(new Error(`Connection failed: ${detail}`));
        }
      });
    });
  }
}
export type MobilePanelsClient = InstanceType<typeof MobilePanels>;
