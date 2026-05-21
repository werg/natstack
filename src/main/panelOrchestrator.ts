/**
 * PanelOrchestrator — Thin Electron coordinator.
 *
 * Replaces PanelLifecycle on the Electron side. All backend work (tokens,
 * persistence, FS context) goes through server RPCs. This class handles
 * only: server RPC → registry update → view management.
 */

import { createDevLogger } from "@natstack/dev-log";
import { randomUUID } from "crypto";
import type {
  PanelFocusResult,
  PanelRecoverySnapshot,
  PanelSnapshot,
} from "@natstack/shared/types";
import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import type { EventService } from "@natstack/shared/eventsService";
import type { ServerClient } from "./serverClient.js";
import type { PanelManager } from "@natstack/shared/shell/panelManager";
import type {
  PanelRuntimeLeaseChangedEvent,
  RuntimeLeaseSnapshot,
} from "@natstack/shared/panel/panelLease";
import type {
  BridgePanelLifecycle,
  PanelViewLike,
  PanelHttpServerLike,
  PanelCreateOptions,
} from "@natstack/shared/panelInterfaces";
import type { WorkspaceConfig } from "@natstack/shared/workspace/types";
import type { PanelRestorePolicy } from "@natstack/shared/workspace/types";
import { buildPanelUrl } from "@natstack/shared/panelFactory";
import {
  getCurrentSnapshot,
  getPanelSource,
  getPanelContextId,
  getPanelRef,
} from "@natstack/shared/panel/accessors";
import { assertPresent } from "../lintHelpers";

const log = createDevLogger("PanelOrchestrator");

export interface PanelOrchestratorDeps {
  registry: PanelRegistry;
  eventService: EventService;
  serverClient: ServerClient;
  shellCore: PanelManager;

  getPanelView?: () => PanelViewLike | null;
  cdpServer: {
    cleanupPanelAccess(panelId: string): void;
    unregisterBrowser?(panelId: string): void;
  };
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

export class PanelOrchestrator implements BridgePanelLifecycle {
  private readonly deps: PanelOrchestratorDeps;
  private currentTheme: "light" | "dark" = "dark";
  private readonly runtimeClientSessionId = `desktop-${randomUUID()}`;
  private runtimeClientRegistered = false;
  private readonly runtimeConnectionBySlot = new Map<string, string>();
  private readonly stateArgsUpdateQueues = new Map<string, Promise<unknown>>();
  private viewRevision = 0;
  private readonly restorePolicy: PanelRestorePolicy;

  constructor(deps: PanelOrchestratorDeps) {
    this.deps = deps;
    this.restorePolicy = deps.workspaceConfig?.panelRestorePolicy ?? "focused";
  }

  // Convenience accessors
  private get registry() {
    return this.deps.registry;
  }
  private get eventService() {
    return this.deps.eventService;
  }
  private get serverClient() {
    return this.deps.serverClient;
  }
  private get shellCore() {
    return this.deps.shellCore;
  }
  private get externalHost() {
    return this.deps.externalHost;
  }
  private getPanelView() {
    return this.deps.getPanelView?.() ?? null;
  }
  private get panelHttpServer() {
    return this.deps.panelHttpServer;
  }
  private get cdpServer() {
    return this.deps.cdpServer;
  }
  private get workspaceConfig() {
    return this.deps.workspaceConfig;
  }

  // =========================================================================
  // Panel creation
  // =========================================================================

  async createPanel(
    callerId: string,
    source: string,
    options?: PanelCreateOptions,
    stateArgs?: Record<string, unknown>
  ): Promise<{ id: string; title: string }> {
    const caller = this.registry.getPanel(callerId);
    if (!caller) throw new Error(`Caller panel not found: ${callerId}`);

    const result = await this.shellCore.create(source, {
      parentId: callerId,
      ...options,
      stateArgs,
    });

    try {
      await this.attachCreatedPanel(result, { focus: options?.focus });
      return { id: result.panelId, title: result.title };
    } catch (err) {
      await this.shellCore.close(result.panelId).catch(() => {});
      throw err;
    }
  }

  async navigatePanel(
    panelId: string,
    source: string,
    options?: {
      ref?: string;
      contextId?: string;
      env?: Record<string, string>;
      stateArgs?: Record<string, unknown>;
    }
  ): Promise<{ id: string; title: string }> {
    const result = await this.shellCore.navigate(panelId, source, options);
    const panel = this.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found after navigation: ${panelId}`);
    await this.loadSnapshotIntoView(panelId, getCurrentSnapshot(panel));
    await this.focusPanel(panelId);
    return { id: result.panelId, title: result.title };
  }

  async navigatePanelHistory(
    panelId: string,
    delta: -1 | 1
  ): Promise<{ id: string; title: string } | null> {
    const panel = await this.shellCore.navigateHistory(panelId, delta);
    if (!panel) return null;
    await this.loadSnapshotIntoView(panelId, getCurrentSnapshot(panel));
    await this.focusPanel(panelId);
    return { id: panel.id, title: panel.title };
  }

  /**
   * Create a root panel from an arbitrary source path.
   * Unlike createAboutPanel (which prefixes with "about/"), this method
   * uses the source string as-is, making it suitable for mobile shells
   * that need to create panels from any source.
   */
  async createRootPanel(
    source: string,
    options?: { name?: string; isRoot?: boolean; ref?: string }
  ): Promise<{ id: string; title: string }> {
    const name = options?.name ?? `${source.replace(/\//g, "-")}~${Date.now().toString(36)}`;

    const result = await this.shellCore.create(source, {
      name,
      ref: options?.ref,
      isRoot: options?.isRoot ?? true,
      addAsRoot: true,
    });
    try {
      await this.attachCreatedPanel(result, { focus: true });
      return { id: result.panelId, title: result.title };
    } catch (error) {
      await this.shellCore.close(result.panelId).catch(() => {});
      throw error;
    }
  }

  async createAboutPanel(page: string): Promise<{ id: string; title: string }> {
    const result = await this.shellCore.createAboutPanel(page);
    try {
      await this.attachCreatedPanel({ panelId: result.id, title: result.title }, { focus: true });
      return result;
    } catch (error) {
      await this.shellCore.close(result.id).catch(() => {});
      throw error;
    }
  }

  async createInitPanel(
    source: string,
    stateArgs?: Record<string, unknown>
  ): Promise<{ id: string; title: string }> {
    const result = await this.shellCore.create(source, {
      isRoot: true,
      addAsRoot: true,
      stateArgs,
    });
    try {
      await this.attachCreatedPanel(result);
      return { id: result.panelId, title: result.title };
    } catch (error) {
      await this.shellCore.close(result.panelId).catch(() => {});
      throw error;
    }
  }

  async createBrowserPanel(
    callerId: string,
    url: string,
    options?: { name?: string; focus?: boolean }
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
      await this.attachCreatedPanel(result, { focus: options?.focus, browserUrl: url });
      return { id: result.panelId, title: result.title };
    } catch (err) {
      if (createdPanelId) {
        await this.shellCore.close(createdPanelId).catch(() => {});
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
    const focusedPanelId = this.registry.getFocusedPanelId();
    const focusedPanelWillClose = Boolean(
      focusedPanelId &&
      (focusedPanelId === panelId || this.registry.isDescendantOf(focusedPanelId, panelId))
    );
    let siblingToFocus: string | null = null;
    if (focusedPanelWillClose && parent) {
      const siblings = parent.children.filter((c) => c.id !== panelId);
      siblingToFocus =
        siblings.length > 0 ? assertPresent(siblings[siblings.length - 1]).id : parentId;
    } else if (focusedPanelWillClose && !parentId) {
      const roots = this.registry.getRootPanels();
      const rootIndex = roots.findIndex((p) => p.id === panelId);
      const nextRoot = rootIndex >= 0 ? (roots[rootIndex + 1] ?? roots[rootIndex - 1]) : undefined;
      siblingToFocus = nextRoot?.id ?? null;
    }

    // Server handles recursive close + resource cleanup
    const { closedIds } = await this.shellCore.close(panelId);

    // Destroy views and remove from in-memory tree
    for (const id of closedIds) {
      this.releaseLocalPanelRuntime(id, "close");
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

    // Re-registers the panel principal and issues a fresh connection grant.
    await this.shellCore.getPanelInit(panelId);

    // Browser panels: skip build
    if (getPanelSource(panel).startsWith("browser:")) {
      const url = getPanelSource(panel).slice("browser:".length);
      const view = this.getPanelView();
      if (view?.createViewForBrowser) {
        await view.createViewForBrowser(panelId, url, getPanelContextId(panel));
        this.bumpViewRevision();
      }
      this.registry.updateArtifacts(panelId, { buildState: "ready", htmlPath: url });
      this.registry.notifyPanelTreeUpdate();
      return;
    }

    this.registry.updateArtifacts(panelId, {
      buildState: "building",
      buildProgress: "Rebuilding panel...",
    });
    this.registry.notifyPanelTreeUpdate();

    this.panelHttpServer?.invalidateBuild(getPanelSource(panel));

    const panelUrl = await this.buildPanelLoadUrl(panelId);
    const view = this.getPanelView();
    if (panelUrl && view) {
      await view.createViewForPanel(panelId, panelUrl, getPanelContextId(panel));
      this.bumpViewRevision();
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
        this.releaseLocalPanelRuntime(entry.panelId, "invalidate");
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
        console.warn(`[PanelOrchestrator] Failed to rebuild ${focusedPanelId}:`, e)
      );
    }
  }

  async retryBuild(panelId: string): Promise<void> {
    await this.rebuildUnloadedPanel(panelId);
  }

  applyBuildComplete(source: string, error?: string): void {
    for (const entry of this.registry.listPanels()) {
      const panel = this.registry.getPanel(entry.panelId);
      if (!panel || getPanelSource(panel) !== source) continue;
      const viewUrl = this.hasPanelView(entry.panelId)
        ? (this.getPanelUrl(entry.panelId) ?? undefined)
        : undefined;
      if (error) {
        this.registry.updateArtifacts(entry.panelId, {
          ...panel.artifacts,
          htmlPath: viewUrl,
          buildState: "error",
          buildRevision: this.getBuildRevision(source),
          error,
          buildProgress: error,
        });
      } else {
        this.registry.updateArtifacts(entry.panelId, {
          ...panel.artifacts,
          htmlPath: viewUrl,
          buildState: "ready",
          buildRevision: this.getBuildRevision(source),
          buildProgress: undefined,
          error: undefined,
        });
      }
    }
    this.registry.notifyPanelTreeUpdate();
  }

  async initializeGitRepo(panelId: string): Promise<void> {
    await this.rebuildUnloadedPanel(panelId);
  }

  // =========================================================================
  // Bootstrap config
  // =========================================================================

  async getBootstrapConfig(callerId: string): Promise<unknown> {
    const config = await this.shellCore.getPanelInit(callerId);
    const connectionId = this.runtimeConnectionBySlot.get(callerId);
    if (!connectionId || !config || typeof config !== "object") return config;
    return {
      ...(config as Record<string, unknown>),
      connectionId,
      clientLabel: "Desktop",
    };
  }

  // =========================================================================
  // State mutation
  // =========================================================================

  async handleSetStateArgs(panelId: string, updates: Record<string, unknown>): Promise<unknown> {
    const previous = this.stateArgsUpdateQueues.get(panelId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const validated = await this.shellCore.updateStateArgs(panelId, updates);
        this.registry.updateStateArgs(panelId, validated as Record<string, unknown>);
        return validated;
      });
    this.stateArgsUpdateQueues.set(panelId, next);
    try {
      return await next;
    } finally {
      if (this.stateArgsUpdateQueues.get(panelId) === next) {
        this.stateArgsUpdateQueues.delete(panelId);
      }
    }
  }

  async replaceCurrentSnapshot(
    panelId: string,
    contextId: string,
    source?: string,
    stateArgs?: Record<string, unknown>
  ): Promise<void> {
    await this.shellCore.replaceCurrentSnapshot(panelId, {
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

  async focusPanel(
    targetPanelId: string,
    opts: { loadIfNeeded?: boolean } = {}
  ): Promise<PanelFocusResult> {
    const panel = this.registry.getPanel(targetPanelId);
    if (!panel) {
      log.warn(`Cannot focus panel - not found: ${targetPanelId}`);
      return {
        panelId: targetPanelId,
        status: "missing",
        focused: false,
        loaded: false,
        message: `Panel not found: ${targetPanelId}`,
      };
    }

    this.registry.updateSelectedPath(targetPanelId);
    this.registry.notifyPanelTreeUpdate();

    // Persist to server
    await this.shellCore.notifyFocused(targetPanelId).catch(() => {});

    const view = this.getPanelView();
    if (view?.hasView(targetPanelId)) {
      view.setViewVisible?.(targetPanelId, true);
      this.bumpViewRevision();
      this.sendPanelEvent(targetPanelId, { type: "focus" });
      this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
      return {
        panelId: targetPanelId,
        status: "loaded",
        focused: true,
        loaded: true,
      };
    }

    if (panel.artifacts.buildState === "error") {
      this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
      return {
        panelId: targetPanelId,
        status: "build_failed",
        focused: true,
        loaded: false,
        message: panel.artifacts.error ?? panel.artifacts.buildProgress ?? "Panel build failed",
      };
    }

    if (opts.loadIfNeeded) {
      try {
        await this.loadPanelIntoView(targetPanelId);
        const nextView = this.getPanelView();
        if (nextView?.hasView(targetPanelId)) {
          nextView.setViewVisible?.(targetPanelId, true);
          this.bumpViewRevision();
          this.sendPanelEvent(targetPanelId, { type: "focus" });
          this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
          return {
            panelId: targetPanelId,
            status: "loaded",
            focused: true,
            loaded: true,
          };
        }
        this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
        return {
          panelId: targetPanelId,
          status: "view_creation_failed",
          focused: true,
          loaded: false,
          message: "Panel view was not created",
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const lease = this.registry.getRuntimeLease(targetPanelId);
        const isLeaseFailure = /running on|leased by/i.test(message);
        this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
        return {
          panelId: targetPanelId,
          status: isLeaseFailure ? "leased_elsewhere" : "view_creation_failed",
          focused: true,
          loaded: false,
          message,
          holderLabel: lease?.holderLabel,
        };
      }
    }

    this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
    return {
      panelId: targetPanelId,
      status: "focused",
      focused: true,
      loaded: false,
    };
  }

  // =========================================================================
  // Tree initialization
  // =========================================================================

  async initializePanelTree(): Promise<void> {
    await this.shellCore.loadTree();
    await this.syncRuntimeLeaseSnapshot().catch((error: unknown) => {
      log.warn(
        `[initializePanelTree] Failed to sync runtime leases: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });

    const roots = this.registry.getRootPanels();
    if (roots.length > 0) {
      // Mark restored panels as unloaded (they rebuild on focus)
      for (const entry of this.registry.listPanels()) {
        const panel = this.registry.getPanel(entry.panelId);
        if (panel) {
          const hasBuildArtifacts = Boolean(
            panel.artifacts?.htmlPath || panel.artifacts?.bundlePath
          );
          if (panel.artifacts?.buildState !== "pending" || hasBuildArtifacts) {
            this.registry.updateArtifacts(entry.panelId, {
              buildState: "pending",
              buildProgress: "Panel unloaded - will rebuild when focused",
            });
          }
        }
      }
      this.registry.notifyPanelTreeUpdate();
      if (this.restorePolicy === "focused") {
        const focusedPanelId = this.registry.getFocusedPanelId() ?? roots[0]?.id;
        if (focusedPanelId) {
          await this.focusPanel(focusedPanelId, { loadIfNeeded: true });
        }
      }
    } else {
      const entries = this.workspaceConfig?.initPanels;
      log.info(
        `[initializePanelTree] No existing roots. initPanels config:`,
        JSON.stringify(entries)
      );
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
      if (newRoots.length > 0 && this.restorePolicy === "focused") {
        await this.focusPanel(assertPresent(newRoots[0]).id, { loadIfNeeded: true });
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

  async unloadPanel(
    panelId: string,
    transition: "unload" | "lease-transfer" = "unload"
  ): Promise<void> {
    const panel = this.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);

    this.unloadPanelTree(panelId, transition);
    this.registry.notifyPanelTreeUpdate();
  }

  private async unloadPanelIfPresent(
    panelId: string,
    transition: "unload" | "lease-transfer"
  ): Promise<void> {
    if (!this.registry.getPanel(panelId)) return;
    await this.unloadPanel(panelId, transition);
  }

  getRuntimeClientSessionId(): string {
    return this.runtimeClientSessionId;
  }

  getFocusedPanelId(): string | null {
    return this.registry.getFocusedPanelId();
  }

  async takeOverPanel(panelId: string): Promise<void> {
    await this.loadPanelIntoView(panelId, "takeOver");
    await this.focusPanel(panelId);
  }

  async syncRuntimeLeaseSnapshot(): Promise<void> {
    const snapshot = (await this.serverClient.call(
      "panelRuntime",
      "getSnapshot",
      []
    )) as RuntimeLeaseSnapshot;
    this.registry.applyRuntimeLeaseSnapshot(snapshot);
  }

  async recoverShellSnapshot(
    opts: { loadFocusedView?: boolean } = {}
  ): Promise<PanelRecoverySnapshot> {
    const { collapsedIds } = await this.shellCore.loadTree();
    await this.syncRuntimeLeaseSnapshot();

    const currentFocusedPanelId = this.registry.getFocusedPanelId();
    const roots = this.registry.getRootPanels();
    const focusedPanelId =
      currentFocusedPanelId && this.registry.getPanel(currentFocusedPanelId)
        ? currentFocusedPanelId
        : (roots[0]?.id ?? null);
    const shouldLoadFocusedView =
      opts.loadFocusedView ?? (this.restorePolicy === "focused" && Boolean(focusedPanelId));
    const focus = focusedPanelId
      ? await this.focusPanel(focusedPanelId, { loadIfNeeded: shouldLoadFocusedView })
      : undefined;

    const treeSnapshot = this.registry.getPanelTreeSnapshot();
    this.eventService.emit("panel:snapshot", {
      revision: treeSnapshot.revision,
      viewRevision: this.viewRevision,
      rootPanels: treeSnapshot.rootPanels,
      collapsedIds,
      focusedPanelId,
      focus,
    });
    return {
      revision: treeSnapshot.revision,
      viewRevision: this.viewRevision,
      rootPanels: treeSnapshot.rootPanels,
      collapsedIds,
      focusedPanelId,
      focus,
    };
  }

  async applyRuntimeLeaseChanged(event: PanelRuntimeLeaseChangedEvent): Promise<void> {
    const slotId = event.slotId;
    if (!slotId) return;
    this.registry.applyRuntimeLeaseChanged(event);
    this.eventService.emit("panel:runtimeLeaseChanged", event);
    if (event.next && event.next.clientSessionId !== this.runtimeClientSessionId) {
      await this.unloadPanelIfPresent(slotId, "lease-transfer");
      return;
    }
    if (!event.next && event.previous?.clientSessionId === this.runtimeClientSessionId) {
      await this.unloadPanelIfPresent(slotId, "lease-transfer");
    }
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
      this.deps.sendPanelEvent(panelId, "runtime:child-created", {
        childId: data["childId"],
        url: data["url"],
      });
    } else if (data["type"] === "child-creation-error") {
      this.deps.sendPanelEvent(panelId, "runtime:child-creation-error", {
        url: data["url"],
        error: data["error"],
      });
    }
  }

  // =========================================================================
  // Persistence delegation (server-first)
  // =========================================================================

  async movePanel(
    panelId: string,
    newParentId: string | null,
    targetPosition: number
  ): Promise<void> {
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

  hasPanelView(panelId: string): boolean {
    return this.getPanelView()?.hasView(panelId) ?? false;
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
      ref: getPanelRef(panel),
      connectionId: this.runtimeConnectionBySlot.get(panelId),
      gatewayPort: this.deps.gatewayPort,
      externalHost: this.externalHost,
      protocol: this.deps.protocol,
    });
  }

  private async attachCreatedPanel(
    result: {
      panelId: string;
      title: string;
      contextId?: string;
      source?: string;
      options?: Record<string, unknown>;
    },
    opts: { focus?: boolean; browserUrl?: string } = {}
  ): Promise<void> {
    const panel = this.registry.getPanel(result.panelId);
    const contextId = result.contextId ?? (panel ? getPanelContextId(panel) : undefined);
    const source = result.source ?? (panel ? getPanelSource(panel) : undefined);
    const view = this.getPanelView();

    if (opts.browserUrl) {
      if (view?.createViewForBrowser) {
        await view.createViewForBrowser(result.panelId, opts.browserUrl, assertPresent(contextId));
        this.bumpViewRevision();
      }
      this.registry.updateArtifacts(result.panelId, {
        htmlPath: opts.browserUrl,
        buildState: "ready",
        buildRevision: undefined,
      });
      this.registry.notifyPanelTreeUpdate();
      if (opts.focus) {
        await this.focusPanel(result.panelId);
      }
      return;
    }

    const panelUrl = await this.buildPanelLoadUrl(result.panelId);
    if (panelUrl && view) {
      await view.createViewForPanel(result.panelId, panelUrl, assertPresent(contextId));
      this.bumpViewRevision();
    }

    const ref =
      (result.options?.["ref"] as string | undefined) ??
      (panel ? (getCurrentSnapshot(panel).options.ref as string | undefined) : undefined);
    const buildCached = source ? (this.panelHttpServer?.hasBuild(source, ref) ?? false) : false;
    this.registry.updateArtifacts(result.panelId, {
      htmlPath: panelUrl ?? undefined,
      buildState: buildCached ? "ready" : "building",
      buildRevision: source ? this.getBuildRevision(source, ref) : undefined,
      buildProgress: buildCached ? undefined : "Waiting for build...",
    });
    this.registry.notifyPanelTreeUpdate();
    if (opts.focus) {
      await this.focusPanel(result.panelId);
    }
  }

  private async loadPanelIntoView(
    panelId: string,
    leaseMode: "acquire" | "takeOver" = "acquire"
  ): Promise<void> {
    const panel = this.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);
    await this.loadSnapshotIntoView(panelId, getCurrentSnapshot(panel), leaseMode);
  }

  private async buildPanelLoadUrl(
    panelId: string,
    leaseMode: "acquire" | "takeOver" = "acquire"
  ): Promise<string | null> {
    const panel = this.registry.getPanel(panelId);
    if (!panel) return null;

    const source = getPanelSource(panel);
    if (source.startsWith("browser:")) {
      return source.slice("browser:".length);
    }

    const connectionId = await this.acquireRuntimeLease(panelId, leaseMode);
    return buildPanelUrl({
      source,
      contextId: getPanelContextId(panel),
      ref: getPanelRef(panel),
      connectionId,
      gatewayPort: this.deps.gatewayPort,
      externalHost: this.externalHost,
      protocol: this.deps.protocol,
    });
  }

  private async loadSnapshotIntoView(
    panelId: string,
    snapshot: PanelSnapshot,
    leaseMode: "acquire" | "takeOver" = "acquire"
  ): Promise<void> {
    const view = this.getPanelView();
    if (!view) return;

    if (view.hasView(panelId)) {
      view.destroyView(panelId);
      this.bumpViewRevision();
    }

    if (snapshot.source.startsWith("browser:")) {
      const url = snapshot.source.slice("browser:".length);
      if (view.createViewForBrowser) {
        await view.createViewForBrowser(panelId, url, snapshot.contextId);
        this.bumpViewRevision();
      }
      this.registry.updateArtifacts(panelId, { buildState: "ready", htmlPath: url });
      this.registry.notifyPanelTreeUpdate();
      return;
    }

    const connectionId = await this.acquireRuntimeLease(panelId, leaseMode);
    const panelUrl = buildPanelUrl({
      source: snapshot.source,
      contextId: snapshot.contextId,
      ref: snapshot.options.ref,
      connectionId,
      gatewayPort: this.deps.gatewayPort,
      externalHost: this.externalHost,
      protocol: this.deps.protocol,
    });
    await view.createViewForPanel(panelId, panelUrl, snapshot.contextId);
    this.bumpViewRevision();
    this.registry.updateArtifacts(panelId, {
      htmlPath: panelUrl,
      buildState: this.panelHttpServer?.hasBuild(snapshot.source, snapshot.options.ref)
        ? "ready"
        : "building",
      buildRevision: this.getBuildRevision(snapshot.source, snapshot.options.ref),
      buildProgress: this.panelHttpServer?.hasBuild(snapshot.source, snapshot.options.ref)
        ? undefined
        : "Waiting for build...",
    });
    this.registry.notifyPanelTreeUpdate();
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private async ensureRuntimeClientRegistered(): Promise<void> {
    if (this.runtimeClientRegistered) return;
    await this.serverClient.call("panelRuntime", "registerClient", [
      {
        clientSessionId: this.runtimeClientSessionId,
        label: "Desktop",
        platform: "desktop",
      },
    ]);
    this.runtimeClientRegistered = true;
  }

  private async acquireRuntimeLease(
    panelId: string,
    leaseMode: "acquire" | "takeOver"
  ): Promise<string> {
    await this.ensureRuntimeClientRegistered();
    const runtimeEntityId = await this.shellCore.getCurrentEntityId(panelId);
    const connectionId = `desktop-${panelId}-${randomUUID()}`;
    const result = (await this.serverClient.call("panelRuntime", leaseMode, [
      runtimeEntityId,
      {
        slotId: panelId,
        clientSessionId: this.runtimeClientSessionId,
        connectionId,
      },
    ])) as { acquired: boolean; lease?: { holderLabel?: string } };
    if (!result.acquired) {
      throw new Error(
        `Panel ${panelId} is running on ${result.lease?.holderLabel ?? "another client"}`
      );
    }
    this.runtimeConnectionBySlot.set(panelId, connectionId);
    return connectionId;
  }

  private getBuildRevision(source: string, ref?: string): number | undefined {
    return this.panelHttpServer?.getBuildRevision?.(source, ref);
  }

  private releaseLocalPanelRuntime(
    panelId: string,
    _transition: "close" | "invalidate" | "lease-transfer" | "unload"
  ): void {
    this.runtimeConnectionBySlot.delete(panelId);
    // Close open file handles (skip for browser panels)
    // Note: FS handles are managed server-side, but local cleanup still needed

    // CDP cleanup
    this.cdpServer?.cleanupPanelAccess(panelId);
    this.cdpServer?.unregisterBrowser?.(panelId);

    // Destroy view
    const view = this.getPanelView();
    if (view?.hasView(panelId)) {
      view.destroyView(panelId);
      this.bumpViewRevision();
    }
  }

  private bumpViewRevision(): number {
    this.viewRevision += 1;
    return this.viewRevision;
  }

  private unloadPanelTree(
    panelId: string,
    transition: "lease-transfer" | "unload" = "unload"
  ): void {
    const panel = this.registry.getPanel(panelId);
    if (!panel) return;

    for (const child of panel.children) {
      this.unloadPanelTree(child.id, transition);
    }

    this.releaseLocalPanelRuntime(panelId, transition);

    const hasBuildArtifacts = Boolean(panel.artifacts?.htmlPath || panel.artifacts?.bundlePath);
    if (panel.artifacts?.buildState === "pending" && !hasBuildArtifacts) return;

    this.registry.updateArtifacts(panelId, {
      buildState: "pending",
      buildProgress: "Panel unloaded - will rebuild when focused",
    });
  }
}
