/**
 * PanelOrchestrator — Thin Electron coordinator.
 *
 * Replaces PanelLifecycle on the Electron side. All backend work (tokens,
 * persistence, FS context) goes through server RPCs. This class handles
 * only: server RPC → registry update → view management.
 */

import { createDevLogger } from "@natstack/dev-log";
import type { Panel } from "../shared/types.js";
import type { PanelRegistry } from "../shared/panelRegistry.js";
import type { TokenManager } from "../shared/tokenManager.js";
import type { EventService } from "../shared/eventsService.js";
import type { ServerClient } from "./serverClient.js";
import type {
  BridgePanelManager,
  PanelViewLike,
  PanelHttpServerLike,
  PanelCreateOptions,
} from "../shared/panelInterfaces.js";
import type { WorkspaceConfig } from "../shared/workspace/types.js";
import {
  buildBootstrapConfig,
  buildPanelFromResult,
  buildPanelUrl,
  type PanelCreateResult,
} from "../shared/panelFactory.js";
import { getPanelSource, getPanelContextId, getPanelStateArgs } from "../shared/panel/accessors.js";

const log = createDevLogger("PanelOrchestrator");

export interface PanelOrchestratorDeps {
  registry: PanelRegistry;
  tokenManager: TokenManager;
  eventService: EventService;
  serverClient: ServerClient;

  getPanelView?: () => PanelViewLike | null;
  cdpServer: { revokeTokenForPanel(panelId: string): void; unregisterBrowser?(panelId: string): void };
  ccConversationManager?: { endPanelConversations(panelId: string): void };
  panelHttpServer: PanelHttpServerLike;
  externalHost: string;
  protocol: "http" | "https";
  gatewayPort: number;

  sendToClient: (callerId: string, msg: unknown) => void;
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
  private get externalHost() { return this.deps.externalHost; }
  private getPanelView() { return this.deps.getPanelView?.() ?? null; }
  private get panelHttpServer() { return this.deps.panelHttpServer; }
  private get cdpServer() { return this.deps.cdpServer; }
  private get ccConversationManager() { return this.deps.ccConversationManager; }
  private get sendToClient() { return this.deps.sendToClient; }
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

    const result = await this.serverClient.call("panel", "create", [
      source,
      { parentId: callerId, ...options, stateArgs },
    ]) as PanelCreateResult;

    // Guard against concurrent duplicate creates
    if (!this.registry.reservePanelId(result.panelId)) {
      throw new Error(`A panel with id "${result.panelId}" is already running`);
    }

    try {
      const panel = buildPanelFromResult(result, callerId);
      this.registry.addPanel(panel, callerId);

      // Mint local Electron token
      this.tokenManager.createToken(result.panelId, "panel");

      if (options?.focus) {
        this.focusPanel(panel.id);
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
      // Compensate: server already persisted
      await this.serverClient.call("panel", "close", [result.panelId]).catch(() => {});
      this.registry.removePanel(result.panelId);
      this.tokenManager.revokeToken(result.panelId);
      throw err;
    } finally {
      this.registry.releasePanelId(result.panelId);
    }
  }

  async createAboutPanel(page: string): Promise<{ id: string; title: string }> {
    const source = `about/${page}`;
    const name = `${page}~${Date.now().toString(36)}`;

    const result = await this.serverClient.call("panel", "create", [
      source,
      { name, isRoot: true, addAsRoot: true },
    ]) as PanelCreateResult;

    const panel = buildPanelFromResult(result, null);
    this.registry.addPanel(panel, null, { addAsRoot: true });
    this.tokenManager.createToken(result.panelId, "panel");

    this.focusPanel(panel.id);

    const panelUrl = this.getPanelUrlForId(result.panelId);
    const view = this.getPanelView();
    if (panelUrl && view) {
      await view.createViewForPanel(result.panelId, panelUrl, result.contextId);
    }

    this.registry.notifyPanelTreeUpdate();
    return { id: result.panelId, title: result.title };
  }

  async createInitPanel(
    source: string,
    stateArgs?: Record<string, unknown>,
  ): Promise<{ id: string; title: string }> {
    const result = await this.serverClient.call("panel", "create", [
      source,
      { isRoot: true, addAsRoot: true, stateArgs },
    ]) as PanelCreateResult;

    const panel = buildPanelFromResult(result, null);
    this.registry.addPanel(panel, null, { addAsRoot: true });
    this.tokenManager.createToken(result.panelId, "panel");

    const panelUrl = this.getPanelUrlForId(result.panelId);
    const view = this.getPanelView();
    if (panelUrl && view) {
      await view.createViewForPanel(result.panelId, panelUrl, result.contextId);
    }

    this.registry.notifyPanelTreeUpdate();
    return { id: result.panelId, title: result.title };
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

    const result = await this.serverClient.call("panel", "createBrowser", [
      parentId, url, options,
    ]) as PanelCreateResult;

    if (!this.registry.reservePanelId(result.panelId)) {
      throw new Error(`A panel with id "${result.panelId}" is already running`);
    }

    try {
      const panel = buildPanelFromResult(result, parentId);
      if (parentId) {
        this.registry.addPanel(panel, parentId);
      } else {
        this.registry.addPanel(panel, null, { addAsRoot: true });
      }
      this.tokenManager.createToken(result.panelId, "panel");

      if (options?.focus) {
        this.focusPanel(panel.id);
      }

      const view = this.getPanelView();
      if (view?.createViewForBrowser) {
        await view.createViewForBrowser(result.panelId, url, result.contextId);
      }
      this.registry.notifyPanelTreeUpdate();

      return { id: result.panelId, title: result.title };
    } catch (err) {
      await this.serverClient.call("panel", "close", [result.panelId]).catch(() => {});
      this.registry.removePanel(result.panelId);
      this.tokenManager.revokeToken(result.panelId);
      throw err;
    } finally {
      this.registry.releasePanelId(result.panelId);
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
    const { closedIds } = await this.serverClient.call("panel", "close", [panelId]) as { closedIds: string[] };

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
    await this.serverClient.call("panel", "getCredentials", [panelId]);

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
    const panel = this.registry.getPanel(callerId);
    if (!panel) throw new Error(`Panel not found: ${callerId}`);

    const creds = await this.serverClient.call("panel", "getCredentials", [callerId]) as {
      serverRpcToken: string;
      gitToken: string;
      gitConfig: { serverUrl: string; token: string };
      pubsubConfig: { serverUrl: string; token: string };
      rpcPort: number;
      workerdPort: number;
      gitBaseUrl: string;
    };

    // Local Electron token (different issuer than server)
    const rpcToken = this.tokenManager.ensureToken(callerId, "panel");
    const parentId = this.registry.findParentId(callerId);
    const stateArgs = getPanelStateArgs(panel) ?? {};
    const env = panel.snapshot.options.env ?? {};

    return buildBootstrapConfig({
      panelId: callerId,
      contextId: getPanelContextId(panel),
      source: getPanelSource(panel),
      parentId,
      theme: this.currentTheme,
      rpcPort: creds.rpcPort,
      rpcToken,
      serverRpcPort: creds.rpcPort,
      serverRpcToken: creds.serverRpcToken,
      gitToken: creds.gitToken,
      gitBaseUrl: creds.gitBaseUrl,
      workerdPort: creds.workerdPort,
      externalHost: this.externalHost,
      protocol: this.deps.protocol,
      gatewayPort: this.deps.gatewayPort,
      env: env as Record<string, string>,
      stateArgs: stateArgs as Record<string, unknown>,
    });
  }

  // =========================================================================
  // State mutation
  // =========================================================================

  async handleSetStateArgs(
    panelId: string,
    updates: Record<string, unknown>,
  ): Promise<unknown> {
    const validated = await this.serverClient.call("panel", "updateStateArgs", [panelId, updates]);
    this.registry.updateStateArgs(panelId, validated as Record<string, unknown>);

    if (this.sendToClient) {
      this.sendToClient(panelId, {
        type: "ws:event",
        event: "stateArgs:updated",
        payload: validated,
      });
    }

    return validated;
  }

  async updatePanelContext(panelId: string, contextId: string, source?: string, stateArgs?: Record<string, unknown>): Promise<void> {
    await this.serverClient.call("panel", "updateContext", [panelId, {
      contextId,
      ...(source !== undefined && { source }),
      ...(stateArgs !== undefined && { stateArgs }),
    }]);
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
    void this.serverClient.call("panel", "updateSelectedPath", [targetPanelId]).catch(() => {});

    if (this.getPanelView()?.hasView(targetPanelId)) {
      this.sendPanelEvent(targetPanelId, { type: "focus" });
    }

    this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
  }

  // =========================================================================
  // Tree initialization
  // =========================================================================

  async initializePanelTree(): Promise<void> {
    // Load tree + collapsed IDs from server in one call
    const { rootPanels, collapsedIds } = await this.serverClient.call("panel", "loadTree", []) as {
      rootPanels: Panel[];
      collapsedIds: string[];
    };
    this.registry.populateFromServer(rootPanels, collapsedIds);

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
    this.registry.setCurrentTheme(theme);
  }

  broadcastTheme(theme: "light" | "dark"): void {
    for (const entry of this.registry.listPanels()) {
      if (this.getPanelView()?.hasView(entry.panelId)) {
        this.sendPanelEvent(entry.panelId, { type: "theme", theme });
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
    if (!this.sendToClient) return;
    this.sendToClient(panelId, {
      type: "ws:event",
      event: "panel:event",
      payload: { panelId, ...payload as Record<string, unknown> },
    });
  }

  // =========================================================================
  // Persistence delegation (server-first)
  // =========================================================================

  async movePanel(panelId: string, newParentId: string | null, targetPosition: number): Promise<void> {
    await this.serverClient.call("panel", "movePanel", [panelId, newParentId, targetPosition]);
    this.registry.movePanel(panelId, newParentId, targetPosition);
  }

  async setCollapsed(panelId: string, collapsed: boolean): Promise<void> {
    await this.serverClient.call("panel", "setCollapsed", [panelId, collapsed]);
  }

  async expandIds(panelIds: string[]): Promise<void> {
    await this.serverClient.call("panel", "setCollapsedBatch", [panelIds, false]);
  }

  async getCollapsedIds(): Promise<string[]> {
    return this.serverClient.call("panel", "getCollapsedIds", []) as Promise<string[]>;
  }

  persistFocusedPath(panelId: string): void {
    void this.serverClient.call("panel", "updateSelectedPath", [panelId]).catch(() => {});
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
    const panel = this.registry.getPanel(panelId);
    if (!panel) return;

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
