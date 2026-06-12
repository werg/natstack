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
import type { AppCapability } from "@natstack/shared/unitManifest";
import {
  getCurrentSnapshot,
  getPanelSource,
  getPanelContextId,
  getPanelRef,
  updatePanelNavigationState,
} from "@natstack/shared/panelTypes";
import { contextIdToPartition } from "@natstack/shared/contextIdToPartition.js";
import { isManagedHost, parsePanelUrl } from "@natstack/shared/shell/urlParsing.js";
import { isBrowserPanelSource, panelSourceFromBrowserUrl } from "@natstack/shared/panelChrome";
import type { Panel, PanelNavigationState } from "@natstack/shared/types";
import { logMemorySnapshot } from "./memoryMonitor.js";
import type { BrowserHistoryRecorder, BrowserNavigationIntent } from "./browserHistoryRecorder.js";
// Persistence removed — server panel service handles all persistence

const log = createDevLogger("PanelView");

// syncSnapshotFromManifest moved server-side (panelService snapshot replacement handles autoArchiveWhenEmpty)

// Narrow interfaces for dependencies
interface CdpHostLike {
  registerTarget(panelId: string, contentsId: number): void;
  unregisterTarget(panelId: string): void;
  cleanupPanelAccess(panelId: string): void;
}

interface PanelOrchestratorLike {
  createPanel(
    callerId: string,
    source: string,
    options?: { name?: string; contextId?: string; focus?: boolean; env?: Record<string, string> },
    stateArgs?: Record<string, unknown>
  ): Promise<{ id: string; title: string }>;
  createBrowserUrlPanel(
    callerId: string,
    url: string,
    options?: { name?: string; focus?: boolean }
  ): Promise<{ id: string; title: string }>;
  navigatePanel(
    panelId: string,
    source: string,
    options?: { ref?: string; contextId?: string; stateArgs?: Record<string, unknown> }
  ): Promise<{ id: string; title: string }>;
  replaceCurrentSnapshot(
    panelId: string,
    contextId: string,
    source?: string,
    stateArgs?: Record<string, unknown>
  ): Promise<void>;
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
  private readonly cdpHost: CdpHostLike;
  private readonly panelOrchestrator: PanelOrchestratorLike;
  private readonly externalHost: string;
  private sendPanelEvent?: (panelId: string, event: string, payload: unknown) => void;
  private autofillManager?: AutofillManagerLike;
  private autofillPreloadPath?: string;
  private panelPreloadPath?: string;
  private appPreloadPath?: string;
  private browserPreloadPath?: string;
  private browserHistoryRecorder?: BrowserHistoryRecorder;

  private browserStateCleanup = new Map<
    string,
    { cleanup: () => void; destroyedHandler: () => void }
  >();
  private linkInterceptionHandlers = new Map<
    string,
    (event: Electron.Event, url: string) => void
  >();
  private contentLoadHandlers = new Map<
    string,
    { domReady?: () => void; didFinishLoad?: () => void }
  >();
  private crashHistory = new Map<string, number[]>();
  private readonly MAX_CRASHES = 3;
  private readonly CRASH_WINDOW_MS = 60000;

  private get gatewayPort() {
    return this.serverInfo.gatewayPort;
  }

  constructor(deps: {
    viewManager: ViewManager;
    panelRegistry: PanelRegistry;
    serverInfo: ServerInfoLike;
    cdpHost: CdpHostLike;
    panelOrchestrator: PanelOrchestratorLike;
    sendPanelEvent?: (panelId: string, event: string, payload: unknown) => void;
    autofillManager?: AutofillManagerLike;
    autofillPreloadPath?: string;
    panelPreloadPath?: string;
    appPreloadPath?: string;
    browserPreloadPath?: string;
    browserHistoryRecorder?: BrowserHistoryRecorder;
  }) {
    this.viewManager = deps.viewManager;
    this.panelRegistry = deps.panelRegistry;
    this.serverInfo = deps.serverInfo;
    this.cdpHost = deps.cdpHost;
    this.panelOrchestrator = deps.panelOrchestrator;
    this.externalHost = deps.serverInfo.externalHost;
    this.sendPanelEvent = deps.sendPanelEvent;
    this.autofillManager = deps.autofillManager;
    this.autofillPreloadPath = deps.autofillPreloadPath;
    this.panelPreloadPath = deps.panelPreloadPath;
    this.appPreloadPath = deps.appPreloadPath;
    this.browserPreloadPath = deps.browserPreloadPath;
    this.browserHistoryRecorder = deps.browserHistoryRecorder;
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
      id: panelId,
      type: "panel",
      preload: this.panelPreloadPath ?? null,
      url,
      parentId: parentId ?? undefined,
      partition: contextId ? contextIdToPartition(contextId) : undefined,
      injectHostThemeVariables: true,
    });

    this.setupBrowserStateTracking(panelId, view.webContents);

    // Register immediately so CDP access checks pass before dom-ready.
    // Root panels are CDP targets too; parentage is no longer an auth input.
    this.cdpHost.registerTarget(panelId, view.webContents.id);
    const domReadyHandler = () => {
      this.cdpHost.registerTarget(panelId, view.webContents.id);
    };
    view.webContents.on("dom-ready", domReadyHandler);
    this.contentLoadHandlers.set(panelId, { domReady: domReadyHandler });

    this.setupLinkInterception(panelId, view.webContents);
  }

  async createViewForApp(
    appId: string,
    url: string,
    contextId?: string,
    capabilities?: readonly AppCapability[],
    identity?: { source?: string; effectiveVersion?: string | null }
  ): Promise<void> {
    if (this.viewManager.hasView(appId)) {
      const currentUrl = this.viewManager.getViewUrl(appId);
      if (currentUrl !== url) {
        await this.viewManager.updateAppView(appId, url, capabilities, identity);
      }
      return;
    }
    if (!this.appPreloadPath) {
      throw new Error("App preload is required for privileged app views");
    }

    const view = this.viewManager.createView({
      id: appId,
      type: "app",
      preload: this.appPreloadPath,
      url,
      partition: contextId ? contextIdToPartition(contextId) : undefined,
      injectHostThemeVariables: true,
      appCapabilities: capabilities,
      hostChrome: capabilities?.includes("panel-hosting") ?? false,
      appIdentity: identity,
    });

    this.setupBrowserStateTracking(appId, view.webContents);
    this.setupLinkInterception(appId, view.webContents);
  }

  setViewVisible(panelId: string, visible: boolean): void {
    this.viewManager.setViewVisible(panelId, visible);
  }

  hasView(panelId: string): boolean {
    return this.viewManager.hasView(panelId);
  }

  destroyView(panelId: string): void {
    const contents = this.viewManager.getWebContents(panelId);
    if (this.autofillManager && contents && !contents.isDestroyed()) {
      this.autofillManager.detachFromWebContents(contents.id, contents);
    }
    this.cleanupBrowserStateTracking(panelId, contents ?? undefined);
    this.cleanupLinkInterception(panelId, contents ?? undefined);
    this.cdpHost.cleanupPanelAccess(panelId);
    this.cdpHost.unregisterTarget(panelId);
    this.crashHistory.delete(panelId);
    this.viewManager.destroyView(panelId);
  }

  reloadView(panelId: string): boolean {
    return this.viewManager.reloadView(panelId);
  }

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
  async createViewForBrowser(panelId: string, url: string, _contextId: string): Promise<void> {
    if (this.viewManager.hasView(panelId)) {
      const currentUrl = this.viewManager.getViewUrl(panelId);
      if (currentUrl !== url) void this.viewManager.navigateView(panelId, url);
      return;
    }

    const parentId = this.panelRegistry.findParentId(panelId);

    const view = this.viewManager.createView({
      id: panelId,
      type: "panel",
      preload: this.browserPreloadPath ?? this.autofillPreloadPath ?? null,
      url,
      parentId: parentId ?? undefined,
      partition: BROWSER_SESSION_PARTITION,
      injectHostThemeVariables: false,
    });

    this.setupBrowserStateTracking(panelId, view.webContents);

    // Register immediately so CDP access checks pass before dom-ready.
    // Root panels are CDP targets too; parentage is no longer an auth input.
    this.cdpHost.registerTarget(panelId, view.webContents.id);
    const domReadyHandler = () => {
      this.cdpHost.registerTarget(panelId, view.webContents.id);
    };
    view.webContents.on("dom-ready", domReadyHandler);
    this.contentLoadHandlers.set(panelId, { domReady: domReadyHandler });

    // Attach autofill for browser panels
    if (this.autofillManager) {
      this.autofillManager.attachToWebContents(view.webContents.id, view.webContents);
    }

    // No setupLinkInterception — browser panels navigate freely
  }

  // ==== Additional public methods ===========================================

  openDevTools(panelId: string): void {
    this.viewManager.openDevTools(panelId);
  }
  getViewPartition(panelId: string): string | undefined | null {
    return this.viewManager.getViewPartition(panelId);
  }
  getViewManager(): ViewManager {
    return this.viewManager;
  }
  markBrowserNavigationIntent(panelId: string, intent: BrowserNavigationIntent): void {
    this.browserHistoryRecorder?.markNext(panelId, intent);
  }

  /** Handle a view crash — implements recovery policy with loop protection. */
  handleViewCrashed(viewId: string, reason: string): void {
    console.warn(`[PanelView] View ${viewId} crashed: ${reason}`);
    void logMemorySnapshot({ reason: `view-crash:${viewId}:${reason}` });

    if (!this.shouldAttemptReload(viewId)) {
      console.error(`[PanelView] Giving up on ${viewId} after repeated crashes`);
      this.showPanelErrorPage(
        viewId,
        "Panel crashed repeatedly",
        `The panel's renderer crashed ${this.MAX_CRASHES} times in a row (last reason: ${reason}). ` +
          "Automatic recovery was stopped to avoid a crash loop."
      );
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
    let pendingState: Partial<PanelNavigationState> = {};
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
        const panel = this.panelRegistry.getPanel(panelId);
        if (!panel) return;
        const currentSource = getPanelSource(panel);
        if (isBrowserPanelSource(currentSource) && /^https?:\/\//i.test(url)) {
          this.browserHistoryRecorder?.recordNavigation(panelId, url, panel.navigation?.pageTitle);
          const nextSource = panelSourceFromBrowserUrl(url);
          if (nextSource !== currentSource) {
            void this.panelOrchestrator
              .replaceCurrentSnapshot(panelId, getPanelContextId(panel), nextSource)
              .catch(() => {});
          }
          return;
        }

        const parsed = parsePanelUrl(url, this.externalHost);
        if (parsed && parsed.source !== currentSource) {
          void this.panelOrchestrator
            .replaceCurrentSnapshot(panelId, getPanelContextId(panel), parsed.source)
            .catch(() => {});
        }
      },
      didNavigateInPage: (_event: Electron.Event, url: string) => {
        queueStateUpdate({ url });
      },
      didFailLoad: (
        _e: Electron.Event,
        code: number,
        desc: string,
        url: string,
        isMainFrame?: boolean
      ) => {
        console.warn(`[PanelView] Panel ${panelId} failed to load: ${desc} (${code}) - ${url}`);
        // -3 is ERR_ABORTED (navigation superseded) — routine, not a failure.
        if (isMainFrame && code !== -3) {
          this.showPanelErrorPage(
            panelId,
            "Panel failed to load",
            `${desc} (${code}) while loading ${url}`,
            url
          );
        }
      },
      renderProcessGone: (_e: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
        console.warn(`[PanelView] Panel ${panelId} render process gone: ${details.reason}`);
      },
      unresponsive: () => {
        console.warn(`[PanelView] Panel ${panelId} became unresponsive`);
      },
      responsive: () => {
        log.verbose(` Panel ${panelId} became responsive again`);
      },
      didStartLoading: () => {
        queueStateUpdate({ isLoading: true });
      },
      didStopLoading: () => {
        if (contents.isDestroyed()) return;
        queueStateUpdate({
          isLoading: false,
          canGoBack: contents.canGoBack(),
          canGoForward: contents.canGoForward(),
        });
      },
      pageTitleUpdated: (_event: Electron.Event, title: string) => {
        queueStateUpdate({ pageTitle: title });
        const panel = this.panelRegistry.getPanel(panelId);
        const url = panel?.navigation?.url ?? contents.getURL();
        if (panel && isBrowserPanelSource(getPanelSource(panel))) {
          this.browserHistoryRecorder?.updateTitle(url, title);
        }
      },
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
  private updatePanelState(panelId: string, state: PanelNavigationState): void {
    const panel = this.panelRegistry.getPanel(panelId);
    if (!panel) return;

    updatePanelNavigationState(panel, state);

    if (state.pageTitle !== undefined) {
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
        void this.panelOrchestrator
          .createPanel(panelId, parsed.source, parsed.options, parsed.stateArgs)
          .catch((err: unknown) => this.handleChildCreationError(panelId, err, url));
        return { action: "deny" as const };
      }
      if (/^https?:\/\//i.test(url)) {
        void this.panelOrchestrator
          .createBrowserUrlPanel(panelId, url, { focus: true })
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
          void this.panelOrchestrator
            .createBrowserUrlPanel(panelId, url, { focus: true })
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
      const refChanged = parsed.ref !== getPanelRef(panel);
      if (!sourceChanged && !contextChanged && !refChanged) return;

      event.preventDefault();
      void this.handleManagedNavigation(
        panelId,
        panel,
        parsed.source,
        targetContextId,
        parsed.ref,
        parsed.stateArgs
      ).catch((err) => log.warn(`[PanelNav] Navigation failed for ${panelId}:`, err));
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
    ref?: string,
    stateArgs?: Record<string, unknown>
  ): Promise<void> {
    log.info(
      `[PanelNav] Panel ${panelId}: ${getPanelSource(panel)} -> ${source} (context ${getPanelContextId(panel)} -> ${newContextId})`
    );
    await this.panelOrchestrator.navigatePanel(panelId, source, {
      contextId: newContextId,
      ref,
      stateArgs,
    });
  }

  // ==== Crash recovery ======================================================

  /**
   * Replace a dead/blank panel with a visible error page instead of leaving
   * it empty. Loading a data: URL spawns a fresh renderer, so this works even
   * after the previous renderer process is gone. The retry link re-navigates
   * to the panel's real URL.
   */
  private showPanelErrorPage(
    panelId: string,
    title: string,
    detail: string,
    retryUrl?: string
  ): void {
    const contents = this.viewManager.getWebContents(panelId);
    if (!contents || contents.isDestroyed()) return;
    const panel = this.panelRegistry.getPanel(panelId);
    const targetUrl = retryUrl ?? (panel ? getCurrentSnapshot(panel).resolvedUrl : null);
    const escapeHtml = (text: string) =>
      text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
  body { font-family: system-ui, sans-serif; background: #1e1e1e; color: #ddd;
         display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .box { max-width: 560px; padding: 2rem; }
  h1 { font-size: 1.1rem; color: #f48771; }
  p { font-size: 0.9rem; line-height: 1.5; color: #aaa; word-break: break-word; }
  a { color: #4fc1ff; }
</style></head><body><div class="box">
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(detail)}</p>
  ${targetUrl ? `<p><a href="${escapeHtml(targetUrl)}">Reload panel</a></p>` : ""}
</div></body></html>`;
    void contents
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .catch(() => {});
  }

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
    if (!panel) {
      console.error(`[PanelView] Cannot recreate view: panel ${panelId} not found`);
      return;
    }

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
      console.error(
        `[PanelView] Failed to recreate view for ${panelId}:`,
        error instanceof Error ? error.message : error
      );
      panel.artifacts = { buildState: "pending" };
      this.panelRegistry.notifyPanelTreeUpdate();
    }
  }
}
