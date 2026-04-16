import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import type { Panel, ThemeAppearance } from "@natstack/shared/types";
import type { WorkspaceConfig } from "@natstack/shared/workspace/types";
import { Appearance } from "react-native";
import { WorkspaceClient } from "@natstack/shared/shell/workspaceClient";
import { SettingsClient } from "@natstack/shared/shell/settingsClient";
import { EventsClient } from "@natstack/shared/shell/eventsClient";
import type { PanelManager } from "@natstack/shared/shell/panelManager";
import { createBridgeAdapter } from "./bridgeAdapter";
import { MobileTransport, type ConnectionStatus } from "./mobileTransport";
import { createMobileShellCore } from "../shellCore/createMobileShellCore";

export interface ShellClientConfig {
  serverUrl: string;
  shellToken: string;
  onTreeUpdated?: (tree: Panel[]) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
}

class MobilePanels {
  private panelManager: PanelManager | null = null;
  private registryInstance: PanelRegistry | null = null;
  private bridgeAdapterInstance: ReturnType<typeof createBridgeAdapter> | null = null;

  constructor(
    private readonly deps: {
      serverUrl: string;
      transport: MobileTransport;
      onTreeUpdated?: (tree: Panel[]) => void;
      navigateToPanel: (panelId: string) => void;
    },
  ) {}

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

    const tree = await this.panelManager.loadTree();
    if (tree.rootPanels.length > 0) return;

    const entries = workspaceConfig?.initPanels ?? [];
    for (const entry of [...entries].reverse()) {
      await this.panelManager.create(entry.source, {
        isRoot: true,
        addAsRoot: true,
        stateArgs: entry.stateArgs,
      });
    }

    const nextTree = await this.panelManager.loadTree();
    const firstRoot = nextTree.rootPanels[0];
    if (firstRoot) {
      await this.panelManager.notifyFocused(firstRoot.id);
      this.deps.navigateToPanel(firstRoot.id);
    }
  }

  async refresh(): Promise<void> {
    await this.requireManager().loadTree();
  }

  getTree(): Panel[] {
    return this.registry.getSerializablePanelTree();
  }

  getCollapsedIds(): string[] {
    return this.registry.getCollapsedIds();
  }

  async archive(panelId: string): Promise<void> {
    await this.requireManager().close(panelId);
  }

  async movePanel(panelId: string, newParentId: string | null, targetPosition: number): Promise<void> {
    await this.requireManager().movePanel(panelId, newParentId, targetPosition);
  }

  async createAboutPanel(page: string): Promise<{ id: string; title: string }> {
    const result = await this.requireManager().createAboutPanel(page);
    await this.requireManager().notifyFocused(result.id);
    this.deps.navigateToPanel(result.id);
    return result;
  }

  async createFromSource(
    source: string,
    options?: { name?: string; stateArgs?: Record<string, unknown> },
  ): Promise<{ id: string; title: string }> {
    const result = await this.requireManager().createFromSource(source, options);
    await this.requireManager().notifyFocused(result.id);
    this.deps.navigateToPanel(result.id);
    return result;
  }

  async createChildPanel(
    parentId: string,
    source: string,
    options?: { name?: string; contextId?: string; focus?: boolean; stateArgs?: Record<string, unknown> },
  ): Promise<{ id: string; title: string }> {
    const result = await this.requireManager().create(source, {
      parentId,
      name: options?.name,
      contextId: options?.contextId,
      stateArgs: options?.stateArgs,
    });
    if (options?.focus !== false) {
      await this.requireManager().notifyFocused(result.panelId);
      this.deps.navigateToPanel(result.panelId);
    }
    return { id: result.panelId, title: result.title };
  }

  async setCollapsed(panelId: string, collapsed: boolean): Promise<void> {
    await this.requireManager().setCollapsed(panelId, collapsed);
  }

  async expandIds(panelIds: string[]): Promise<void> {
    await this.requireManager().expandIds(panelIds);
  }

  async notifyFocused(panelId: string): Promise<void> {
    await this.requireManager().notifyFocused(panelId);
  }

  async updateStateArgs(panelId: string, updates: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requireManager().updateStateArgs(panelId, updates);
  }

  async updateTheme(theme: ThemeAppearance): Promise<void> {
    this.requireManager().setCurrentTheme(theme);
  }

  async unload(_panelId: string): Promise<void> {}

  async getPanelInit(panelId: string): Promise<unknown> {
    return this.requireManager().getPanelInit(panelId);
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
  readonly shellToken: string;
  readonly serverUrl: string;

  private statusUnsub: (() => void) | null = null;
  private navigationListeners = new Set<(panelId: string) => void>();
  private periodicSyncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: ShellClientConfig) {
    this.shellToken = config.shellToken;
    this.serverUrl = config.serverUrl;

    this.transport = new MobileTransport({
      serverUrl: config.serverUrl,
      shellToken: config.shellToken,
    });

    if (config.onStatusChange) {
      this.statusUnsub = this.transport.onStatusChange(config.onStatusChange);
    }

    this.panels = new MobilePanels({
      serverUrl: config.serverUrl,
      transport: this.transport,
      onTreeUpdated: config.onTreeUpdated,
      navigateToPanel: (panelId) => {
        for (const listener of this.navigationListeners) listener(panelId);
      },
    });
    this.workspaces = new WorkspaceClient(this.transport);
    this.settings = new SettingsClient(this.transport);
    this.events = new EventsClient(this.transport);
  }

  async init(): Promise<void> {
    this.transport.connect();
    await this.waitForConnection(10_000);
    const info = await this.transport.call<{
      config: WorkspaceConfig;
    }>("main", "workspace.getInfo");
    await this.panels.init(info.config.id, info.config);
  }

  startPeriodicSync(intervalMs = 30_000): void {
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
          reject(new Error("Connection failed"));
        }
      });
    });
  }
}

export type MobilePanelsClient = InstanceType<typeof MobilePanels>;
