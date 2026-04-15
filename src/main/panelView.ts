/**
 * PanelView — Electron-only view management service.
 *
 * Manages WebContentsView lifecycle: creating views, tracking browser state,
 * intercepting navigation, and handling crashes. Implements PanelViewLike so
 * PanelOrchestrator can drive view creation without Electron imports.
 */

import { createDevLogger } from "@natstack/dev-log";
import type { ViewManager } from "./viewManager.js";
import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import type { PanelViewLike, ServerInfoLike } from "@natstack/shared/panelInterfaces";
import { BROWSER_SESSION_PARTITION } from "@natstack/shared/panelInterfaces";
import { getCurrentSnapshot, getPanelSource, getPanelContextId } from "@natstack/shared/panelTypes";
import { contextIdToPartition } from "@natstack/shared/contextIdToPartition.js";
import { buildPanelUrl } from "@natstack/shared/panelFactory";
import { isManagedHost, parsePanelUrl } from "@natstack/shared/shell/urlParsing.js";
import type { Panel } from "@natstack/shared/types";
import { logMemorySnapshot } from "./memoryMonitor.js";
// Persistence removed — server panel service handles all persistence

const log = createDevLogger("PanelView");

// syncSnapshotFromManifest moved server-side (panelService.updateContext handles autoArchiveWhenEmpty)

// Narrow interfaces for dependencies
interface CdpServerLike {
  registerBrowser(panelId: string, contentsId: number, parentId: string): void;
  unregisterBrowser(panelId: string): void;
  revokeTokenForPanel(panelId: string): void;
}

interface PanelOrchestratorLike {
  createPanel(
    callerId: string, source: string,
    options?: { name?: string; contextId?: string; focus?: boolean; env?: Record<string, string> },
    stateArgs?: Record<string, unknown>,
  ): Promise<{ id: string; title: string }>;
  createBrowserPanel(
    callerId: string, url: string,
    options?: { name?: string; focus?: boolean },
  ): Promise<{ id: string; title: string }>;
  updatePanelContext(panelId: string, contextId: string, source?: string, stateArgs?: Record<string, unknown>): Promise<void>;
  updatePanelTitle(panelId: string, title: string): Promise<void>;
}

interface AutofillManagerLike {
  attachToWebContents(webContentsId: number, webContents: Electron.WebContents): void;
  detachFromWebContents(webContentsId: number, webContents?: Electron.WebContents): void;
}

export class PanelView implements PanelViewLike {
  private viewManager: ViewManager;
  private readonly panelRegistry: PanelRegistry;
  private readonly serverInfo: ServerInfoLike;
  private readonly cdpServer: CdpServerLike;
  private readonly panelOrchestrator: PanelOrchestratorLike;
  private readonly externalHost: string;
  private sendPanelEvent?: (panelId: string, event: string, payload: unknown) => void;
  private autofillManager?: AutofillManagerLike;
  private autofillPreloadPath?: string;
  private panelPreloadPath?: string;
  private browserPreloadPath?: string;

  private browserStateCleanup = new Map<string, { cleanup: () => void; destroyedHandler: () => void }>();
  private linkInterceptionHandlers = new Map<string, (event: Electron.Event, url: string) => void>();
  private contentLoadHandlers = new Map<string, { domReady?: () => void; didFinishLoad?: () => void }>();
  private crashHistory = new Map<string, number[]>();
  private readonly MAX_CRASHES = 3;
  private readonly CRASH_WINDOW_MS = 60000;

  /** Derive panel HTTP port from serverInfo.gatewayPort */
  private get panelHttpPort() { return this.serverInfo.gatewayPort; }

  constructor(deps: {
    viewManager: ViewManager;
    panelRegistry: PanelRegistry;
    serverInfo: ServerInfoLike;
    cdpServer: CdpServerLike;
    panelOrchestrator: PanelOrchestratorLike;
    sendPanelEvent?: (panelId: string, event: string, payload: unknown) => void;
    autofillManager?: AutofillManagerLike;
    autofillPreloadPath?: string;
    panelPreloadPath?: string;
    browserPreloadPath?: string;
  }) {
    this.viewManager = deps.viewManager;
    this.panelRegistry = deps.panelRegistry;
    this.serverInfo = deps.serverInfo;
    this.cdpServer = deps.cdpServer;
    this.panelOrchestrator = deps.panelOrchestrator;
    this.externalHost = deps.serverInfo.externalHost;
    this.sendPanelEvent = deps.sendPanelEvent;
    this.autofillManager = deps.autofillManager;
    this.autofillPreloadPath = deps.autofillPreloadPath;
    this.panelPreloadPath = deps.panelPreloadPath;
    this.browserPreloadPath = deps.browserPreloadPath;
  }

  // ==== PanelViewLike implementation ========================================

  async createViewForPanel(panelId: string, url: string, contextId?: string): Promise<void> {
    if (this.viewManager.hasView(panelId)) {
      const currentUrl = this.viewManager.getViewUrl(panelId);
      if (currentUrl !== url) void this.viewManager.navigateView(panelId, url);
      return;
    }

    const parentId = this.panelRegistry.findParentId(panelId);

    const view = this.viewManager.createView({
      id: panelId, type: "panel", preload: this.panelPreloadPath ?? null,
      url, parentId: parentId ?? undefined,
      partition: contextId ? contextIdToPartition(contextId) : undefined,
      injectHostThemeVariables: true,
    });

    this.setupBrowserStateTracking(panelId, view.webContents);

    if (parentId) {
      // Register immediately so CDP access checks pass before dom-ready
      this.cdpServer.registerBrowser(panelId, view.webContents.id, parentId);
      const domReadyHandler = () => {
        this.cdpServer.registerBrowser(panelId, view.webContents.id, parentId);
      };
      view.webContents.on("dom-ready", domReadyHandler);
      this.contentLoadHandlers.set(panelId, { domReady: domReadyHandler });
    }

    this.setupLinkInterception(panelId, view.webContents);
  }

  hasView(panelId: string): boolean { return this.viewManager.hasView(panelId); }

  destroyView(panelId: string): void {
    const contents = this.viewManager.getWebContents(panelId);
    if (this.autofillManager && contents && !contents.isDestroyed()) {
      this.autofillManager.detachFromWebContents(contents.id, contents);
    }
    this.cleanupBrowserStateTracking(panelId, contents ?? undefined);
    this.cleanupLinkInterception(panelId, contents ?? undefined);
    this.cdpServer.revokeTokenForPanel(panelId);
    this.cdpServer.unregisterBrowser(panelId);
    this.crashHistory.delete(panelId);
    this.viewManager.destroyView(panelId);
  }

  reloadView(panelId: string): boolean { return this.viewManager.reloadView(panelId); }

  async navigateView(panelId: string, url: string): Promise<void> {
    await this.viewManager.navigateView(panelId, url);
  }

  getWebContents(panelId: string): Electron.WebContents | null {
    return this.viewManager.getWebContents(panelId);
  }

  findViewIdByWebContentsId(senderId: number): string | null {
    return this.viewManager.findViewIdByWebContentsId(senderId);
  }

  setProtectedViews(lineage: Set<string>): void {
    this.viewManager.setProtectedViews(lineage);
  }

  /**
   * Create a view for a browser panel (external URL).
   * No auth cookies, no link interception — browser panels navigate freely.
   */
  async createViewForBrowser(panelId: string, url: string, contextId: string): Promise<void> {
    if (this.viewManager.hasView(panelId)) {
      const currentUrl = this.viewManager.getViewUrl(panelId);
      if (currentUrl !== url) void this.viewManager.navigateView(panelId, url);
      return;
    }

    const parentId = this.panelRegistry.findParentId(panelId);

    const view = this.viewManager.createView({
      id: panelId, type: "panel",
      preload: this.browserPreloadPath ?? this.autofillPreloadPath ?? null,
      url, parentId: parentId ?? undefined,
      partition: BROWSER_SESSION_PARTITION,
      injectHostThemeVariables: false,
    });

    this.setupBrowserStateTracking(panelId, view.webContents);

    if (parentId) {
      // Register immediately so CDP access checks pass before dom-ready
      this.cdpServer.registerBrowser(panelId, view.webContents.id, parentId);
      const domReadyHandler = () => {
        this.cdpServer.registerBrowser(panelId, view.webContents.id, parentId);
      };
      view.webContents.on("dom-ready", domReadyHandler);
      this.contentLoadHandlers.set(panelId, { domReady: domReadyHandler });
    }

    // Attach autofill for browser panels
    if (this.autofillManager) {
      this.autofillManager.attachToWebContents(view.webContents.id, view.webContents);
    }

    // No setupLinkInterception — browser panels navigate freely
  }

  // ==== Additional public methods ===========================================

  openDevTools(panelId: string): void { this.viewManager.openDevTools(panelId); }
  getViewManager(): ViewManager { return this.viewManager; }

  /** Handle a view crash — implements recovery policy with loop protection. */
  handleViewCrashed(viewId: string, reason: string): void {
    console.warn(`[PanelView] View ${viewId} crashed: ${reason}`);
    void logMemorySnapshot({ reason: `view-crash:${viewId}:${reason}` });

    if (!this.shouldAttemptReload(viewId)) {
      console.error(`[PanelView] Giving up on ${viewId} after repeated crashes`);
      return;
    }
    log.verbose(` Attempting reload of ${viewId}`);
    if (!this.viewManager.reloadView(viewId)) {
      console.warn(`[PanelView] Reload failed for ${viewId}, attempting view recreation`);
      void this.recreatePanelView(viewId);
    }
  }

  // ==== Browser state tracking ==============================================

  private setupBrowserStateTracking(panelId: string, contents: Electron.WebContents): void {
    let pendingState: Partial<{ url?: string; pageTitle?: string; isLoading?: boolean; canGoBack?: boolean; canGoForward?: boolean }> = {};
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let cleaned = false;

    const flushPendingState = () => {
      if (cleaned) return;
      if (Object.keys(pendingState).length > 0) {
        this.updatePanelState(panelId, pendingState);
        pendingState = {};
      }
      debounceTimer = null;
    };

    const queueStateUpdate = (update: typeof pendingState) => {
      if (cleaned) return;
      Object.assign(pendingState, update);
      if (!debounceTimer) debounceTimer = setTimeout(flushPendingState, 50);
    };

    const handlers = {
      didNavigate: (_event: Electron.Event, url: string) => {
        log.verbose(` Panel ${panelId} navigated to: ${url}`);
        queueStateUpdate({ url });
        try {
          const parsed = new URL(url);
          const pathSource = parsed.pathname.replace(/^\//, "").replace(/\/$/, "");
          const panel = this.panelRegistry.getPanel(panelId);
          if (panel && pathSource && getPanelSource(panel) !== pathSource) {
            panel.snapshot.source = pathSource;
            void this.panelOrchestrator.updatePanelContext(panelId, panel.snapshot.contextId, pathSource).catch(() => {});
          }
        } catch { /* non-URL navigation */ }
      },
      didNavigateInPage: (_event: Electron.Event, url: string) => { queueStateUpdate({ url }); },
      didFailLoad: (_e: Electron.Event, code: number, desc: string, url: string) => {
        console.warn(`[PanelView] Panel ${panelId} failed to load: ${desc} (${code}) - ${url}`);
      },
      renderProcessGone: (_e: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
        console.warn(`[PanelView] Panel ${panelId} render process gone: ${details.reason}`);
      },
      unresponsive: () => { console.warn(`[PanelView] Panel ${panelId} became unresponsive`); },
      responsive: () => { log.verbose(` Panel ${panelId} became responsive again`); },
      didStartLoading: () => { queueStateUpdate({ isLoading: true }); },
      didStopLoading: () => {
        if (contents.isDestroyed()) return;
        queueStateUpdate({ isLoading: false, canGoBack: contents.canGoBack(), canGoForward: contents.canGoForward() });
      },
      pageTitleUpdated: (_event: Electron.Event, title: string) => { queueStateUpdate({ pageTitle: title }); },
    };

    contents.on("did-navigate", handlers.didNavigate);
    contents.on("did-navigate-in-page", handlers.didNavigateInPage);
    contents.on("did-fail-load", handlers.didFailLoad);
    contents.on("render-process-gone", handlers.renderProcessGone);
    contents.on("unresponsive", handlers.unresponsive);
    contents.on("responsive", handlers.responsive);
    contents.on("did-start-loading", handlers.didStartLoading);
    contents.on("did-stop-loading", handlers.didStopLoading);
    contents.on("page-title-updated", handlers.pageTitleUpdated);

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (!contents.isDestroyed()) {
        contents.off("did-navigate", handlers.didNavigate);
        contents.off("did-navigate-in-page", handlers.didNavigateInPage);
        contents.off("did-fail-load", handlers.didFailLoad);
        contents.off("render-process-gone", handlers.renderProcessGone);
        contents.off("unresponsive", handlers.unresponsive);
        contents.off("responsive", handlers.responsive);
        contents.off("did-start-loading", handlers.didStartLoading);
        contents.off("did-stop-loading", handlers.didStopLoading);
        contents.off("page-title-updated", handlers.pageTitleUpdated);
      }
      this.browserStateCleanup.delete(panelId);
    };

    const destroyedHandler = () => cleanup();
    contents.once("destroyed", destroyedHandler);
    this.browserStateCleanup.set(panelId, { cleanup, destroyedHandler });
  }

  private cleanupBrowserStateTracking(panelId: string, contents?: Electron.WebContents): void {
    const entry = this.browserStateCleanup.get(panelId);
    if (entry) {
      if (contents && !contents.isDestroyed()) contents.off("destroyed", entry.destroyedHandler);
      entry.cleanup();
    }
    const loadHandlers = this.contentLoadHandlers.get(panelId);
    if (loadHandlers && contents && !contents.isDestroyed()) {
      if (loadHandlers.domReady) contents.off("dom-ready", loadHandlers.domReady);
      if (loadHandlers.didFinishLoad) contents.off("did-finish-load", loadHandlers.didFinishLoad);
    }
    this.contentLoadHandlers.delete(panelId);
  }

  /** Update panel metadata from webview navigation events. */
  private updatePanelState(
    panelId: string,
    state: { url?: string; pageTitle?: string; isLoading?: boolean; canGoBack?: boolean; canGoForward?: boolean },
  ): void {
    const panel = this.panelRegistry.getPanel(panelId);
    if (!panel) return;

    const snapshot = getCurrentSnapshot(panel);
    if (state.url !== undefined) snapshot.resolvedUrl = state.url;

    if (state.pageTitle !== undefined) {
      panel.title = state.pageTitle;
      void this.panelOrchestrator.updatePanelTitle(panelId, state.pageTitle).catch(() => {});
    }
    this.panelRegistry.notifyPanelTreeUpdate();
  }

  // ==== Link interception ===================================================

  private setupLinkInterception(panelId: string, contents: Electron.WebContents): void {
    contents.setWindowOpenHandler((details) => {
      const url = details.url;
      const parsed = parsePanelUrl(url, this.externalHost);
      if (parsed) {
        void this.panelOrchestrator.createPanel(panelId, parsed.source, parsed.options, parsed.stateArgs)
          .catch((err: unknown) => this.handleChildCreationError(panelId, err, url));
        return { action: "deny" as const };
      }
      if (/^https?:\/\//i.test(url)) {
        void this.panelOrchestrator.createBrowserPanel(panelId, url, { focus: true })
          .then(({ id }) => {
            this.sendPanelEvent?.(panelId, "runtime:child-created", { childId: id, url });
          })
          .catch((err: unknown) => this.handleChildCreationError(panelId, err, url));
        return { action: "deny" as const };
      }
      return { action: "deny" as const };
    });

    const willNavigateHandler = (event: Electron.Event, url: string) => {
      if (!isManagedHost(url, this.externalHost)) {
        if (/^https?:\/\//i.test(url)) {
          event.preventDefault();
          void this.panelOrchestrator.createBrowserPanel(panelId, url, { focus: true })
            .then(({ id }) => {
              this.sendPanelEvent?.(panelId, "runtime:child-created", { childId: id, url });
            })
            .catch((err: unknown) => this.handleChildCreationError(panelId, err, url));
        }
        return;
      }

      const panel = this.panelRegistry.getPanel(panelId);
      if (!panel) return;
      const parsed = parsePanelUrl(url, this.externalHost);
      if (!parsed) return;

      const currentSource = getPanelSource(panel);
      const currentContextId = getPanelContextId(panel);
      const targetContextId = parsed.contextId ?? currentContextId;
      const sourceChanged = parsed.source !== currentSource;
      const contextChanged = targetContextId !== currentContextId;
      if (!sourceChanged && !contextChanged) return;

      event.preventDefault();
      void this.handleManagedNavigation(panelId, panel, parsed.source, targetContextId, parsed.stateArgs)
        .catch((err) => log.warn(`[PanelNav] Navigation failed for ${panelId}:`, err));
    };

    this.linkInterceptionHandlers.set(panelId, willNavigateHandler);
    contents.on("will-navigate", willNavigateHandler);
  }

  private cleanupLinkInterception(panelId: string, contents?: Electron.WebContents): void {
    const handler = this.linkInterceptionHandlers.get(panelId);
    if (handler) {
      if (contents && !contents.isDestroyed()) contents.off("will-navigate", handler);
      this.linkInterceptionHandlers.delete(panelId);
    }
  }

  private handleChildCreationError(parentId: string, error: unknown, url: string): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[PanelView] Failed to create child from ${url}:`, error);
    this.sendPanelEvent?.(parentId, "runtime:child-creation-error", { url, error: message });
  }

  // ==== Managed navigation ==================================================

  /**
   * Handle navigation to another managed panel source and/or context by
   * updating shell state first, then recreating the view when the storage
   * partition changes.
   */
  private async handleManagedNavigation(
    panelId: string,
    panel: Panel,
    source: string,
    newContextId: string,
    stateArgs?: Record<string, unknown>,
  ): Promise<void> {
    log.info(`[PanelNav] Panel ${panelId}: ${getPanelSource(panel)} -> ${source} (context ${getPanelContextId(panel)} -> ${newContextId})`);

    const nextUrl = buildPanelUrl({
      source,
      contextId: newContextId,
      panelHttpPort: this.panelHttpPort,
      externalHost: this.externalHost,
      protocol: this.serverInfo.protocol,
    });

    const oldSource = panel.snapshot.source;
    const oldContextId = panel.snapshot.contextId;
    const oldStateArgs = panel.snapshot.stateArgs;
    const wasVisible = this.viewManager.isViewVisible(panelId);
    panel.snapshot.source = source;
    panel.snapshot.contextId = newContextId;
    if (stateArgs !== undefined) panel.snapshot.stateArgs = stateArgs;

    try {
      await this.panelOrchestrator.updatePanelContext(panelId, newContextId, source, stateArgs);
      if (this.viewManager.hasView(panelId)) {
        this.destroyView(panelId);
      }
      await this.createViewForPanel(panelId, nextUrl, newContextId);
      if (wasVisible) {
        this.viewManager.setViewVisible(panelId, true);
      }
    } catch (err) {
      panel.snapshot.source = oldSource;
      panel.snapshot.contextId = oldContextId;
      panel.snapshot.stateArgs = oldStateArgs;
      await this.panelOrchestrator.updatePanelContext(panelId, oldContextId, oldSource, oldStateArgs).catch(() => {});
      throw err;
    }
    this.panelRegistry.notifyPanelTreeUpdate();
  }

  // ==== Crash recovery ======================================================

  private shouldAttemptReload(viewId: string): boolean {
    const now = Date.now();
    const history = this.crashHistory.get(viewId) ?? [];
    const recent = history.filter((t) => now - t < this.CRASH_WINDOW_MS);
    if (recent.length >= this.MAX_CRASHES) return false;
    recent.push(now);
    this.crashHistory.set(viewId, recent);
    return true;
  }

  private async recreatePanelView(panelId: string): Promise<void> {
    const panel = this.panelRegistry.getPanel(panelId);
    if (!panel) { console.error(`[PanelView] Cannot recreate view: panel ${panelId} not found`); return; }

    if (this.viewManager.hasView(panelId)) {
      log.verbose(` Destroying zombie view for ${panelId}`);
      this.viewManager.destroyView(panelId);
    }

    try {
      const builtUrl = getCurrentSnapshot(panel).resolvedUrl;
      if (builtUrl) {
        await this.createViewForPanel(panelId, builtUrl, getPanelContextId(panel));
        log.verbose(` Recreated view for ${panelId}`);
      } else {
        log.verbose(` No built URL for ${panelId}, triggering rebuild`);
        panel.artifacts = { buildState: "pending" };
        this.panelRegistry.notifyPanelTreeUpdate();
      }
    } catch (error) {
      console.error(`[PanelView] Failed to recreate view for ${panelId}:`, error instanceof Error ? error.message : error);
      panel.artifacts = { buildState: "pending" };
      this.panelRegistry.notifyPanelTreeUpdate();
    }
  }
}
