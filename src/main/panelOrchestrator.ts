/**
 * PanelOrchestrator — Thin Electron coordinator.
 *
 * Replaces PanelLifecycle on the Electron side. All backend work (tokens,
 * persistence, FS context) goes through server RPCs. This class handles
 * only: server RPC → registry update → view management.
 */

import { createDevLogger } from "@natstack/dev-log";
import type { Panel } from "@natstack/shared/types";
import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import type { TokenManager } from "@natstack/shared/tokenManager";
import type { EventService } from "@natstack/shared/eventsService";
import type { ServerClient } from "./serverClient.js";
import type { PanelManager } from "@natstack/shared/shell/panelManager";
import type {
  BridgePanelManager,
  PanelViewLike,
  PanelHttpServerLike,
  PanelCreateOptions,
} from "@natstack/shared/panelInterfaces";
import type { WorkspaceConfig } from "@natstack/shared/workspace/types";
import {
  buildPanelUrl,
} from "@natstack/shared/panelFactory";
import { getPanelSource, getPanelContextId, getPanelStateArgs } from "@natstack/shared/panel/accessors";

const log = createDevLogger("PanelOrchestrator");

export interface PanelOrchestratorDeps {
  registry: PanelRegistry;
  tokenManager: TokenManager;
  eventService: EventService;
  serverClient: ServerClient;
  shellCore: PanelManager;

  getPanelView?: () => PanelViewLike | null;
  cdpServer: { revokeTokenForPanel(panelId: string): void; unregisterBrowser?(panelId: string): void };
  ccConversationManager?: { endPanelConversations(panelId: string): void };
  panelHttpServer: PanelHttpServerLike;
  externalHost: string;
  protocol: "http" | "https";
  gatewayPort: number;

  /**
   * Send an event to a panel. In IPC mode, this calls
   * webContents.send("natstack:event", event, payload).
   */
  sendPanelEvent: (panelId: string, event: string, payload: unknown) => void;
  workspaceConfig?: WorkspaceConfig;
}

export class PanelOrchestrator implements BridgePanelManager {
  private readonly deps: PanelOrchestratorDeps;
  private currentTheme: "light" | "dark" = "dark";

  constructor(deps: PanelOrchestratorDeps) {
    this.deps = deps;
  }

  // Convenience accessors
  private get registry() { return this.deps.registry; }
  private get tokenManager() { return this.deps.tokenManager; }
  private get eventService() { return this.deps.eventService; }
  private get serverClient() { return this.deps.serverClient; }
  private get shellCore() { return this.deps.shellCore; }
  private get externalHost() { return this.deps.externalHost; }
  private getPanelView() { return this.deps.getPanelView?.() ?? null; }
  private get panelHttpServer() { return this.deps.panelHttpServer; }
  private get cdpServer() { return this.deps.cdpServer; }
  private get ccConversationManager() { return this.deps.ccConversationManager; }
  private get workspaceConfig() { return this.deps.workspaceConfig; }

  // =========================================================================
  // Panel creation
  // =========================================================================

  async createPanel(
    callerId: string,
    source: string,
    options?: PanelCreateOptions,
    stateArgs?: Record<string, unknown>,
  ): Promise<{ id: string; title: string }> {
    const caller = this.registry.getPanel(callerId);
    if (!caller) throw new Error(`Caller panel not found: ${callerId}`);

    const result = await this.shellCore.create(source, {
      parentId: callerId,
      ...options,
      stateArgs,
    });

    try {
      // Mint local Electron token
      this.tokenManager.createToken(result.panelId, "panel");

      if (options?.focus) {
        this.focusPanel(result.panelId);
      }

      const panelUrl = this.getPanelUrlForId(result.panelId);
      const view = this.getPanelView();
      if (panelUrl && view) {
        await view.createViewForPanel(result.panelId, panelUrl, result.contextId);
      }

      // Update build state from cache
      const buildCached = this.panelHttpServer?.hasBuild(result.source) ?? false;
      this.registry.updateArtifacts(result.panelId, {
        htmlPath: panelUrl ?? undefined,
        buildState: buildCached ? "ready" : "building",
        buildProgress: buildCached ? undefined : "Waiting for build...",
      });
      this.registry.notifyPanelTreeUpdate();

      return { id: result.panelId, title: result.title };
    } catch (err) {
      await this.shellCore.close(result.panelId).catch(() => {});
      this.tokenManager.revokeToken(result.panelId);
      throw err;
    }
  }

  /**
   * Create a root panel from an arbitrary source path.
   * Unlike createAboutPanel (which prefixes with "about/"), this method
   * uses the source string as-is, making it suitable for mobile shells
   * that need to create panels from any source.
   */
  async createRootPanel(
    source: string,
    options?: { name?: string; isRoot?: boolean },
  ): Promise<{ id: string; title: string }> {
    const name = options?.name ?? `${source.replace(/\//g, "-")}~${Date.now().toString(36)}`;

    const result = await this.shellCore.create(source, {
      name,
      isRoot: options?.isRoot ?? true,
      addAsRoot: true,
    });
    try {
      this.tokenManager.createToken(result.panelId, "panel");

      this.focusPanel(result.panelId);

      const panelUrl = this.getPanelUrlForId(result.panelId);
      const view = this.getPanelView();
      if (panelUrl && view) {
        await view.createViewForPanel(result.panelId, panelUrl, result.contextId);
      }

      this.registry.notifyPanelTreeUpdate();
      return { id: result.panelId, title: result.title };
    } catch (error) {
      await this.shellCore.close(result.panelId).catch(() => {});
      this.tokenManager.revokeToken(result.panelId);
      throw error;
    }
  }

  async createAboutPanel(page: string): Promise<{ id: string; title: string }> {
    const result = await this.shellCore.createAboutPanel(page);
    try {
      this.tokenManager.createToken(result.id, "panel");

      this.focusPanel(result.id);

      const panelUrl = this.getPanelUrlForId(result.id);
      const view = this.getPanelView();
      if (panelUrl && view) {
        const panel = this.registry.getPanel(result.id);
        await view.createViewForPanel(result.id, panelUrl, panel ? getPanelContextId(panel) : undefined);
      }

      this.registry.notifyPanelTreeUpdate();
      return result;
    } catch (error) {
      await this.shellCore.close(result.id).catch(() => {});
      this.tokenManager.revokeToken(result.id);
      throw error;
    }
  }

  async createInitPanel(
    source: string,
    stateArgs?: Record<string, unknown>,
  ): Promise<{ id: string; title: string }> {
    const result = await this.shellCore.create(source, {
      isRoot: true,
      addAsRoot: true,
      stateArgs,
    });
    try {
      this.tokenManager.createToken(result.panelId, "panel");

      const panelUrl = this.getPanelUrlForId(result.panelId);
      const view = this.getPanelView();
      if (panelUrl && view) {
        await view.createViewForPanel(result.panelId, panelUrl, result.contextId);
      }

      this.registry.notifyPanelTreeUpdate();
      return { id: result.panelId, title: result.title };
    } catch (error) {
      await this.shellCore.close(result.panelId).catch(() => {});
      this.tokenManager.revokeToken(result.panelId);
      throw error;
    }
  }

  async createBrowserPanel(
    callerId: string,
    url: string,
    options?: { name?: string; focus?: boolean },
  ): Promise<{ id: string; title: string }> {
    // Defensive: reject non-string or non-http(s) URLs early
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      throw new Error(`Invalid browser panel URL (must be http/https string): ${String(url)}`);
    }

    const callerPanel = this.registry.getPanel(callerId);
    const parentId = callerPanel ? callerId : null;
    let createdPanelId: string | null = null;

    try {
      const result = await this.shellCore.createBrowser(parentId, url, {
        name: options?.name,
        addAsRoot: parentId == null,
      });
      createdPanelId = result.panelId;
      this.tokenManager.createToken(result.panelId, "panel");

      if (options?.focus) {
        this.focusPanel(result.panelId);
      }

      const view = this.getPanelView();
      if (view?.createViewForBrowser) {
        await view.createViewForBrowser(result.panelId, url, result.contextId);
      }
      this.registry.notifyPanelTreeUpdate();

      return { id: result.panelId, title: result.title };
    } catch (err) {
      if (createdPanelId) {
        await this.shellCore.close(createdPanelId).catch(() => {});
        this.tokenManager.revokeToken(createdPanelId);
      }
      throw err;
    }
  }

  // =========================================================================
  // Panel destruction
  // =========================================================================

  async closePanel(panelId: string): Promise<void> {
    const panel = this.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);

    // Determine sibling to focus before removal
    const parentId = this.registry.findParentId(panelId);
    const parent = parentId ? this.registry.getPanel(parentId) : null;
    let siblingToFocus: string | null = null;
    if (parent && parent.selectedChildId === panelId) {
      const siblings = parent.children.filter((c) => c.id !== panelId);
      siblingToFocus = siblings.length > 0 ? siblings[siblings.length - 1]!.id : parentId;
    }

    // Server handles recursive close + resource cleanup
    const { closedIds } = await this.shellCore.close(panelId);

    // Destroy views and remove from in-memory tree
    for (const id of closedIds) {
      this.unloadPanelResources(id);
      this.registry.removePanel(id);
    }

    if (siblingToFocus) {
      this.eventService.emit("navigate-to-panel", { panelId: siblingToFocus });
    }
  }

  async closeChild(callerId: string, childId: string): Promise<void> {
    const parentId = this.registry.findParentId(childId);
    if (parentId !== callerId) {
      throw new Error(`Panel ${callerId} is not the parent of ${childId}`);
    }
    await this.closePanel(childId);
  }

  // =========================================================================
  // Build lifecycle
  // =========================================================================

  async reloadPanel(panelId: string): Promise<void> {
    const view = this.getPanelView();
    if (view?.hasView(panelId)) {
      view.reloadView(panelId);
    } else {
      await this.rebuildUnloadedPanel(panelId);
    }
  }

  async rebuildUnloadedPanel(panelId: string): Promise<void> {
    const panel = this.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);
    if (panel.artifacts?.buildState !== "pending") return;

    // Ensure tokens
    this.tokenManager.ensureToken(panelId, "panel");
    await this.shellCore.getPanelInit(panelId);

    // Browser panels: skip build
    if (getPanelSource(panel).startsWith("browser:")) {
      const url = getPanelSource(panel).slice("browser:".length);
      const view = this.getPanelView();
      if (view?.createViewForBrowser) {
        await view.createViewForBrowser(panelId, url, getPanelContextId(panel));
      }
      this.registry.updateArtifacts(panelId, { buildState: "ready" });
      this.registry.notifyPanelTreeUpdate();
      return;
    }

    this.registry.updateArtifacts(panelId, {
      buildState: "building",
      buildProgress: "Rebuilding panel...",
    });
    this.registry.notifyPanelTreeUpdate();

    this.panelHttpServer?.invalidateBuild(getPanelSource(panel));

    const panelUrl = this.getPanelUrlForId(panelId);
    const view = this.getPanelView();
    if (panelUrl && view) {
      await view.createViewForPanel(panelId, panelUrl, getPanelContextId(panel));
    }
  }

  invalidateReadyPanels(): void {
    const focusedPanelId = this.registry.getFocusedPanelId();
    let focusedWasReset = false;

    for (const entry of this.registry.listPanels()) {
      const panel = this.registry.getPanel(entry.panelId);
      if (!panel) continue;
      const buildState = panel.artifacts?.buildState;
      if (buildState === "ready" || buildState === "error") {
        if (getPanelSource(panel).startsWith("browser:")) continue;
        this.panelHttpServer?.invalidateBuild(getPanelSource(panel));
        this.unloadPanelResources(entry.panelId);
        this.registry.updateArtifacts(entry.panelId, {
          buildState: "pending",
          buildProgress: "Build cache cleared - will rebuild when focused",
        });
        if (entry.panelId === focusedPanelId) focusedWasReset = true;
      }
    }

    this.registry.notifyPanelTreeUpdate();
    if (focusedWasReset && focusedPanelId) {
      void this.rebuildUnloadedPanel(focusedPanelId).catch((e) =>
        console.warn(`[PanelOrchestrator] Failed to rebuild ${focusedPanelId}:`, e));
    }
  }

  async retryBuild(panelId: string): Promise<void> {
    await this.rebuildUnloadedPanel(panelId);
  }

  async initializeGitRepo(panelId: string): Promise<void> {
    await this.rebuildUnloadedPanel(panelId);
  }

  // =========================================================================
  // Bootstrap config
  // =========================================================================

  async getBootstrapConfig(callerId: string): Promise<unknown> {
    return this.shellCore.getPanelInit(callerId);
  }

  // =========================================================================
  // State mutation
  // =========================================================================

  async handleSetStateArgs(
    panelId: string,
    updates: Record<string, unknown>,
  ): Promise<unknown> {
    const validated = await this.shellCore.updateStateArgs(panelId, updates);
    this.registry.updateStateArgs(panelId, validated as Record<string, unknown>);
    return validated;
  }

  async updatePanelContext(panelId: string, contextId: string, source?: string, stateArgs?: Record<string, unknown>): Promise<void> {
    await this.shellCore.updateContext(panelId, {
      contextId,
      ...(source !== undefined && { source }),
      ...(stateArgs !== undefined && { stateArgs }),
    });
  }

  async updatePanelTitle(panelId: string, title: string): Promise<void> {
    await this.shellCore.updateTitle(panelId, title);
  }

  /** Generic server RPC call — exposes server access without leaking serverClient reference. */
  callServer(service: string, method: string, args: unknown[]): Promise<unknown> {
    return this.serverClient.call(service, method, args);
  }

  // =========================================================================
  // Focus
  // =========================================================================

  focusPanel(targetPanelId: string): void {
    const panel = this.registry.getPanel(targetPanelId);
    if (!panel) {
      log.warn(`Cannot focus panel - not found: ${targetPanelId}`);
      return;
    }

    this.registry.updateSelectedPath(targetPanelId);
    this.registry.notifyPanelTreeUpdate();

    // Persist to server
    void this.shellCore.notifyFocused(targetPanelId).catch(() => {});

    if (this.getPanelView()?.hasView(targetPanelId)) {
      this.sendPanelEvent(targetPanelId, { type: "focus" });
    }

    this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
  }

  // =========================================================================
  // Tree initialization
  // =========================================================================

  async initializePanelTree(): Promise<void> {
    await this.shellCore.loadTree();

    const roots = this.registry.getRootPanels();
    if (roots.length > 0) {
      // Mark restored panels as unloaded (they rebuild on focus)
      for (const entry of this.registry.listPanels()) {
        const panel = this.registry.getPanel(entry.panelId);
        if (panel) {
          const hasBuildArtifacts = Boolean(panel.artifacts?.htmlPath || panel.artifacts?.bundlePath);
          if (panel.artifacts?.buildState !== "pending" || hasBuildArtifacts) {
            this.registry.updateArtifacts(entry.panelId, {
              buildState: "pending",
              buildProgress: "Panel unloaded - will rebuild when focused",
            });
          }
        }
      }
      this.registry.notifyPanelTreeUpdate();
    } else {
      const entries = this.workspaceConfig?.initPanels;
      log.info(`[initializePanelTree] No existing roots. initPanels config:`, JSON.stringify(entries));
      if (entries && entries.length > 0) {
        for (const entry of [...entries].reverse()) {
          try {
            log.info(`[initializePanelTree] Creating init panel: ${entry.source}`);
            await this.createInitPanel(entry.source, entry.stateArgs);
          } catch (err) {
            console.error(`[PanelOrchestrator] Failed to create init panel ${entry.source}:`, err);
          }
        }
      }
      const newRoots = this.registry.getRootPanels();
      if (newRoots.length > 0) {
        this.focusPanel(newRoots[0]!.id);
      }
      this.registry.notifyPanelTreeUpdate();
    }
  }

  // =========================================================================
  // Theme
  // =========================================================================

  setCurrentTheme(theme: "light" | "dark"): void {
    this.currentTheme = theme;
    this.shellCore.setCurrentTheme(theme);
    this.registry.setCurrentTheme(theme);
  }

  broadcastTheme(theme: "light" | "dark"): void {
    for (const entry of this.registry.listPanels()) {
      if (this.getPanelView()?.hasView(entry.panelId)) {
        this.deps.sendPanelEvent(entry.panelId, "runtime:theme", { theme });
      }
    }
  }

  // =========================================================================
  // Queries
  // =========================================================================

  getInfo(panelId: string): unknown {
    return this.registry.getInfo(panelId);
  }

  listPanels() {
    return this.registry.listPanels();
  }

  // =========================================================================
  // Panel operations
  // =========================================================================

  async unloadPanel(panelId: string): Promise<void> {
    const panel = this.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);

    this.unloadPanelTree(panelId);
    this.registry.notifyPanelTreeUpdate();
  }

  // =========================================================================
  // WS event helpers
  // =========================================================================

  sendPanelEvent(panelId: string, payload: unknown): void {
    const data = payload as Record<string, unknown>;
    if (data["type"] === "focus") {
      this.deps.sendPanelEvent(panelId, "runtime:focus", null);
    } else if (data["type"] === "theme") {
      this.deps.sendPanelEvent(panelId, "runtime:theme", { theme: data["theme"] });
    } else if (data["type"] === "child-created") {
      this.deps.sendPanelEvent(panelId, "runtime:child-created", { childId: data["childId"], url: data["url"] });
    } else if (data["type"] === "child-creation-error") {
      this.deps.sendPanelEvent(panelId, "runtime:child-creation-error", { url: data["url"], error: data["error"] });
    }
  }

  // =========================================================================
  // Persistence delegation (server-first)
  // =========================================================================

  async movePanel(panelId: string, newParentId: string | null, targetPosition: number): Promise<void> {
    await this.shellCore.movePanel(panelId, newParentId, targetPosition);
  }

  async setCollapsed(panelId: string, collapsed: boolean): Promise<void> {
    await this.shellCore.setCollapsed(panelId, collapsed);
  }

  async expandIds(panelIds: string[]): Promise<void> {
    await this.shellCore.expandIds(panelIds);
  }

  async getCollapsedIds(): Promise<string[]> {
    return this.shellCore.getCollapsedIds();
  }

  persistFocusedPath(panelId: string): void {
    void this.shellCore.notifyFocused(panelId).catch(() => {});
  }

  // =========================================================================
  // URL helpers
  // =========================================================================

  getPanelUrl(panelId: string): string | null {
    return this.getPanelUrlForId(panelId);
  }

  private getPanelUrlForId(panelId: string): string | null {
    const panel = this.registry.getPanel(panelId);
    if (!panel) return null;

    const source = getPanelSource(panel);
    if (source.startsWith("browser:")) {
      return source.slice("browser:".length);
    }

    return buildPanelUrl({
      source,
      contextId: getPanelContextId(panel),
      panelHttpPort: this.deps.gatewayPort,
      externalHost: this.externalHost,
      protocol: this.deps.protocol,
    });
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private unloadPanelResources(panelId: string): void {
    // Close open file handles (skip for browser panels)
    // Note: FS handles are managed server-side, but local cleanup still needed

    // Revoke local auth token
    this.tokenManager.revokeToken(panelId);

    // CDP cleanup
    this.cdpServer?.revokeTokenForPanel(panelId);

    // Claude Agent conversation cleanup
    this.ccConversationManager?.endPanelConversations(panelId);

    // Destroy view
    const view = this.getPanelView();
    if (view?.hasView(panelId)) {
      view.destroyView(panelId);
    }
  }

  private unloadPanelTree(panelId: string): void {
    const panel = this.registry.getPanel(panelId);
    if (!panel) return;

    for (const child of panel.children) {
      this.unloadPanelTree(child.id);
    }

    this.unloadPanelResources(panelId);

    const hasBuildArtifacts = Boolean(panel.artifacts?.htmlPath || panel.artifacts?.bundlePath);
    if (panel.artifacts?.buildState === "pending" && !hasBuildArtifacts) return;

    this.registry.updateArtifacts(panelId, {
      buildState: "pending",
      buildProgress: "Panel unloaded - will rebuild when focused",
    });
  }
}
