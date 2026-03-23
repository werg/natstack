/**
 * PanelView — Electron-only view management service.
 *
 * Manages WebContentsView lifecycle: creating views, tracking browser state,
 * intercepting navigation, and handling crashes. Implements PanelViewLike so
 * PanelLifecycle can drive view creation without Electron imports.
 */

import { randomBytes } from "crypto";
import { createDevLogger } from "@natstack/dev-log";
import type { ViewManager } from "./viewManager.js";
import type { PanelRegistry } from "../shared/panelRegistry.js";
import type { TokenManager } from "../shared/tokenManager.js";
import type { PanelViewLike, PanelHttpServerLike, ServerInfoLike } from "../shared/panelLifecycle.js";
import { BROWSER_SESSION_PARTITION } from "../shared/panelInterfaces.js";
import { getCurrentSnapshot, getPanelSource, getPanelContextId, loadPanelManifest } from "../shared/panelTypes.js";
import { contextIdToSubdomain } from "../shared/panelIdUtils.js";
import type { Panel, PanelSnapshot } from "../shared/types.js";
import { logMemorySnapshot } from "./memoryMonitor.js";
import { getPanelPersistence } from "../shared/db/panelPersistence.js";
import { getPanelSearchIndex } from "../shared/db/panelSearchIndex.js";
import * as path from "path";

const log = createDevLogger("PanelView");

/**
 * Re-derive manifest-backed snapshot fields (currently only autoArchiveWhenEmpty)
 * from the new source's manifest. Called when a panel navigates to a different source.
 */
export function syncSnapshotFromManifest(
  snapshot: PanelSnapshot,
  newSource: string,
  sourceRoot: string,
): void {
  let autoArchive: boolean | undefined;
  try {
    const manifest = loadPanelManifest(path.join(sourceRoot, newSource));
    autoArchive = manifest.autoArchiveWhenEmpty;
  } catch {
    // Manifest not loadable (e.g., browser panel) — clear the flag
  }
  if (autoArchive) {
    snapshot.autoArchiveWhenEmpty = true;
  } else {
    delete snapshot.autoArchiveWhenEmpty;
  }
}

// Narrow interfaces for dependencies
interface CdpServerLike {
  registerBrowser(panelId: string, contentsId: number, parentId: string): void;
  unregisterBrowser(panelId: string): void;
  revokeTokenForPanel(panelId: string): void;
}

interface PanelLifecycleLike {
  createPanel(
    callerId: string, source: string,
    options?: { name?: string; contextId?: string; focus?: boolean; env?: Record<string, string> },
    stateArgs?: Record<string, unknown>,
  ): Promise<{ id: string; title: string }>;
  createBrowserPanel(
    callerId: string, url: string,
    options?: { name?: string; focus?: boolean },
  ): Promise<{ id: string; title: string }>;
  updatePanelContext(panelId: string, contextId: string): void;
}

interface AutofillManagerLike {
  attachToWebContents(webContentsId: number, webContents: Electron.WebContents): void;
  detachFromWebContents(webContentsId: number, webContents?: Electron.WebContents): void;
}

type ParsedPanelUrl = {
  source: string;
  contextId?: string;
  options: { name?: string; contextId?: string; focus?: boolean };
  stateArgs?: Record<string, unknown>;
};

export class PanelView implements PanelViewLike {
  private viewManager: ViewManager;
  private readonly panelRegistry: PanelRegistry;
  private readonly tokenManager: TokenManager;
  private readonly panelHttpServer: PanelHttpServerLike | null;
  private readonly panelHttpPort: number | null;
  private readonly rpcPort: number | null;
  private readonly serverInfo: ServerInfoLike;
  private readonly cdpServer: CdpServerLike;
  private readonly panelLifecycle: PanelLifecycleLike;
  private readonly sourceRoot: string;
  private sendToClient?: (callerId: string, msg: unknown) => void;
  private autofillManager?: AutofillManagerLike;
  private autofillPreloadPath?: string;

  private browserStateCleanup = new Map<string, { cleanup: () => void; destroyedHandler: () => void }>();
  private linkInterceptionHandlers = new Map<string, (event: Electron.Event, url: string) => void>();
  private contentLoadHandlers = new Map<string, { domReady?: () => void; didFinishLoad?: () => void }>();
  private crashHistory = new Map<string, number[]>();
  private readonly MAX_CRASHES = 3;
  private readonly CRASH_WINDOW_MS = 60000;

  constructor(deps: {
    viewManager: ViewManager;
    panelRegistry: PanelRegistry;
    tokenManager: TokenManager;
    panelHttpServer: PanelHttpServerLike | null;
    panelHttpPort: number | null;
    rpcPort: number | null;
    serverInfo: ServerInfoLike;
    cdpServer: CdpServerLike;
    panelLifecycle: PanelLifecycleLike;
    sourceRoot: string;
    sendToClient?: (callerId: string, msg: unknown) => void;
    autofillManager?: AutofillManagerLike;
    autofillPreloadPath?: string;
  }) {
    this.viewManager = deps.viewManager;
    this.panelRegistry = deps.panelRegistry;
    this.tokenManager = deps.tokenManager;
    this.panelHttpServer = deps.panelHttpServer;
    this.panelHttpPort = deps.panelHttpPort;
    this.rpcPort = deps.rpcPort;
    this.serverInfo = deps.serverInfo;
    this.cdpServer = deps.cdpServer;
    this.panelLifecycle = deps.panelLifecycle;
    this.sourceRoot = deps.sourceRoot;
    this.sendToClient = deps.sendToClient;
    this.autofillManager = deps.autofillManager;
    this.autofillPreloadPath = deps.autofillPreloadPath;
  }

  // ==== PanelViewLike implementation ========================================

  async createViewForPanel(panelId: string, url: string, contextId?: string): Promise<void> {
    if (this.viewManager.hasView(panelId)) {
      const currentUrl = this.viewManager.getViewUrl(panelId);
      if (currentUrl !== url) void this.viewManager.navigateView(panelId, url);
      return;
    }

    const panel = this.panelRegistry.getPanel(panelId);
    const parentId = this.panelRegistry.findParentId(panelId);

    // Set auth cookies before creating the view
    let viewUrl = url;
    if (this.panelHttpServer && this.panelHttpPort && panel) {
      viewUrl = await this.setAuthCookiesAndBuildUrl(panelId, panel, contextId);
    }

    const view = this.viewManager.createView({
      id: panelId, type: "panel", preload: null,
      url: viewUrl, parentId: parentId ?? undefined,
      injectHostThemeVariables: true,
    });

    this.setupBrowserStateTracking(panelId, view.webContents);

    if (parentId) {
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
      preload: this.autofillPreloadPath ?? null,
      url, parentId: parentId ?? undefined,
      partition: BROWSER_SESSION_PARTITION,
      injectHostThemeVariables: false,
    });

    this.setupBrowserStateTracking(panelId, view.webContents);

    if (parentId) {
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

  // ==== Auth cookie helper ==================================================

  /** Set subdomain auth + boot cookies and return the authenticated URL. */
  private async setAuthCookiesAndBuildUrl(
    panelId: string, panel: Panel, contextId?: string,
  ): Promise<string> {
    const ctxId = contextId ?? getPanelContextId(panel);
    const subdomain = contextIdToSubdomain(ctxId);
    const source = getPanelSource(panel);
    const rpcToken = this.tokenManager.ensureToken(panelId, "panel");
    const origin = `http://${subdomain}.localhost:${this.panelHttpPort}`;
    const bk = randomBytes(8).toString("hex");

    const sid = this.panelHttpServer!.ensureSubdomainSession(subdomain);
    const { session: electronSession } = await import("electron");
    await electronSession.defaultSession.cookies.set({
      url: `${origin}/`, name: "_ns_session", value: sid,
      path: "/", httpOnly: true, sameSite: "strict",
    });
    await electronSession.defaultSession.cookies.set({
      url: `${origin}/`, name: `_ns_boot_${bk}`,
      value: encodeURIComponent(JSON.stringify({ pid: panelId, rpcPort: this.rpcPort!, rpcToken })),
      path: "/", httpOnly: false, sameSite: "strict",
      expirationDate: Math.floor(Date.now() / 1000) + 60,
    });

    const serverRpcToken = await this.serverInfo.ensurePanelToken(panelId, "panel");
    return `${origin}/${source}/?pid=${encodeURIComponent(panelId)}&_bk=${bk}&rpcPort=${this.rpcPort!}&rpcToken=${encodeURIComponent(rpcToken)}&serverRpcPort=${this.serverInfo.rpcPort}&serverRpcToken=${encodeURIComponent(serverRpcToken)}`;
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
            this.syncSnapshotWithSource(panel, pathSource);
            this.panelRegistry.persistPanel(panel, this.panelRegistry.findParentId(panelId));
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
      try { getPanelPersistence().setTitle(panelId, state.pageTitle); }
      catch (error) { console.error(`[PanelView] Failed to persist title for ${panelId}:`, error); }
      try { getPanelSearchIndex().updateTitle(panelId, state.pageTitle); } catch {}
    }
    this.panelRegistry.notifyPanelTreeUpdate();
  }

  // ==== Link interception ===================================================

  private setupLinkInterception(panelId: string, contents: Electron.WebContents): void {
    contents.setWindowOpenHandler((details) => {
      const url = details.url;
      const parsed = this.parseLocalhostUrl(url);
      if (parsed) {
        void this.panelLifecycle.createPanel(panelId, parsed.source, parsed.options, parsed.stateArgs)
          .catch((err: unknown) => this.handleChildCreationError(panelId, err, url));
        return { action: "deny" as const };
      }
      if (/^https?:\/\//i.test(url)) {
        void this.panelLifecycle.createBrowserPanel(panelId, url, { focus: true })
          .then(({ id }) => {
            this.sendToClient?.(panelId, {
              type: "ws:event", event: "panel:event",
              payload: { panelId, type: "child-created", childId: id, url },
            });
          })
          .catch((err: unknown) => this.handleChildCreationError(panelId, err, url));
        return { action: "deny" as const };
      }
      return { action: "deny" as const };
    });

    const willNavigateHandler = (event: Electron.Event, url: string) => {
      if (!url.includes(".localhost:") && !url.includes("//localhost:")) {
        if (/^https?:\/\//i.test(url)) {
          event.preventDefault();
          void this.panelLifecycle.createBrowserPanel(panelId, url, { focus: true })
            .then(({ id }) => {
              this.sendToClient?.(panelId, {
                type: "ws:event", event: "panel:event",
                payload: { panelId, type: "child-created", childId: id, url },
              });
            })
            .catch((err: unknown) => this.handleChildCreationError(panelId, err, url));
        }
        return;
      }

      const panel = this.panelRegistry.getPanel(panelId);
      if (!panel || !this.panelHttpServer || !this.panelHttpPort) return;

      const currentSubdomain = contextIdToSubdomain(getPanelContextId(panel));
      try {
        const targetUrl = new URL(url);
        const targetSubdomain = targetUrl.hostname.endsWith(".localhost")
          ? targetUrl.hostname.slice(0, -".localhost".length) : null;
        if (!targetSubdomain || targetSubdomain === currentSubdomain) return;

        event.preventDefault();
        void this.handleCrossContextNavigation(panelId, panel, targetUrl, targetSubdomain)
          .catch((err) => log.warn(`[CrossCtx] Navigation failed for ${panelId}:`, err));
      } catch { /* not a valid URL */ }
    };

    this.linkInterceptionHandlers.set(panelId, willNavigateHandler);
    contents.on("will-navigate", willNavigateHandler);
  }

  private parseLocalhostUrl(url: string): ParsedPanelUrl | null {
    try {
      const u = new URL(url);
      if (!u.hostname.endsWith(".localhost") && u.hostname !== "localhost") return null;

      const match = u.pathname.match(/^\/([^/]+\/[^/]+)(\/.*)?$/);
      if (!match) return null;
      const source = match[1]!;
      if ((match[2] || "/") !== "/") return null;
      if (u.searchParams.has("_bk") || u.searchParams.has("pid") || u.searchParams.has("_fresh")) return null;

      return {
        source,
        contextId: u.searchParams.get("contextId") ?? undefined,
        options: {
          contextId: u.searchParams.get("contextId") ?? undefined,
          name: u.searchParams.get("name") ?? undefined,
          focus: u.searchParams.get("focus") === "true" || undefined,
        },
        stateArgs: u.searchParams.has("stateArgs") ? JSON.parse(u.searchParams.get("stateArgs")!) : undefined,
      };
    } catch { return null; }
  }

  private cleanupLinkInterception(panelId: string, contents?: Electron.WebContents): void {
    const handler = this.linkInterceptionHandlers.get(panelId);
    if (handler) {
      if (contents && !contents.isDestroyed()) contents.off("will-navigate", handler);
      this.linkInterceptionHandlers.delete(panelId);
    }
  }

  /**
   * Sync manifest-derived snapshot fields after a source change.
   */
  private syncSnapshotWithSource(panel: Panel, newSource: string): void {
    syncSnapshotFromManifest(panel.snapshot, newSource, this.sourceRoot);
  }

  private handleChildCreationError(parentId: string, error: unknown, url: string): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[PanelView] Failed to create child from ${url}:`, error);
    this.sendToClient?.(parentId, {
      type: "ws:event", event: "panel:event",
      payload: { panelId: parentId, type: "child-creation-error", url, error: message },
    });
  }

  // ==== Cross-context navigation ============================================

  /**
   * Handle cross-subdomain navigation: update panel context in-place and
   * re-navigate with proper auth cookies.
   */
  private async handleCrossContextNavigation(
    panelId: string, panel: Panel, targetUrl: URL, targetSubdomain: string,
  ): Promise<void> {
    if (!this.panelHttpServer || !this.panelHttpPort) return;

    const pathMatch = targetUrl.pathname.match(/^\/([^/]+\/[^/]+)(\/.*)?$/);
    if (!pathMatch) { log.warn(`[CrossCtx] Cannot parse source from URL: ${targetUrl.href}`); return; }
    const source = pathMatch[1]!;

    let stateArgs: Record<string, unknown> | undefined;
    if (targetUrl.searchParams.has("stateArgs")) {
      try { stateArgs = JSON.parse(targetUrl.searchParams.get("stateArgs")!); } catch {}
    }

    const newContextId = targetUrl.searchParams.get("contextId") ?? targetSubdomain;
    log.info(`[CrossCtx] Panel ${panelId}: context switch ${contextIdToSubdomain(getPanelContextId(panel))} -> ${targetSubdomain} (source: ${source})`);

    const oldContextId = panel.snapshot.contextId;
    const oldSource = panel.snapshot.source;
    const oldStateArgs = panel.snapshot.stateArgs;
    const oldAutoArchive = panel.snapshot.autoArchiveWhenEmpty;

    try {
      const rpcToken = this.tokenManager.ensureToken(panelId, "panel");
      const origin = `http://${targetSubdomain}.localhost:${this.panelHttpPort}`;
      const bk = randomBytes(8).toString("hex");

      const sid = this.panelHttpServer.ensureSubdomainSession(targetSubdomain);
      const { session: electronSession } = await import("electron");
      await electronSession.defaultSession.cookies.set({
        url: `${origin}/`, name: "_ns_session", value: sid,
        path: "/", httpOnly: true, sameSite: "strict",
      });
      await electronSession.defaultSession.cookies.set({
        url: `${origin}/`, name: `_ns_boot_${bk}`,
        value: encodeURIComponent(JSON.stringify({ pid: panelId, rpcPort: this.rpcPort!, rpcToken })),
        path: "/", httpOnly: false, sameSite: "strict",
        expirationDate: Math.floor(Date.now() / 1000) + 60,
      });

      const serverRpcToken = await this.serverInfo.ensurePanelToken(panelId, "panel");
      const authUrl = `${origin}/${source}/?pid=${encodeURIComponent(panelId)}&_bk=${bk}&rpcPort=${this.rpcPort!}&rpcToken=${encodeURIComponent(rpcToken)}&serverRpcPort=${this.serverInfo.rpcPort}&serverRpcToken=${encodeURIComponent(serverRpcToken)}`;

      panel.snapshot.contextId = newContextId;
      panel.snapshot.source = source;
      this.syncSnapshotWithSource(panel, source);
      if (stateArgs !== undefined) panel.snapshot.stateArgs = stateArgs;

      // Update fsService mapping so RPC-backed fs calls route to the new context
      this.panelLifecycle.updatePanelContext(panelId, newContextId);

      await this.viewManager.navigateView(panelId, authUrl);

      this.panelRegistry.persistPanel(panel, this.panelRegistry.findParentId(panelId));
      this.panelRegistry.notifyPanelTreeUpdate();
    } catch (err) {
      panel.snapshot.contextId = oldContextId;
      panel.snapshot.source = oldSource;
      panel.snapshot.stateArgs = oldStateArgs;
      if (oldAutoArchive) {
        panel.snapshot.autoArchiveWhenEmpty = true;
      } else {
        delete panel.snapshot.autoArchiveWhenEmpty;
      }
      // Restore old fs context mapping on failure
      if (oldContextId) this.panelLifecycle.updatePanelContext(panelId, oldContextId);
      throw err;
    }
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
