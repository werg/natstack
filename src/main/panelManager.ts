import * as path from "path";
import * as fs from "fs";
import { randomBytes } from "crypto";
import { nativeTheme } from "electron";
import { createDevLogger } from "./devLog.js";

const log = createDevLogger("PanelManager");
import type { PanelEventPayload, Panel, PanelManifest, PanelSnapshot } from "./panelTypes.js";
import {
  loadPanelManifest,
  getCurrentSnapshot,
  getPanelType,
  getPanelSource,
  getPanelOptions,
  getPanelContextId,
  createSnapshot,
  createNavigationSnapshot,
  canGoBack,
  canGoForward,
  getShellPage,
  getBrowserResolvedUrl,
  getPushState,
  getPanelStateArgs,
} from "./panelTypes.js";
import { validateStateArgs } from "./stateArgsValidator.js";
import type { StateArgsValue } from "../shared/stateArgs.js";
import { getActiveWorkspace } from "./paths.js";
import type { ServerInfo } from "./serverInfo.js";
import { normalizeRelativePanelPath } from "./pathUtils.js";
import type { FsService } from "./fsService.js";
import {
  computePanelId as _computePanelId,
  sanitizePanelIdSegment as _sanitizePanelIdSegment,
  generatePanelNonce as _generatePanelNonce,
} from "../shared/panelIdUtils.js";
import * as SharedPanel from "../shared/types.js";
import { getClaudeCodeConversationManager } from "./ai/claudeCodeConversationManager.js";
import {
  contextIdToSubdomain,
  PanelHttpServer,
  type PanelConfig as HttpPanelConfig,
} from "../server/panelHttpServer.js";
import { getCdpServer } from "./cdpServer.js";
// getPubSubServer no longer imported — pubsub config comes via ServerInfo
import { getTokenManager } from "./tokenManager.js";
import type { ViewManager } from "./viewManager.js";
import { parseNsUrl, type NsAction } from "./nsProtocol.js";
import { parseNsAboutUrl } from "./nsAboutProtocol.js";
import { parseNsFocusUrl } from "./nsFocusProtocol.js";
import { checkWorktreeClean, checkGitRepository } from "./gitChecks.js";
import { eventService } from "./services/eventsService.js";
import { getPanelPersistence } from "./db/panelPersistence.js";
import { getPanelSearchIndex } from "./db/panelSearchIndex.js";
import { extractAndIndexPageContent } from "./db/pageContentExtractor.js";
import { logMemorySnapshot } from "./memoryMonitor.js";

type PanelCreateOptions = {
  name?: string;
  env?: Record<string, string>;
  repoArgs?: Record<string, SharedPanel.RepoArgSpec>;
  /**
   * Explicit context ID for storage partition sharing.
   * If provided, the panel will use this context ID instead of generating a new one.
   * This enables multiple panels to share the same filesystem and storage partition.
   */
  contextId?: string;
  /** If true, immediately focus the new panel after creation (only applies to app panels) */
  focus?: boolean;
  /** If true, replace the caller panel instead of creating a sibling */
  replace?: boolean;
};

// =============================================================================
// Navigation State Utilities
// =============================================================================

/**
 * PanelManager - Manages the panel tree lifecycle.
 *
 * Panel tree data flow:
 * 1. SQLite DB (source of truth, persisted)
 * 2. PanelManager.panels Map (in-memory for fast access)
 * 3. Renderer PanelTreeContext (via panel-tree-updated events)
 *
 * On startup: DB -> PanelManager -> Event -> Renderer
 * On changes: PanelManager -> DB (persist) + Event (notify renderer)
 */
export class PanelManager {
  private viewManager: ViewManager | null = null;
  private panels: Map<string, Panel> = new Map();
  private reservedPanelIds: Set<string> = new Set();
  private rootPanels: Panel[] = [];
  private focusedPanelId: string | null = null;
  private currentTheme: "light" | "dark" = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  private panelsRoot: string;
  private serverInfo: ServerInfo;
  private pendingBrowserNavigations: Map<string, { url: string; index: number }> = new Map();
  private rpcServer: import("../server/rpcServer.js").RpcServer | null = null;
  private rpcPort: number | null = null;
  private panelHttpServer: PanelHttpServer | null = null;
  private panelHttpPort: number | null = null;
  private fsService: FsService | null = null;

  // Debounce state for panel tree updates
  private treeUpdatePending = false;
  private treeUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly TREE_UPDATE_DEBOUNCE_MS = 16; // ~1 frame at 60fps

  // Crash recovery policy
  private crashHistory = new Map<string, number[]>();
  private readonly MAX_CRASHES = 3;
  private readonly CRASH_WINDOW_MS = 60000; // 1 minute

  constructor(serverInfo: ServerInfo) {
    this.serverInfo = serverInfo;
    const workspace = getActiveWorkspace();
    this.panelsRoot = workspace?.path ?? path.resolve(process.cwd());
  }

  /**
   * Fetch about page build from the server and store in the about protocol.
   * Returns the protocol URL for the page.
   */
  /**
   * Build a shell page and store it in PanelHttpServer for HTTP serving.
   * Returns the HTTP URL for the panel.
   */
  private async buildAndStoreShellPage(panelId: string, page: string, panel: Panel): Promise<string> {
    const result = await this.serverInfo.call("build", "getBuild", [page]) as
      import("../server/buildV2/buildStore.js").BuildResult | null;

    if (!result || !result.bundle || !result.html) {
      throw new Error(`Shell page build not found: ${page}`);
    }

    // Ensure auth tokens exist (may not persist across restarts).
    // Use "panel" kind consistently — shell panels are panels, not the shell renderer.
    getTokenManager().ensureToken(panelId, "panel");
    await this.serverInfo.ensurePanelToken(panelId, "panel");

    const httpConfig = await this.buildPanelConfig(panel, `shell:${page}`);
    this.panelHttpServer!.storePanel(panelId, result, httpConfig);
    return this.panelHttpServer!.getPanelUrl(panelId)!;
  }

  /** Set the RPC server for WS-based communication */
  setFsService(service: FsService): void {
    this.fsService = service;
  }

  setRpcServer(server: import("../server/rpcServer.js").RpcServer): void {
    this.rpcServer = server;
  }

  /** Set the RPC server port for passing to panel preloads */
  setRpcPort(port: number): void {
    this.rpcPort = port;
  }

  /** Set the PanelHttpServer for serving panel content via HTTP subdomains */
  setPanelHttpServer(server: PanelHttpServer, port: number): void {
    this.panelHttpServer = server;
    this.panelHttpPort = port;
  }

  /**
   * Set the ViewManager for creating and managing panel views.
   * Must be called after window creation. This triggers panel tree initialization.
   */
  setViewManager(vm: ViewManager): void {
    this.viewManager = vm;

    // Register crash handler for view recovery
    vm.onViewCrashed((viewId, reason) => {
      this.handleViewCrashed(viewId, reason);
    });

    // Try to load existing panel tree from database first
    this.initializePanelTree().catch((error) => {
      console.error("[PanelManager] Failed to initialize panel tree:", error);
      eventService.emit("panel-initialization-error", {
        path: "",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Initialize the panel tree - load from DB if exists, otherwise show shell:new launcher.
   */
  private async initializePanelTree(): Promise<void> {
    const persistence = getPanelPersistence();

    try {
      // Try to load existing panels from database
      const existingPanels = persistence.getFullTree();

      if (existingPanels.length > 0) {
        // Clean up shell panels that have no children (they served their purpose)
        this.cleanupChildlessShellPanels(existingPanels, persistence);

        // Filter out panels that were archived during cleanup
        const remainingPanels = existingPanels.filter((p) => !persistence.isArchived(p.id));

        if (remainingPanels.length > 0) {
          // Restore panels from database
          log.verbose(` Restoring ${remainingPanels.length} root panel(s) from database`);
          this.rootPanels = remainingPanels;

          // Rebuild the panels map
          const buildPanelsMap = (panels: Panel[]) => {
            for (const panel of panels) {
              this.panels.set(panel.id, panel);
              if (panel.children.length > 0) {
                buildPanelsMap(panel.children);
              }
            }
          };
          buildPanelsMap(remainingPanels);

          // Register panel→context mappings for fs service routing (startup restore)
          if (this.fsService) {
            for (const panel of this.panels.values()) {
              const ctxId = getPanelContextId(panel);
              if (ctxId) {
                this.fsService.registerPanelContext(panel.id, ctxId);
              }
            }
          }

          // Create views for panels that have build artifacts ready
          this.restorePanelViews(remainingPanels);

          this.notifyPanelTreeUpdate();
        } else {
          // All panels were cleaned up - run init panels and show launcher
          console.log("[PanelManager] No panels remaining after cleanup, running initialization");
          await this.runInitPanelsAndLauncher();
        }
      } else {
        // No existing panels - run init panels and show launcher
        console.log("[PanelManager] No existing panels, running initialization");
        await this.runInitPanelsAndLauncher();
      }
    } catch (error) {
      console.error("[PanelManager] Failed to load panel tree from database:", error);
      // Reset to clean state
      this.rootPanels = [];
      this.panels.clear();

      // Fall back to launcher on error
      try {
        await this.createShellPanel("new");
      } catch (launcherError) {
        console.error("[PanelManager] Failed to create launcher panel:", launcherError);
      }
      // Re-throw to let setViewManager's catch block handle notification
      throw error;
    }
  }

  /**
   * Run workspace init panels and show the root panel (or launcher fallback).
   * Called when panel tree is empty (fresh install or after cleanup).
   */
  private async runInitPanelsAndLauncher(): Promise<void> {
    const workspace = getActiveWorkspace();
    const initPanels = workspace?.config.initPanels ?? [];

    // Create init panels first (they run in background, seeding data etc.)
    if (initPanels.length > 0) {
      log.verbose(` Creating ${initPanels.length} init panel(s) from workspace config`);
      for (const panelSource of initPanels) {
        try {
          const result = await this.createInitPanel(panelSource);
          log.verbose(` Created init panel: ${result.id}`);
        } catch (error) {
          console.error(`[PanelManager] Failed to create init panel ${panelSource}:`, error);
          // Continue with other init panels even if one fails
        }
      }
    }

    // If workspace defines a rootPanel, open it directly instead of the launcher
    const rootPanelSource = workspace?.config.rootPanel;
    if (rootPanelSource) {
      try {
        const result = await this.createInitPanel(rootPanelSource);
        log.verbose(` Created root panel from config: ${result.id}`);
        return;
      } catch (error) {
        console.error(`[PanelManager] Failed to create rootPanel "${rootPanelSource}", falling back to launcher:`, error);
      }
    }

    // Fallback: show the launcher
    await this.createShellPanel("new");
  }

  /**
   * Archive shell panels that have no children at startup/shutdown.
   *
   * Shell panels are launcher UIs (e.g., shell:new, shell:about) that exist
   * primarily to launch other panels. A childless shell panel indicates the
   * user opened a launcher but never launched anything from it. These serve
   * no purpose in the tree and should be cleaned up.
   *
   * Note: This only applies to shell-type panels, not app/worker/browser panels
   * which users might legitimately want to keep without children.
   */
  private cleanupChildlessShellPanels(
    panels: Panel[],
    persistence: ReturnType<typeof getPanelPersistence>
  ): void {
    for (const panel of panels) {
      // Recurse into children first (depth-first)
      if (panel.children.length > 0) {
        this.cleanupChildlessShellPanels(panel.children, persistence);
        // Re-check children after recursive cleanup (some may have been archived)
        panel.children = panel.children.filter((c) => !persistence.isArchived(c.id));
      }

      // Archive childless shell panels (except blocking pages like dirty-repo/git-init
      // which represent real panels navigated in-place for git resolution)
      const shellPage = getPanelType(panel) === "shell" ? getShellPage(panel) : undefined;
      if (shellPage && shellPage !== "dirty-repo" && shellPage !== "git-init" && panel.children.length === 0) {
        log.verbose(` Archiving childless shell panel: ${panel.id}`);
        try {
          persistence.archivePanel(panel.id);
        } catch (e) {
          // Best effort - don't fail startup if cleanup fails
          console.error(`[PanelManager] Failed to archive shell panel ${panel.id}:`, e);
        }
      }
    }
  }

  /**
   * Public method to run cleanup on app shutdown.
   * Archives childless shell panels so they don't clutter the tree on next startup.
   */
  public runShutdownCleanup(): void {
    console.log("[PanelManager] Running shutdown cleanup...");
    const persistence = getPanelPersistence();
    this.cleanupChildlessShellPanels(this.rootPanels, persistence);

    // Clear accumulated maps to prevent memory leaks
    this.crashHistory.clear();
    this.pendingBrowserNavigations.clear();
    this.browserStateCleanup.clear();
    this.linkInterceptionHandlers.clear();
    this.contentLoadHandlers.clear();

  }

  /**
   * Recursively restore panels from database.
   * App/worker panels are restored as unloaded and rebuild on focus.
   * Browser/shell panels recreate views directly.
   */
  private restorePanelViews(panels: Panel[]): void {
    for (const panel of panels) {
      try {
        const panelType = getPanelType(panel);
        if (panelType === "app") {
          // App panels rebuild only when focused/loaded.
          this.markPanelUnloaded(panel);
        } else if (panelType === "browser") {
          // Browser panel - can create view directly
          const browserUrl = getBrowserResolvedUrl(panel) ?? getPanelSource(panel);
          void this.createViewForPanel(panel.id, browserUrl, "browser", getPanelContextId(panel));
        } else if (panelType === "shell") {
          // Shell panel - can create view directly using about protocol
          void this.restoreShellPanel(panel);
        }
      } catch (error) {
        console.error(`[PanelManager] Failed to restore panel ${panel.id}:`, error);
      }

      // Recursively restore children
      if (panel.children.length > 0) {
        this.restorePanelViews(panel.children);
      }
    }
  }

  /**
   * Mark a panel as unloaded so it rebuilds when focused.
   * Keeps dirty/not-git-repo states intact (these are about repo state, not build errors).
   * Error states are reset to pending so panels rebuild on next focus.
   */
  private markPanelUnloaded(panel: Panel): void {
    const buildState = panel.artifacts?.buildState;

    const hasBuildArtifacts = Boolean(panel.artifacts?.htmlPath || panel.artifacts?.bundlePath);
    if (buildState === "pending" && !hasBuildArtifacts) {
      return;
    }

    panel.artifacts = {
      buildState: "pending",
      buildProgress: "Panel unloaded - will rebuild when focused",
    };
    this.persistArtifacts(panel.id, panel.artifacts);
  }

  /**
   * Restore a shell panel by building its page and creating the view.
   */
  private async restoreShellPanel(panel: Panel): Promise<void> {
    try {
      // Get the shell page from the snapshot
      const page = getShellPage(panel);
      if (!page) {
        throw new Error(`Panel ${panel.id} is not a shell panel`);
      }

      // Build and store shell page via PanelHttpServer
      const url = await this.buildAndStoreShellPage(panel.id, page, panel);

      // Create the view (unified code path — HTTP subdomain, no partition needed)
      await this.createViewForPanel(panel.id, url, "panel", getPanelContextId(panel));

      // Mark as ready and persist
      panel.artifacts = { buildState: "ready" };
      this.persistArtifacts(panel.id, panel.artifacts);
      this.notifyPanelTreeUpdate();
    } catch (error) {
      console.error(`[PanelManager] Failed to restore shell panel ${panel.id}:`, error);
      panel.artifacts = {
        buildState: "error",
        buildProgress: `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
      };
      this.persistArtifacts(panel.id, panel.artifacts);
      this.notifyPanelTreeUpdate();
    }
  }

  /**
   * Get the ViewManager (throws if not set).
   */
  getViewManager(): ViewManager {
    if (!this.viewManager) {
      throw new Error("ViewManager not set - call setViewManager first");
    }
    return this.viewManager;
  }

  /**
   * Create a WebContentsView for a panel or browser.
   * Called when panel build is ready or browser is created.
   * @param panelId - The panel's tree ID
   * @param url - The URL to load
   * @param type - The view type
   * @param contextId - The context ID for partition (required for panel, ignored for browser)
   * @throws Error if ViewManager is not set
   */
  async createViewForPanel(panelId: string, url: string, type: "panel" | "browser", contextId?: string): Promise<void> {
    if (!this.viewManager) {
      throw new Error(`[PanelManager] ViewManager not set, cannot create view for ${panelId}`);
    }

    if (this.viewManager.hasView(panelId)) {
      // View already exists, navigate if URL changed
      const currentUrl = this.viewManager.getViewUrl(panelId);
      if (currentUrl !== url) {
        void this.viewManager.navigateView(panelId, url);
      }
      return; // View exists and is handled
    }

    const panel = this.panels.get(panelId);
    const parentId = this.findParentId(panelId);

    if (type === "browser") {
      // Browser panels: adblock preload for cosmetic filtering, shared session for cookies/auth
      const view = this.viewManager.createView({
        id: panelId,
        type: "browser",
        // No partition = default session (shared across browsers)
        preload: this.viewManager.getAdblockPreloadPath(), // Adblock preload for cosmetic filtering
        url: url,
        parentId: parentId ?? undefined,
        injectHostThemeVariables: false,
      });

      // Register with CDP server when dom-ready (use named handler for cleanup)
      const handlers: { domReady?: () => void; didFinishLoad?: () => void } = {};
      if (parentId) {
        handlers.domReady = () => {
          getCdpServer().registerBrowser(panelId, view.webContents.id, parentId);
        };
        view.webContents.on("dom-ready", handlers.domReady);
      }

      // Track browser state changes
      this.setupBrowserStateTracking(panelId, view.webContents);

      // Extract and index page content for search (use named handler for cleanup)
      handlers.didFinishLoad = () => {
        extractAndIndexPageContent(panelId, view.webContents);
      };
      view.webContents.on("did-finish-load", handlers.didFinishLoad);
      this.contentLoadHandlers.set(panelId, handlers);

      // Intercept ns:// and new-window navigations for child creation
      this.setupLinkInterception(panelId, view.webContents, "browser");
    } else {
      const panelType = panel ? getPanelType(panel) : undefined;

      // All panels (app + shell) served via HTTP subdomain.
      // Globals injected via HTML by PanelHttpServer; subdomain origin isolation
      // replaces Electron partition-based isolation.
      const view = this.viewManager.createView({
        id: panelId,
        type: "panel",
        preload: null, // No preload — globals + transport injected in HTML
        url: url,
        parentId: parentId ?? undefined,
        injectHostThemeVariables: true,
      });

      // Track browser state (URL, loading, title) for all panel types including shell
      this.setupBrowserStateTracking(panelId, view.webContents);

      // CDP registration and content indexing are for app panels, not shell pages
      if (panelType !== "shell") {
        // Register app panels with CDP server for automation/testing (like browsers)
        // Use named handler for cleanup
        if (parentId) {
          const domReadyHandler = () => {
            getCdpServer().registerBrowser(panelId, view.webContents.id, parentId);
          };
          view.webContents.on("dom-ready", domReadyHandler);
          this.contentLoadHandlers.set(panelId, { domReady: domReadyHandler });
        }

        // Intercept ns:// and http(s) link clicks to create children
        this.setupLinkInterception(panelId, view.webContents, "panel");
      } else {
        // Shell pages still need link interception for ns:// and ns-about:// links
        this.setupLinkInterception(panelId, view.webContents, "panel");
      }
    }
  }

  /**
   * Setup webContents event tracking for browser state (URL, loading, navigation).
   */
  private setupBrowserStateTracking(panelId: string, contents: Electron.WebContents): void {
    let pendingState: Partial<SharedPanel.BrowserState & { url?: string }> = {};
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let cleaned = false;

    const flushPendingState = () => {
      if (cleaned) return; // Don't update after cleanup
      if (Object.keys(pendingState).length > 0) {
        this.updateBrowserState(panelId, pendingState);
        pendingState = {};
      }
      debounceTimer = null;
    };

    const queueStateUpdate = (update: typeof pendingState) => {
      if (cleaned) return; // Don't queue after cleanup
      Object.assign(pendingState, update);
      if (!debounceTimer) {
        debounceTimer = setTimeout(flushPendingState, 50);
      }
    };

    // Store named handlers for removal
    const handlers = {
      didNavigate: (_event: Electron.Event, url: string) => {
        log.verbose(` Panel ${panelId} navigated to: ${url}`);
        queueStateUpdate({ url });
      },
      didNavigateInPage: (_event: Electron.Event, url: string) => {
        queueStateUpdate({ url });
      },
      didFailLoad: (
        _event: Electron.Event,
        errorCode: number,
        errorDescription: string,
        validatedURL: string
      ) => {
        console.warn(
          `[PanelManager] Panel ${panelId} failed to load: ${errorDescription} (${errorCode}) - ${validatedURL}`
        );
      },
      renderProcessGone: (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
        console.warn(`[PanelManager] Panel ${panelId} render process gone: ${details.reason}`);
      },
      unresponsive: () => {
        console.warn(`[PanelManager] Panel ${panelId} became unresponsive`);
      },
      responsive: () => {
        log.verbose(` Panel ${panelId} became responsive again`);
      },
      didStartLoading: () => {
        queueStateUpdate({ isLoading: true });
      },
      didStopLoading: () => {
        // Guard against destroyed webContents (can happen if event fires during destruction)
        if (contents.isDestroyed()) return;
        queueStateUpdate({
          isLoading: false,
          canGoBack: contents.canGoBack(),
          canGoForward: contents.canGoForward(),
        });
      },
      pageTitleUpdated: (_event: Electron.Event, title: string) => {
        queueStateUpdate({ pageTitle: title });
      },
    };

    // Register all handlers
    contents.on("did-navigate", handlers.didNavigate);
    contents.on("did-navigate-in-page", handlers.didNavigateInPage);
    contents.on("did-fail-load", handlers.didFailLoad);
    contents.on("render-process-gone", handlers.renderProcessGone);
    contents.on("unresponsive", handlers.unresponsive);
    contents.on("responsive", handlers.responsive);
    contents.on("did-start-loading", handlers.didStartLoading);
    contents.on("did-stop-loading", handlers.didStopLoading);
    contents.on("page-title-updated", handlers.pageTitleUpdated);

    // Idempotent cleanup function
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

    // Auto-cleanup on destroy, but can also be called manually
    const destroyedHandler = () => cleanup();
    contents.once("destroyed", destroyedHandler);

    // Store both for manual cleanup (which should remove the destroyed handler)
    this.browserStateCleanup.set(panelId, { cleanup, destroyedHandler });
  }

  /**
   * Clean up browser state tracking for a panel.
   * Called in closePanel/unloadPanelResources.
   */
  private cleanupBrowserStateTracking(panelId: string, contents?: Electron.WebContents): void {
    const entry = this.browserStateCleanup.get(panelId);
    if (entry) {
      // Remove the destroyed handler to prevent double-cleanup
      if (contents && !contents.isDestroyed()) {
        contents.off("destroyed", entry.destroyedHandler);
      }
      entry.cleanup();
    }

    // Clean up content load handlers (dom-ready, did-finish-load)
    const loadHandlers = this.contentLoadHandlers.get(panelId);
    if (loadHandlers && contents && !contents.isDestroyed()) {
      if (loadHandlers.domReady) {
        contents.off("dom-ready", loadHandlers.domReady);
      }
      if (loadHandlers.didFinishLoad) {
        contents.off("did-finish-load", loadHandlers.didFinishLoad);
      }
    }
    this.contentLoadHandlers.delete(panelId);
  }

  private handleChildCreationError(parentId: string, error: unknown, url: string): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[PanelManager] Failed to create child from ${url}:`, error);
    this.sendPanelEvent(parentId, { type: "child-creation-error", url, error: message });
  }

  /**
   * Set up link interception for browser-like navigation.
   *
   * Click behavior:
   * - Normal click: Navigate in-place (unless action=child or ns-focus)
   * - Middle/Ctrl/Cmd-click or target="_blank": Create child (except ns-focus)
   *
   * Protocol handling:
   * - ns://         - Navigate to app panels and workers
   * - ns-about://   - Navigate to shell/about pages
   * - ns-focus://   - Focus an existing panel (never creates child)
   * - http(s)://    - Navigate to browser view (app panels) or allow (browser panels)
   */
  private setupLinkInterception(
    panelId: string,
    contents: Electron.WebContents,
    viewType: "panel" | "browser"
  ): void {
    // Intercept new-window requests (middle click / ctrl+click / target="_blank").
    // These always create children, except for ns-focus which focuses.
    contents.setWindowOpenHandler((details) => {
      const url = details.url;

      // ns-focus:// - Focus panel (special: never creates child)
      if (url.startsWith("ns-focus:")) {
        try {
          const { panelId: targetPanelId } = parseNsFocusUrl(url);
          this.focusPanel(targetPanelId);
        } catch (err) {
          console.error(`[PanelManager] Failed to parse ns-focus URL: ${url}`, err);
        }
        return { action: "deny" };
      }

      // ns:// - New navigation protocol (middle/ctrl-click always creates child)
      if (url.startsWith("ns:")) {
        try {
          const { source, contextId, repoArgs, env, stateArgs, name, focus } = parseNsUrl(url);
          this.createPanel(
            panelId,
            source,
            {
                            contextId,
              repoArgs,
              env,
              name,
              focus,
              replace: false, // Middle/ctrl-click always creates child
            },
            stateArgs
          ).catch((err: unknown) => this.handleChildCreationError(panelId, err, url));
        } catch (err) {
          this.handleChildCreationError(panelId, err, url);
        }
        return { action: "deny" };
      }

      // ns-about:// - Shell pages (middle/ctrl-click creates child)
      if (url.startsWith("ns-about:")) {
        try {
          const { page } = parseNsAboutUrl(url);
          this.createPanel(panelId, `shell:${page}`, { replace: false }).catch((err: unknown) =>
            this.handleChildCreationError(panelId, err, url)
          );
        } catch (err) {
          this.handleChildCreationError(panelId, err, url);
        }
        return { action: "deny" };
      }

      // http(s):// - Create browser child
      if (/^https?:/i.test(url)) {
        this.createBrowserChild(panelId, url).catch((err) =>
          this.handleChildCreationError(panelId, err, url)
        );
        return { action: "deny" };
      }

      return { action: "deny" };
    });

    // Intercept in-place navigations (normal left-click without modifiers).
    // Browser-like behavior: navigate in-place unless action=child.
    const willNavigateHandler = (event: Electron.Event, url: string) => {
      // ns-focus:// - Focus panel
      if (url.startsWith("ns-focus:")) {
        event.preventDefault();
        try {
          const { panelId: targetPanelId } = parseNsFocusUrl(url);
          this.focusPanel(targetPanelId);
        } catch (err) {
          console.error(`[PanelManager] Failed to parse ns-focus URL: ${url}`, err);
        }
        return;
      }

      // ns:// - Panel creation/navigation protocol
      if (url.startsWith("ns:")) {
        event.preventDefault();
        try {
          const { source, action, contextId, repoArgs, env, stateArgs, name, focus } = parseNsUrl(url);

          // Determine the operation:
          // 1. action=child → create child panel under caller
          // 2. shell panel + action=navigate → replace shell with new panel
          // 3. non-shell + action=navigate → navigate in place (mutate panel)
          const callerPanel = this.panels.get(panelId);
          const isShellPanel = callerPanel && getPanelType(callerPanel) === "shell";

          if (action === "child") {
            // Explicit child creation
            this.createPanel(
              panelId,
              source,
              {
                                contextId,
                repoArgs,
                env,
                name,
                focus,
                replace: false,
              },
              stateArgs
            ).catch((err: unknown) => this.handleChildCreationError(panelId, err, url));
          } else if (isShellPanel) {
            // Shell panels: replace with new panel (supports all options)
            this.createPanel(
              panelId,
              source,
              {
                                contextId,
                repoArgs,
                env,
                name,
                focus,
                replace: true,
              },
              stateArgs
            ).catch((err: unknown) => this.handleChildCreationError(panelId, err, url));
          } else if (contextId) {
            // Non-shell navigation with contextId: replace panel to get new storage partition
            // This is needed when panels (like chat-launcher) need to navigate to a panel
            // that uses a different storage context (like chat with a specific channel context)
            this.createPanel(
              panelId,
              source,
              {
                                contextId,
                repoArgs,
                env,
                name,
                focus,
                replace: true,
              },
              stateArgs
            ).catch((err: unknown) => this.handleChildCreationError(panelId, err, url));
          } else {
            // Non-shell navigation: mutate panel in place
            // env and stateArgs are supported (panel identity is preserved)
            // To use other options from non-shell, use action=child
            const targetType: SharedPanel.PanelType = "app";
            void this.navigatePanel(panelId, source, targetType, { env, stateArgs }).catch((err: unknown) =>
              this.handleChildCreationError(panelId, err, url)
            );
          }
        } catch (err) {
          this.handleChildCreationError(panelId, err, url);
        }
        return;
      }

      // ns-about:// - Navigate to shell page
      if (url.startsWith("ns-about:")) {
        event.preventDefault();
        try {
          const { page } = parseNsAboutUrl(url);
          void this.navigatePanel(panelId, `shell:${page}`, "shell").catch((err: unknown) =>
            this.handleChildCreationError(panelId, err, url)
          );
        } catch (err) {
          this.handleChildCreationError(panelId, err, url);
        }
        return;
      }

      // http(s):// handling
      if (/^https?:/i.test(url)) {
        if (viewType === "panel") {
          event.preventDefault();
          void this.navigatePanel(panelId, url, "browser").catch((err) =>
            this.handleChildCreationError(panelId, err, url)
          );
        }
        // Browser views: allow normal http(s) navigation in place
      }
    };

    // Store and register the handler for cleanup
    this.linkInterceptionHandlers.set(panelId, willNavigateHandler);
    contents.on("will-navigate", willNavigateHandler);
  }

  /**
   * Clean up link interception handler for a panel.
   * Called in closePanel/unloadPanelResources.
   */
  private cleanupLinkInterception(panelId: string, contents?: Electron.WebContents): void {
    const handler = this.linkInterceptionHandlers.get(panelId);
    if (handler) {
      if (contents && !contents.isDestroyed()) {
        contents.off("will-navigate", handler);
      }
      this.linkInterceptionHandlers.delete(panelId);
    }
  }

  /**
   * Focus a panel by its ID.
   * Switches the UI to show the specified panel.
   */
  private focusPanel(targetPanelId: string): void {
    // Find the panel
    const panel = this.getPanel(targetPanelId);
    if (!panel) {
      console.warn(`[PanelManager] Cannot focus panel - not found: ${targetPanelId}`);
      return;
    }

    this.updateSelectedPath(targetPanelId);
    this.notifyPanelTreeUpdate();

    // Emit focus event to the panel only if it has a view
    // Unloaded panels (pending state) don't have views yet
    if (this.viewManager?.hasView(targetPanelId)) {
      this.sendPanelEvent(targetPanelId, { type: "focus" });
    }

    // Notify shell to navigate to this panel
    eventService.emit("navigate-to-panel", { panelId: targetPanelId });
  }

  private normalizePanelPath(panelPath: string): { relativePath: string; absolutePath: string } {
    return normalizeRelativePanelPath(panelPath, this.panelsRoot);
  }

  // Panel ID utilities — delegated to shared module (src/shared/panelIdUtils.ts)
  private sanitizeIdSegment(segment: string): string { return _sanitizePanelIdSegment(segment); }
  private generatePanelNonce(): string { return _generatePanelNonce(); }
  private computePanelId(params: { relativePath: string; parent?: Panel | null; requestedId?: string; isRoot?: boolean }): string {
    return _computePanelId(params);
  }


  // Public methods for RPC services

  /**
   * Build env for a panel, merging base env with system env.
   * @param baseEnv - Existing panel env to preserve, or null if creating fresh
   */
  private async buildPanelEnv(
    panelId: string,
    baseEnv: Record<string, string> | null | undefined,
    gitInfo?: {
      sourceRepo: string;
      resolvedRepoArgs?: Record<string, SharedPanel.RepoArgSpec>;
    }
  ): Promise<Record<string, string> | undefined> {
    const gitToken = await this.serverInfo.getGitTokenForPanel(panelId);
    const serverUrl = this.serverInfo.gitBaseUrl;

    // Build full git config for bootstrap (eliminates need for RPC during bootstrap)
    const gitConfig = gitInfo
      ? JSON.stringify({
          serverUrl,
          token: gitToken,
          sourceRepo: gitInfo.sourceRepo,
          resolvedRepoArgs: gitInfo.resolvedRepoArgs ?? {},
        })
      : "";

    // Build pubsub config for real-time messaging
    const serverToken = await this.serverInfo.getPanelToken(panelId);
    const pubsubConfig = this.serverInfo.pubsubUrl
      ? JSON.stringify({
          serverUrl: this.serverInfo.pubsubUrl,
          token: serverToken,
        })
      : "";
    const workspacePath = getActiveWorkspace()?.path;

    // Pass critical environment variables that Node.js APIs depend on
    // (e.g., os.homedir() needs HOME, child processes need PATH)
    // Also include XDG paths used by SDKs on Linux for config/data storage
    const criticalEnv: Record<string, string> = {};
    for (const key of [
      "HOME",
      "USER",
      "PATH",
      "TMPDIR",
      "TEMP",
      "TMP",
      "SHELL",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
      "XDG_RUNTIME_DIR",
    ]) {
      if (process.env[key]) {
        criticalEnv[key] = process.env[key]!;
      }
    }

    return {
      ...criticalEnv,
      ...baseEnv,
      ...(workspacePath ? { NATSTACK_WORKSPACE: workspacePath } : {}),
      __GIT_SERVER_URL: serverUrl,
      __GIT_TOKEN: gitToken,
      __GIT_CONFIG: gitConfig,
      __PUBSUB_CONFIG: pubsubConfig,
    };
  }

  /**
   * Shared creation path for both root and child panels.
   * When replacePanel is provided, it replaces that panel in the tree at the same position.
   * Context ID is auto-generated as ctx_{instanceId} if not provided.
   *
   * Root panel modes:
   * - isRoot: true, addAsRoot: false (default) - Reset tree and create single root panel
   * - isRoot: true, addAsRoot: true - Add as root panel without resetting tree
   */
  private async createPanelFromManifest(params: {
    manifest: PanelManifest;
    relativePath: string;
    parent: Panel | null;
    options: PanelCreateOptions;
    isRoot?: boolean;
    addAsRoot?: boolean;
    replacePanel?: Panel;
    stateArgs?: Record<string, unknown>;
  }): Promise<{ id: string; type: SharedPanel.PanelType; title: string }> {
    const { manifest, relativePath, parent, options, isRoot, addAsRoot, replacePanel, stateArgs } = params;

    // Validate repoArgs: caller must provide exactly the args declared in manifest
    const declaredArgs = manifest.repoArgs ?? [];
    const providedArgs = options?.repoArgs ? Object.keys(options.repoArgs) : [];

    if (declaredArgs.length > 0 || providedArgs.length > 0) {
      const missingArgs = declaredArgs.filter((arg) => !providedArgs.includes(arg));
      const extraArgs = providedArgs.filter((arg) => !declaredArgs.includes(arg));

      if (missingArgs.length > 0) {
        throw new Error(
          `Panel "${relativePath}" requires repoArgs: ${missingArgs.join(", ")}`
        );
      }
      if (extraArgs.length > 0) {
        throw new Error(
          `Panel "${relativePath}" does not accept repoArgs: ${extraArgs.join(", ")}` +
          (declaredArgs.length === 0 ? " (manifest declares no repoArgs)" : "")
        );
      }
    }

    // Validate envArgs: required env vars must be provided
    const declaredEnvArgs = manifest.envArgs ?? [];
    const providedEnv = options?.env ?? {};
    const missingEnvArgs = declaredEnvArgs
      .filter((arg) => arg.required !== false && !arg.default)
      .filter((arg) => !providedEnv[arg.name])
      .map((arg) => arg.name);

    if (missingEnvArgs.length > 0) {
      throw new Error(
        `Panel "${relativePath}" requires env vars: ${missingEnvArgs.join(", ")}`
      );
    }

    // Validate stateArgs against manifest schema (applies defaults even if stateArgs undefined)
    let validatedStateArgs: StateArgsValue | undefined;
    if (stateArgs || manifest.stateArgs) {
      const validation = validateStateArgs(stateArgs ?? {}, manifest.stateArgs);
      if (!validation.success) {
        throw new Error(`Invalid stateArgs for ${relativePath}: ${validation.error}`);
      }
      validatedStateArgs = validation.data;
    }

    const panelId = this.computePanelId({
      relativePath,
      parent,
      requestedId: options?.name,
      isRoot,
    });

    if (this.panels.has(panelId) || this.reservedPanelIds.has(panelId)) {
      throw new Error(`A panel with id "${panelId}" is already running`);
    }

    this.reservedPanelIds.add(panelId);

    // Create auth tokens before resolveContext — it needs a git token via getGitTokenForPanel
    getTokenManager().createToken(panelId, "panel");              // Electron WS auth

    try {
      await this.serverInfo.createPanelToken(panelId, "panel");     // Server git/pubsub auth
      // Resolve context ID: use provided contextId if available, otherwise generate from panel ID
      const contextId = options.contextId ?? `ctx_${panelId.replace(/[/:]/g, "~")}`;

      // Register panel→context mapping for fs service routing
      this.fsService?.registerPanelContext(panelId, contextId);

      const panelEnv = await this.buildPanelEnv(panelId, options?.env, {
        sourceRepo: relativePath,
        resolvedRepoArgs: options?.repoArgs,
      });

      // Create the initial snapshot with all options and stateArgs
      const initialSnapshot = createSnapshot(
        relativePath,
        "app",
        contextId,
        {
          env: panelEnv,
          repoArgs: options.repoArgs,
        },
        validatedStateArgs
      );

      // Create the panel with history-based structure
      const panel: Panel = {
        id: panelId,
        title: manifest.title,
        children: [],
        selectedChildId: null,
        history: [initialSnapshot],
        historyIndex: 0,
        artifacts: {
          buildState: "building",
          buildProgress: "Starting build...",
        },
      };

      // IMPORTANT: replacePanel branch must come BEFORE isRoot check
      // to prevent root replacement from hitting the "reset everything" isRoot path
      if (replacePanel) {
        // Replace mode: clean up first, then insert new panel
        // This ensures cleanup code doesn't see the new panel while old is still live

        // Track selection and position before cleanup
        const wasSelected = parent ? parent.selectedChildId === replacePanel.id : false;
        let replaceIndex = -1;
        if (parent) {
          replaceIndex = parent.children.findIndex(c => c.id === replacePanel.id);
        } else {
          replaceIndex = this.rootPanels.findIndex(p => p.id === replacePanel.id);
        }

        // Validate that we found the panel (should always succeed)
        if (replaceIndex === -1) {
          // This shouldn't happen - replacePanel should be in tree
          // Log error and abort replacement to avoid corrupted state
          console.error(`[PanelManager] replacePanel ${replacePanel.id} not found in tree - aborting replacement`);
          throw new Error(`Cannot replace panel: ${replacePanel.id} not found in tree`);
        }

        // Remove from tree before cleanup to avoid iteration issues
        if (parent) {
          parent.children.splice(replaceIndex, 1);
        } else {
          this.rootPanels.splice(replaceIndex, 1);
        }

        // Clean up the replaced panel and its entire subtree
        this.closePanelSubtree(replacePanel);

        // NOW insert the new panel at the same position
        if (parent) {
          parent.children.splice(replaceIndex, 0, panel);
          // Only update selection if the replaced panel was selected
          if (wasSelected) {
            parent.selectedChildId = panel.id;
          }
        } else {
          // Root replacement - insert at same index
          this.rootPanels.splice(replaceIndex, 0, panel);
        }
        this.panels.set(panel.id, panel);
      } else if (isRoot && addAsRoot) {
        // Add as root without resetting - used for init panels
        this.rootPanels.unshift(panel);
        this.panels.set(panel.id, panel);
      } else if (isRoot) {
        // Fresh root creation (NOT replacement) - reset everything
        this.rootPanels = [panel];
        this.panels = new Map([[panel.id, panel]]);
      } else if (parent) {
        parent.children.unshift(panel); // Prepend for newest-first ordering
        parent.selectedChildId = panel.id;
        this.panels.set(panel.id, panel);
      } else {
        this.panels.set(panel.id, panel);
      }

      // Persist to database
      this.persistPanel(panel, parent?.id ?? null);

      // Focus the newly created panel:
      // - Always focus after replace (new panel takes over from the one being used)
      // - Otherwise, focus only if explicitly requested (and only for app panels)
      // Note: focusPanel calls updateSelectedPath and notifyPanelTreeUpdate
      if (replacePanel || (options?.focus && getPanelType(panel) === "app")) {
        this.focusPanel(panel.id);
      } else {
        this.notifyPanelTreeUpdate();
      }

      void this.buildPanelAsync(panel);

      return { id: panel.id, type: "app" as SharedPanel.PanelType, title: panel.title };
    } catch (err) {
      // If panel creation fails after token was created, clean up
      getTokenManager().revokeToken(panelId);
      void this.serverInfo.revokePanelToken(panelId);
      this.fsService?.unregisterPanelContext(panelId);
      throw err;
    } finally {
      this.reservedPanelIds.delete(panelId);
    }
  }

  /**
   * Persist a panel to the database.
   */
  private persistPanel(panel: Panel, parentId: string | null): void {
    try {
      const persistence = getPanelPersistence();
      const currentSnapshot = getCurrentSnapshot(panel);
      const panelType = currentSnapshot.type;

      // Check if panel already exists (e.g., on app restart)
      const existingPanel = persistence.getPanel(panel.id);

      // If the panel exists but is archived, unarchive it and update all fields
      if (existingPanel && persistence.isArchived(panel.id)) {
        persistence.unarchivePanel(panel.id);
        // Update all panel data with current values
        // Note: artifacts are NOT persisted - they're runtime-only state
        persistence.updatePanel(panel.id, {
          parentId,
          history: panel.history,
          historyIndex: panel.historyIndex,
        });
        if (parentId) {
          persistence.setSelectedChild(parentId, panel.id);
        }
        return;
      }

      const shouldCreate = !existingPanel;

      if (shouldCreate) {
        // Use the new v3 API with snapshot
        // Note: artifacts are NOT persisted - they're runtime-only state
        persistence.createPanel({
          id: panel.id,
          title: panel.title,
          parentId,
          snapshot: currentSnapshot,
        });

        // Log created event
        persistence.logEvent(panel.id, "created", { type: panelType });

        // Set parent's selected_child_id to this new child
        // This ensures breadcrumbs show the newly created child as selected
        if (parentId) {
          persistence.setSelectedChild(parentId, panel.id);
          // Also update the in-memory parent panel
          const inMemoryParent = this.panels.get(parentId);
          if (inMemoryParent) {
            inMemoryParent.selectedChildId = panel.id;
          }
        }
      }

      // Index panel for search
      try {
        const searchIndex = getPanelSearchIndex();
        const source = currentSnapshot.source;
        if (panelType === "app") {
          searchIndex.indexPanel({
            id: panel.id,
            type: panelType,
            title: panel.title,
            path: source,
          });
        } else if (panelType === "browser") {
          searchIndex.indexPanel({
            id: panel.id,
            type: "browser",
            title: panel.title,
            url: source,
          });
        } else if (panelType === "shell") {
          searchIndex.indexPanel({
            id: panel.id,
            type: "shell",
            title: panel.title,
          });
        }
      } catch (indexError) {
        console.error(`[PanelManager] Failed to index panel ${panel.id}:`, indexError);
      }
    } catch (error) {
      console.error(`[PanelManager] Failed to persist panel ${panel.id}:`, error);
    }
  }

  /**
   * Create a panel from a source path.
   * Supports:
   * - App panels from manifest source paths (e.g., "panels/editor")
   * - Shell pages with "shell:" prefix (e.g., "shell:about", "shell:model-provider-config")
   *
   * When options.replace is true, the caller panel is replaced in the tree.
   * When options.replace is false (default), a child panel is created under the caller.
   *
   * Main process handles git checkout and build asynchronously for app types.
   * Returns panel info immediately; build happens in background.
   */
  async createPanel(
    callerId: string,
    source: string,
    options?: PanelCreateOptions,
    stateArgs?: Record<string, unknown>
  ): Promise<{ id: string; type: SharedPanel.PanelType; title: string }> {
    const caller = this.panels.get(callerId);
    if (!caller) {
      throw new Error(`Caller panel not found: ${callerId}`);
    }

    // Determine the actual parent based on replace mode
    let parent: Panel | null;
    let replacePanel: Panel | undefined;

    if (options?.replace) {
      // Replace mode: caller is being replaced, find its parent
      parent = this.findParentPanel(callerId);
      replacePanel = caller;

      // Root replacement is allowed (parent will be null)
      // The new panel becomes a root panel
    } else {
      // Child mode (default): caller is the parent
      parent = caller;
    }

    // Check for shell page source (e.g., "shell:about" or "shell/about")
    const shellMatch = source.match(/^shell[:/](.+)$/);
    if (shellMatch && shellMatch[1]) {
      const page = shellMatch[1];
      return this.createShellPanelInternal(parent, page as SharedPanel.ShellPage, options, replacePanel, stateArgs);
    }

    const { relativePath, absolutePath } = this.normalizePanelPath(source);

    // Read manifest to check singleton state and get title
    let manifest: PanelManifest;
    try {
      manifest = loadPanelManifest(absolutePath);
    } catch (error) {
      throw new Error(
        `Failed to load manifest for ${source}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return this.createPanelFromManifest({
      manifest,
      relativePath,
      parent,
      options: options ?? {},
      replacePanel,
      stateArgs,
    });
  }

  /**
   * Create a browser child panel that loads an external URL.
   * Browser panels don't require manifest or build - they load external content directly.
   */
  async createBrowserChild(
    parentId: string,
    url: string
  ): Promise<{ id: string; type: SharedPanel.PanelType; title: string }> {
    const parent = this.panels.get(parentId);
    if (!parent) {
      throw new Error(`Parent panel not found: ${parentId}`);
    }

    // Validate URL protocol
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`Invalid URL format: "${url}"`);
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error(
        `Invalid URL protocol "${parsedUrl.protocol}". Only http: and https: are allowed.`
      );
    }

    // Always generate a unique name (callers can label via UI/title instead).
    const browserName = `browser-${this.generatePanelNonce()}`;

    const panelId = this.computePanelId({
      relativePath: `browser/${browserName}`,
      parent,
      requestedId: browserName,
      isRoot: false,
    });

    // Browser panels don't use partitions or templates - they use the default Chromium session.
    // Generate a simple context ID without template resolution overhead.
    const instanceId = panelId.replace(/[/:]/g, "~");
    const contextId = `ctx_${instanceId}`;

    if (this.panels.has(panelId) || this.reservedPanelIds.has(panelId)) {
      throw new Error(`A panel with id "${panelId}" is already running`);
    }

    // Create the initial snapshot for the browser panel
    const initialSnapshot = createSnapshot(url, "browser", contextId, {});
    // Add browser-specific state to snapshot
    initialSnapshot.resolvedUrl = url;
    initialSnapshot.browserState = {
      pageTitle: parsedUrl.hostname,
      isLoading: true,
      canGoBack: false,
      canGoForward: false,
    };

    const panel: Panel = {
      id: panelId,
      title: parsedUrl.hostname,
      children: [],
      selectedChildId: null,
      history: [initialSnapshot],
      historyIndex: 0,
      artifacts: {
        buildState: "ready",
      },
    };

    parent.children.unshift(panel); // Prepend for newest-first ordering
    parent.selectedChildId = panel.id;
    this.panels.set(panel.id, panel);

    // Persist to database
    this.persistPanel(panel, parentId);

    // Create WebContentsView for the browser (browsers don't use session-based partitions)
    await this.createViewForPanel(panel.id, url, "browser", contextId);

    this.notifyPanelTreeUpdate();

    return { id: panel.id, type: "browser", title: panel.title };
  }

  /**
   * Close a panel and remove it from the tree.
   * - All children are closed recursively
   * - Ephemeral panels are deleted from memory only
   * - Stored panels are archived (soft delete) in the database
   */
  async closePanel(panelId: string): Promise<void> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    // Close all children first (copy to avoid mutation during iteration)
    const childrenToClose = [...panel.children];
    for (const child of childrenToClose) {
      await this.closePanel(child.id);
    }

    // Clean up resources (tokens, CDP, git, etc.) before removing from tree
    this.unloadPanelResources(panelId);

    // Find the parent
    const parent = this.findParentPanel(panelId);

    // Remove this panel from parent's children
    if (parent) {
      parent.children = parent.children.filter((c) => c.id !== panelId);
      // Clear selectedChildId if it pointed to this panel
      if (parent.selectedChildId === panelId) {
        parent.selectedChildId = null;
        // Persist the cleared selection
        const persistence = getPanelPersistence();
        persistence.setSelectedChild(parent.id, null);
      }
    } else {
      // It's a root panel
      this.rootPanels = this.rootPanels.filter((p) => p.id !== panelId);
    }

    // Unregister panel→context mapping (permanent removal only)
    this.fsService?.unregisterPanelContext(panelId);

    // Destroy the view
    this.viewManager?.destroyView(panelId);

    // Remove from panels map
    this.panels.delete(panelId);

    // Archive in DB
    const persistence = getPanelPersistence();
    persistence.archivePanel(panelId);

    // Notify tree update
    this.notifyPanelTreeUpdate();
  }

  // ===========================================================================
  // Navigation Methods
  // ===========================================================================

  /**
   * Navigate a panel to a new source in-place.
   * - Truncates forward history (like browser navigation)
   * - Pushes new snapshot to history
   * - Loads the new content
   */
  async navigatePanel(
    panelId: string,
    source: string,
    targetType: SharedPanel.PanelType,
    options?: { env?: Record<string, string>; stateArgs?: Record<string, unknown> }
  ): Promise<void> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    // Capture current type/source BEFORE changing history
    const previousType = getPanelType(panel);
    const previousSource = getPanelSource(panel);

    // Validate that targetType is consistent with source
    // - URLs (http://, https://) should be "browser"
    // - shell: prefix should be "shell"
    // - panels/ prefix (or other) should be "app"
    const isUrl = source.startsWith("http://") || source.startsWith("https://");
    const expectedType: SharedPanel.PanelType = isUrl
      ? "browser"
      : source.startsWith("shell:")
        ? "shell"
        : "app";
    if (targetType !== expectedType) {
      throw new Error(
        `Type mismatch: source "${source}" implies type "${expectedType}" but got "${targetType}"`
      );
    }

    // Validate stateArgs for app panels (applies defaults even if stateArgs is undefined)
    let validatedStateArgs: StateArgsValue | undefined;
    if (targetType === "app") {
      const { absolutePath } = this.normalizePanelPath(source);
      const manifest = loadPanelManifest(absolutePath);
      if (manifest.stateArgs || options?.stateArgs) {
        const validation = validateStateArgs(options?.stateArgs ?? {}, manifest.stateArgs);
        if (!validation.success) {
          throw new Error(`Invalid stateArgs for ${source}: ${validation.error}`);
        }
        validatedStateArgs = validation.data;
      }
    } else if (targetType === "shell" && options?.stateArgs) {
      // Shell panels accept stateArgs without schema validation
      validatedStateArgs = options.stateArgs;
    } else if (options?.stateArgs) {
      // Reject stateArgs for browser panels
      throw new Error(`stateArgs not supported for ${targetType} panels`);
    }

    // Truncate forward history
    panel.history = panel.history.slice(0, panel.historyIndex + 1);

    // Create new snapshot with proper option inheritance
    const newSnapshot = createNavigationSnapshot(
      panel,
      source,
      targetType,
      {
        env: options?.env,
      },
      validatedStateArgs
    );
    if (targetType === "browser") {
      newSnapshot.resolvedUrl = source;
    }

    // Push new snapshot
    panel.history.push(newSnapshot);
    panel.historyIndex = panel.history.length - 1;

    // Load the content (this will rebuild if needed)
    await this._loadHistorySnapshot(panelId, newSnapshot, previousType, previousSource);

    // Persist history
    this.persistHistory(panel);

    this.notifyPanelTreeUpdate();
  }

  /**
   * Go back in the panel's navigation history.
   * Does NOT push a new entry - just moves the index.
   */
  async goBack(panelId: string): Promise<void> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    if (!canGoBack(panel)) {
      console.warn(`[PanelManager] Cannot go back - no history for panel ${panelId}`);
      return;
    }

    // Capture current type/source BEFORE changing index
    const previousType = getPanelType(panel);
    const previousSource = getPanelSource(panel);

    panel.historyIndex--;

    const snapshot = panel.history[panel.historyIndex];
    if (snapshot) {
      await this._loadHistorySnapshot(panelId, snapshot, previousType, previousSource);
    }

    // Persist history
    this.persistHistory(panel);

    this.notifyPanelTreeUpdate();
  }

  /**
   * Go forward in the panel's navigation history.
   * Does NOT push a new entry - just moves the index.
   */
  async goForward(panelId: string): Promise<void> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    if (!canGoForward(panel)) {
      console.warn(`[PanelManager] Cannot go forward - at end of history for panel ${panelId}`);
      return;
    }

    // Capture current type/source BEFORE changing index
    const previousType = getPanelType(panel);
    const previousSource = getPanelSource(panel);

    panel.historyIndex++;

    const snapshot = panel.history[panel.historyIndex];
    if (snapshot) {
      await this._loadHistorySnapshot(panelId, snapshot, previousType, previousSource);
    }

    // Persist history
    this.persistHistory(panel);

    this.notifyPanelTreeUpdate();
  }

  /**
   * Internal: Load a history snapshot without modifying the history.
   * This is used by goBack, goForward, and navigatePanel.
   *
   * @param previousType - The panel type before navigation (for detecting type changes)
   * @param previousSource - The panel source before navigation (for detecting source changes)
   */
  private async _loadHistorySnapshot(
    panelId: string,
    snapshot: PanelSnapshot,
    previousType?: SharedPanel.PanelType,
    previousSource?: string
  ): Promise<void> {
    const panel = this.panels.get(panelId);
    if (!panel) return;

    if (!this.viewManager) {
      console.warn(`[PanelManager] ViewManager not set - cannot load history snapshot for ${panelId}`);
      return;
    }

    // Use passed-in previous values if available, otherwise derive from current panel state
    // (the latter case is for navigatePanel which pushes then loads in one step)
    const currentType = previousType ?? getPanelType(panel);
    const currentSource = previousSource ?? getPanelSource(panel);
    const typeChanged = currentType !== snapshot.type;

    // Tear down old view if type changed (pass previous type so cleanup targets
    // the correct resource set, since the snapshot already reflects the new type)
    if (typeChanged) {
      this.unloadPanelResources(panelId, currentType);
    }

    const contextId = getPanelContextId(panel);

    if (snapshot.type === "browser") {
      const targetUrl = snapshot.resolvedUrl ?? snapshot.source;
      this.markPendingBrowserNavigation(panelId, targetUrl);

      // Update snapshot with loading state
      snapshot.browserState = {
        ...(snapshot.browserState ?? { pageTitle: "", canGoBack: false, canGoForward: false }),
        isLoading: true,
      };

      panel.artifacts = { buildState: "ready" };
      this.persistArtifacts(panelId, panel.artifacts);
      await this.createViewForPanel(panelId, targetUrl, "browser", contextId);
      return;
    }

    if (snapshot.type === "shell") {
      const rawPage = snapshot.source.startsWith("shell:")
        ? snapshot.source.slice("shell:".length)
        : snapshot.source;
      const page = rawPage as SharedPanel.ShellPage;
      snapshot.page = page;
      panel.title = page;
      panel.artifacts = { buildState: "building", buildProgress: "Loading shell page..." };
      this.persistArtifacts(panelId, panel.artifacts);

      // Build and store shell page via PanelHttpServer
      const url = await this.buildAndStoreShellPage(panelId, page, panel);

      const contents = this.viewManager.getWebContents(panelId);
      if (contents && !contents.isDestroyed()) {
        await contents.loadURL(url);
      } else {
        await this.createViewForPanel(panelId, url, "panel", contextId);
      }

      panel.artifacts = { buildState: "ready" };
      this.persistArtifacts(panelId, panel.artifacts);
      return;
    }

    if (snapshot.type === "app") {
      const hasPushState = Boolean(snapshot.pushState);
      const shouldDispatchPopState =
        hasPushState && !typeChanged && currentSource === snapshot.source;

      if (shouldDispatchPopState && this.dispatchPopState(panelId, snapshot.pushState!)) {
        return;
      }

      if (!typeChanged) {
        this.unloadPanelResources(panelId);
      }

      panel.artifacts = {
        buildState: "building",
        buildProgress: "Rebuilding panel...",
      };
      this.persistArtifacts(panelId, panel.artifacts);
      await this.rebuildAppPanel(panel);
      if (hasPushState) {
        this.dispatchPopState(panelId, snapshot.pushState!);
      }
      return;
    }

  }

  /**
   * Persist panel history to the database.
   */
  private persistHistory(panel: Panel): void {
    try {
      const persistence = getPanelPersistence();
      persistence.updateHistory(panel.id, panel.history, panel.historyIndex);
    } catch (error) {
      console.error(`[PanelManager] Failed to persist history for ${panel.id}:`, error);
    }
  }

  private markPendingBrowserNavigation(panelId: string, url: string): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;
    this.pendingBrowserNavigations.set(panelId, { url, index: panel.historyIndex });
  }

  /**
   * Record a browser navigation event from did-navigate.
   *
   * Browser navigation state management:
   *
   *   ┌─────────────────────────────────────────────────────────────────────┐
   *   │                     recordBrowserNavigation                         │
   *   └─────────────────────────────────────────────────────────────────────┘
   *                                    │
   *                    ┌───────────────┴───────────────┐
   *                    │ Has navigationState?          │
   *                    └───────────────┬───────────────┘
   *                           No │            │ Yes
   *              ┌───────────────┘            └───────────────┐
   *              ▼                                            ▼
   *   ┌─────────────────────┐               ┌─────────────────────────────┐
   *   │ Create initial state│               │ Check pendingBrowserNav?    │
   *   │ and return          │               └─────────────┬───────────────┘
   *   └─────────────────────┘                      Yes │        │ No
   *                                     ┌─────────────┘        └──────────┐
   *                                     ▼                                 ▼
   *                          ┌─────────────────────┐      ┌───────────────────────┐
   *                          │ Reconcile: update   │      │ Same as current URL?  │
   *                          │ resolvedUrl on the  │      └───────────┬───────────┘
   *                          │ pending entry, clear│             Yes │      │ No
   *                          │ pending, return     │      ┌──────────┘      └──────┐
   *                          └─────────────────────┘      ▼                        ▼
   *                                                ┌─────────────┐    ┌────────────────────┐
   *                                                │ Update      │    │ Truncate forward   │
   *                                                │ resolvedUrl,│    │ history, push new  │
   *                                                │ return      │    │ entry, update index│
   *                                                └─────────────┘    └────────────────────┘
   *
   * The pending navigation mechanism handles the gap between when we initiate a
   * navigation (markPendingBrowserNavigation) and when did-navigate fires. This
   * ensures redirects update the correct history entry rather than creating duplicates.
   */
  private recordBrowserNavigation(panelId: string, url: string): void {
    const panel = this.panels.get(panelId);
    if (!panel || getPanelType(panel) !== "browser") return;

    const pending = this.pendingBrowserNavigations.get(panelId);
    if (pending) {
      this.pendingBrowserNavigations.delete(panelId);
      const snapshot = panel.history[pending.index];
      if (snapshot && snapshot.type === "browser") {
        snapshot.resolvedUrl = url;
      }
      return;
    }

    const current = panel.history[panel.historyIndex];
    const currentUrl = current?.type === "browser" ? (current.resolvedUrl ?? current.source) : null;
    if (currentUrl === url) {
      if (current && current.type === "browser") {
        current.resolvedUrl = url;
      }
      return;
    }

    // Truncate forward history and push new snapshot
    panel.history = panel.history.slice(0, panel.historyIndex + 1);
    const contextId = getPanelContextId(panel);
    const newSnapshot = createSnapshot(url, "browser", contextId, getPanelOptions(panel));
    newSnapshot.resolvedUrl = url;
    panel.history.push(newSnapshot);
    panel.historyIndex = panel.history.length - 1;
  }

  /**
   * Sanitize pushState data for persistence.
   * Non-JSON-serializable values (functions, circular refs, etc.) are replaced with null.
   */
  private sanitizePushState(state: unknown): unknown {
    try {
      // Round-trip through JSON to ensure serializability
      return JSON.parse(JSON.stringify(state));
    } catch (error) {
      console.warn(
        `[PanelManager] pushState contains unserializable data and will be null on restore:`,
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }

  handleHistoryPushState(panelId: string, state: unknown, path: string): void {
    const panel = this.panels.get(panelId);
    if (!panel || getPanelType(panel) !== "app") return;

    // Truncate forward history
    panel.history = panel.history.slice(0, panel.historyIndex + 1);

    // Create new snapshot with pushState (sanitized for persistence)
    const source = getPanelSource(panel);
    const contextId = getPanelContextId(panel);
    const newSnapshot = createSnapshot(source, "app", contextId, getPanelOptions(panel));
    newSnapshot.pushState = { state: this.sanitizePushState(state), path };
    panel.history.push(newSnapshot);
    panel.historyIndex = panel.history.length - 1;

    this.persistHistory(panel);
    this.notifyPanelTreeUpdate();
  }

  handleHistoryReplaceState(panelId: string, state: unknown, path: string): void {
    const panel = this.panels.get(panelId);
    if (!panel || getPanelType(panel) !== "app") return;

    const current = panel.history[panel.historyIndex];
    if (current) {
      // Update existing snapshot's pushState (sanitized for persistence)
      current.pushState = { state: this.sanitizePushState(state), path };
    }

    this.persistHistory(panel);
    this.notifyPanelTreeUpdate();
  }

  async goToHistoryOffset(panelId: string, offset: number): Promise<void> {
    if (offset === 0) return;

    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    if (panel.history.length === 0) {
      console.warn(`[PanelManager] Cannot go to history offset - no history for panel ${panelId}`);
      return;
    }

    const targetIndex = panel.historyIndex + offset;
    if (targetIndex < 0 || targetIndex >= panel.history.length || targetIndex === panel.historyIndex) {
      return;
    }

    // Capture current type/source BEFORE changing index
    const previousType = getPanelType(panel);
    const previousSource = getPanelSource(panel);

    panel.historyIndex = targetIndex;

    const snapshot = panel.history[panel.historyIndex];
    if (snapshot) {
      await this._loadHistorySnapshot(panelId, snapshot, previousType, previousSource);
    }

    // Persist the updated history index
    this.persistHistory(panel);

    this.notifyPanelTreeUpdate();
  }

  /**
   * Reload the current panel view, rebuilding if the view is unloaded.
   */
  async reloadPanel(panelId: string): Promise<void> {
    if (!this.viewManager) {
      console.warn(`[PanelManager] ViewManager not set - cannot reload panel ${panelId}`);
      return;
    }

    if (!this.viewManager.hasView(panelId)) {
      await this.rebuildUnloadedPanel(panelId);
      return;
    }

    this.viewManager.reload(panelId);
  }

  /**
   * Force a repaint of a panel view.
   * Used to recover from compositor stalls where content exists but isn't painted.
   */
  forceRepaint(panelId: string): boolean {
    if (!this.viewManager) {
      console.warn(`[PanelManager] ViewManager not set - cannot force repaint for ${panelId}`);
      return false;
    }

    return this.viewManager.forceRepaint(panelId);
  }

  private dispatchPopState(
    panelId: string,
    pushState: SharedPanel.PanelSnapshot["pushState"]
  ): boolean {
    if (!pushState) return false;

    const payload = {
      state: pushState.state,
      path: pushState.path,
    };

    if (this.rpcServer) {
      this.rpcServer.sendToClient(panelId, {
        type: "ws:event",
        event: "panel:history-popstate",
        payload,
      });
      return true;
    }

    return false;
  }

  /**
   * Replace a panel instance in the tree, preserving parent/child relationships.
   */
  private replacePanelInTree(panelId: string, panel: Panel): void {
    const parent = this.findParentPanel(panelId);
    if (parent) {
      parent.children = parent.children.map((child) => (child.id === panelId ? panel : child));
    } else {
      this.rootPanels = this.rootPanels.map((root) => (root.id === panelId ? panel : root));
    }
    this.panels.set(panelId, panel);
  }

  /**
   * Navigate panel to a new source by creating a navigation snapshot.
   * This is the unified way to change what a panel displays.
   */
  private navigatePanelToSnapshot(
    panel: Panel,
    newType: SharedPanel.PanelType,
    source: string,
    resolvedUrl?: string
  ): void {
    // Create the new snapshot with proper option inheritance
    const newSnapshot = createNavigationSnapshot(panel, source, newType);

    // Add type-specific fields to the snapshot
    if (newType === "browser") {
      newSnapshot.resolvedUrl = resolvedUrl ?? source;
      newSnapshot.browserState = {
        pageTitle: panel.title,
        isLoading: true,
        canGoBack: false,
        canGoForward: false,
      };
    } else if (newType === "shell") {
      const rawPage = source.startsWith("shell:") ? source.slice("shell:".length) : source;
      newSnapshot.page = rawPage as SharedPanel.ShellPage;
    }

    // Update title based on new type
    if (newType === "browser" && newSnapshot.resolvedUrl) {
      try {
        panel.title = new URL(newSnapshot.resolvedUrl).hostname || panel.title;
      } catch {
        // Keep existing title
      }
    } else if (newType === "shell" && newSnapshot.page) {
      panel.title = newSnapshot.page;
    }

    // Push the new snapshot to history (truncate forward history)
    panel.history = panel.history.slice(0, panel.historyIndex + 1);
    panel.history.push(newSnapshot);
    panel.historyIndex = panel.history.length - 1;

    // Reset build state
    panel.artifacts = {
      buildState: "building",
      buildProgress: "Loading...",
    };
  }

  /**
   * Update search index for a panel.
   */
  private updateSearchIndex(panel: Panel): void {
    try {
      const searchIndex = getPanelSearchIndex();
      const panelType = getPanelType(panel);
      const source = getPanelSource(panel);
      const snapshot = getCurrentSnapshot(panel);

      searchIndex.indexPanel({
        id: panel.id,
        type: panelType,
        title: panel.title,
        path: panelType === "app" ? source : undefined,
        url: panelType === "browser" ? snapshot.resolvedUrl : undefined,
      });
    } catch (error) {
      console.error(`[PanelManager] Failed to update search index for ${panel.id}:`, error);
    }
  }

  /**
   * Get the current source for a panel based on its type.
   * Uses accessor functions for the new snapshot architecture.
   */
  private getCurrentSource(panel: Panel): string {
    const panelType = getPanelType(panel);
    const source = getPanelSource(panel);
    const snapshot = getCurrentSnapshot(panel);

    switch (panelType) {
      case "app":
        return source;
      case "browser":
        return snapshot.resolvedUrl ?? source;
      case "shell":
        return snapshot.page ? `shell:${snapshot.page}` : source;
      default:
        return source;
    }
  }

  /**
   * Internal helper to create a shell panel with parent/replace semantics.
   * Shell panels are pre-built system pages (model-provider-config, about, keyboard-shortcuts, help)
   * that have full shell-level access to services.
   *
   * When replacePanel is provided, it replaces that panel in the tree at the same position.
   * When replacePanel is not provided, a child panel is created under the parent.
   */
  private async createShellPanelInternal(
    parent: Panel | null,
    page: SharedPanel.ShellPage,
    options?: PanelCreateOptions,
    replacePanel?: Panel,
    stateArgs?: Record<string, unknown>
  ): Promise<{ id: string; type: SharedPanel.PanelType; title: string }> {
    const title = page;

    // Generate unique panel ID
    const panelId = this.computePanelId({
      relativePath: `shell/${page}`,
      parent,
      requestedId: options?.name,
      isRoot: !parent && !replacePanel,
    });

    if (this.panels.has(panelId) || this.reservedPanelIds.has(panelId)) {
      throw new Error(`A panel with id "${panelId}" is already running`);
    }

    // Shell panels use a simple context ID for session isolation
    const instanceId = panelId.replace(/[/:]/g, "~");
    const contextId = `ctx_${instanceId}`;

    // Create auth tokens for WS and server RPC access
    getTokenManager().createToken(panelId, "panel");
    await this.serverInfo.createPanelToken(panelId, "panel");

    // Create the initial snapshot for the shell panel
    const initialSnapshot = createSnapshot(`shell:${page}`, "shell", contextId, {
      env: options?.env,
    }, stateArgs);
    initialSnapshot.page = page;

    const panel: Panel = {
      id: panelId,
      title,
      children: [],
      selectedChildId: null,
      history: [initialSnapshot],
      historyIndex: 0,
      artifacts: {
        buildState: "ready",
      },
    };

    // Handle tree insertion based on replace mode
    if (replacePanel) {
      // Replace mode: clean up first, then insert new panel
      const wasSelected = parent ? parent.selectedChildId === replacePanel.id : false;
      let replaceIndex = -1;
      if (parent) {
        replaceIndex = parent.children.findIndex(c => c.id === replacePanel.id);
      } else {
        replaceIndex = this.rootPanels.findIndex(p => p.id === replacePanel.id);
      }

      if (replaceIndex === -1) {
        console.error(`[PanelManager] replacePanel ${replacePanel.id} not found in tree - aborting replacement`);
        throw new Error(`Cannot replace panel: ${replacePanel.id} not found in tree`);
      }

      // Remove from tree before cleanup
      if (parent) {
        parent.children.splice(replaceIndex, 1);
      } else {
        this.rootPanels.splice(replaceIndex, 1);
      }

      // Clean up the replaced panel and its entire subtree
      this.closePanelSubtree(replacePanel);

      // Insert the new panel at the same position
      if (parent) {
        parent.children.splice(replaceIndex, 0, panel);
        if (wasSelected) {
          parent.selectedChildId = panel.id;
        }
      } else {
        this.rootPanels.splice(replaceIndex, 0, panel);
      }
      this.panels.set(panel.id, panel);
    } else if (parent) {
      // Child mode: add as child of parent (prepend for newest-first ordering)
      parent.children.unshift(panel);
      parent.selectedChildId = panel.id;
      this.panels.set(panel.id, panel);
    } else {
      // Root mode (no parent, no replace) - this shouldn't normally happen for shell panels
      this.panels.set(panel.id, panel);
    }

    // Persist to database
    this.persistPanel(panel, parent?.id ?? null);

    // Build and store shell page via PanelHttpServer
    const url = await this.buildAndStoreShellPage(panelId, page, panel);

    // Create WebContentsView for the shell panel (HTTP subdomain, no partition needed)
    await this.createViewForPanel(panel.id, url, "panel", getPanelContextId(panel));

    // Focus after replace (takes over from the one being used)
    // Note: focusPanel calls updateSelectedPath and notifyPanelTreeUpdate
    if (replacePanel) {
      this.focusPanel(panel.id);
    } else {
      this.notifyPanelTreeUpdate();
    }

    return { id: panel.id, type: getPanelType(panel), title: panel.title };
  }

  /**
   * Update browser panel state (URL, loading, navigation capabilities).
   * Called when the renderer forwards webview events.
   */
  updateBrowserState(
    browserId: string,
    state: {
      url?: string;
      pageTitle?: string;
      isLoading?: boolean;
      canGoBack?: boolean;
      canGoForward?: boolean;
    }
  ): void {
    const panel = this.panels.get(browserId);
    const panelType = panel ? getPanelType(panel) : null;
    if (!panel || (panelType !== "browser" && panelType !== "app" && panelType !== "shell")) {
      console.warn(`[PanelManager] Panel not found or not browser/app/shell: ${browserId}`);
      return;
    }

    // Update URL if provided - this may push a new history entry
    if (state.url !== undefined) {
      // Record navigation BEFORE updating resolvedUrl (so we can detect the change)
      // This may push a new history entry, changing panel.historyIndex
      this.recordBrowserNavigation(browserId, state.url);
    }

    // Get the CURRENT snapshot (after potential history push)
    const snapshot = getCurrentSnapshot(panel);

    // Update resolvedUrl on the current snapshot
    if (state.url !== undefined) {
      snapshot.resolvedUrl = state.url;
    }

    // Ensure browserState exists
    if (!snapshot.browserState) {
      snapshot.browserState = {
        pageTitle: panel.title,
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
      };
    }

    // Update browserState fields
    if (state.pageTitle !== undefined) {
      snapshot.browserState.pageTitle = state.pageTitle;
      panel.title = state.pageTitle; // Also update the panel title
    }
    if (state.isLoading !== undefined) {
      snapshot.browserState.isLoading = state.isLoading;
    }
    if (state.canGoBack !== undefined) {
      snapshot.browserState.canGoBack = state.canGoBack;
    }
    if (state.canGoForward !== undefined) {
      snapshot.browserState.canGoForward = state.canGoForward;
    }

    // Persist state changes to database
    try {
      const persistence = getPanelPersistence();
      if (state.pageTitle !== undefined) {
        persistence.setTitle(browserId, state.pageTitle);
      }
      if (state.url !== undefined || state.isLoading !== undefined ||
          state.canGoBack !== undefined || state.canGoForward !== undefined) {
        this.persistHistory(panel);
      }
    } catch (error) {
      console.error(`[PanelManager] Failed to persist browser state for ${browserId}:`, error);
    }

    // Update search index for URL and title changes
    try {
      const searchIndex = getPanelSearchIndex();
      if (state.pageTitle !== undefined) {
        searchIndex.updateTitle(browserId, state.pageTitle);
      }
      if (state.url !== undefined) {
        searchIndex.updateUrl(browserId, state.url);
      }
    } catch (error) {
      console.error(`[PanelManager] Failed to update search index for ${browserId}:`, error);
    }

    this.notifyPanelTreeUpdate();
  }

  /**
   * Create a shell panel for system pages (model-provider-config, about, etc.).
   * Shell panels have full access to shell services and appear in the panel tree.
   * Most pages are singletons (navigating to existing shows it, not creates new).
   * The "new" page supports multiple instances for launching different panels.
   */
  async createShellPanel(
    page: SharedPanel.ShellPage
  ): Promise<{ id: string; type: SharedPanel.PanelType; title: string }> {
    // "new" pages can have multiple instances, others are singletons
    const isMultiInstance = page === "new";
    const panelId = isMultiInstance
      ? `shell:${page}~${Date.now().toString(36)}`
      : `shell:${page}`;

    // Check if shell panel already exists for this page (only for singleton pages)
    if (!isMultiInstance) {
      const existing = this.panels.get(panelId);
      if (existing) {
        // Focus existing panel and return
        this.focusPanel(existing.id);
        return { id: existing.id, type: getPanelType(existing), title: existing.title };
      }
    }

    const title = page;

    // Shell panels use a simple context ID for session isolation
    const instanceId = panelId.replace(/[/:]/g, "~");
    const contextId = `ctx_${instanceId}`;

    // Create auth tokens for WS and server RPC access
    getTokenManager().createToken(panelId, "panel");
    await this.serverInfo.createPanelToken(panelId, "panel");

    // Create the initial snapshot for the shell panel
    const initialSnapshot = createSnapshot(`shell:${page}`, "shell", contextId, {});
    initialSnapshot.page = page;

    const panel: Panel = {
      id: panelId,
      title,
      children: [],
      selectedChildId: null,
      history: [initialSnapshot],
      historyIndex: 0,
      artifacts: {
        buildState: "ready",
      },
    };

    // Add to root panels (shell panels are top-level)
    // Insert at position 0 for newest-first ordering
    this.rootPanels.splice(0, 0, panel);
    this.panels.set(panel.id, panel);

    // Persist to database
    this.persistPanel(panel, null);

    // Build and store shell page via PanelHttpServer
    const url = await this.buildAndStoreShellPage(panelId, page, panel);

    // Create WebContentsView for the shell panel (HTTP subdomain, no partition needed)
    await this.createViewForPanel(panel.id, url, "panel", getPanelContextId(panel));

    // Focus the newly created panel (this also notifies tree update)
    this.focusPanel(panel.id);

    return { id: panel.id, type: getPanelType(panel), title: panel.title };
  }

  /**
   * Create an initialization panel as a root panel.
   * Used for panels specified in workspace config's initPanels array.
   * These panels are created on first initialization when the panel tree is empty.
   * Unlike createPanel, this doesn't require a caller and adds to roots without resetting.
   */
  async createInitPanel(
    source: string
  ): Promise<{ id: string; type: SharedPanel.PanelType; title: string }> {
    const { relativePath, absolutePath } = this.normalizePanelPath(source);

    // Read manifest
    let manifest: PanelManifest;
    try {
      manifest = loadPanelManifest(absolutePath);
    } catch (error) {
      throw new Error(
        `Failed to load manifest for init panel ${source}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const options: PanelCreateOptions = {};

    return this.createPanelFromManifest({
      manifest,
      relativePath,
      parent: null,
      options,
      isRoot: true,
      addAsRoot: true, // Add to roots without resetting tree
    });
  }

  /**
   * Find a shell panel by its page type.
   * Note: Returns the unified Panel type, not the legacy ShellPanel.
   */
  findShellPanel(page: SharedPanel.ShellPage): Panel | null {
    const panelId = `shell:${page}`;
    const panel = this.panels.get(panelId);
    if (panel && getPanelType(panel) === "shell") {
      return panel;
    }
    return null;
  }

  /**
   * Build a PanelConfig for serving a panel via PanelHttpServer.
   */
  private async buildPanelConfig(panel: Panel, panelSource: string): Promise<HttpPanelConfig> {
    const contextId = getPanelContextId(panel);
    const subdomain = contextIdToSubdomain(contextId);
    const parentId = this.findParentId(panel.id) ?? null;
    const rpcToken = getTokenManager().getToken(panel.id) ?? "";
    const gitToken = await this.serverInfo.getGitTokenForPanel(panel.id);
    const snapshot = getCurrentSnapshot(panel);
    const env = snapshot.options.env ?? {};
    const stateArgs = getPanelStateArgs(panel) ?? {};
    const repoArgs = snapshot.options.repoArgs ?? {};

    // Ensure the panel has a server-side token for direct server RPC + PubSub auth
    const serverRpcToken = await this.serverInfo.getPanelToken(panel.id)
      ?? await this.serverInfo.ensurePanelToken(panel.id, "panel");

    return {
      panelId: panel.id,
      contextId,
      subdomain,
      parentId,
      rpcPort: this.rpcPort!,
      rpcToken,
      serverRpcPort: this.serverInfo.rpcPort,
      serverRpcToken,
      gitBaseUrl: this.serverInfo.gitBaseUrl,
      gitToken,
      pubsubPort: parseInt(new URL(this.serverInfo.pubsubUrl).port, 10),
      pubsubToken: serverRpcToken,
      stateArgs,
      sourceRepo: panelSource,
      resolvedRepoArgs: repoArgs,
      env,
      theme: this.currentTheme,
      title: panel.title,
    };
  }

  /**
   * Build a panel asynchronously and update its state.
   * Stores built content in PanelHttpServer for HTTP subdomain serving.
   */
  private async buildPanelAsync(panel: Panel): Promise<void> {
    try {
      const panelSource = getPanelSource(panel);

      // Check if panel directory is a git repo first
      const absolutePanelPath = path.resolve(this.panelsRoot, panelSource);

      // Stage 1: Check if it's a git repo
      const { isRepo, path: repoPath } = await checkGitRepository(absolutePanelPath);

      if (!isRepo) {
        await this.navigatePanel(panel.id, "shell:git-init", "shell", {
          stateArgs: { repoPath },
        });
        return;
      }

      // Stage 2: Check for dirty worktree
      const { clean, path: cleanRepoPath } = await checkWorktreeClean(absolutePanelPath);

      if (!clean) {
        await this.navigatePanel(panel.id, "shell:dirty-repo", "shell", {
          stateArgs: { repoPath: cleanRepoPath },
        });
        return;
      }

      // Update build state to building
      panel.artifacts = {
        ...panel.artifacts,
        buildState: "building",
        buildProgress: "Building panel...",
      };
      this.notifyPanelTreeUpdate();

      // Build via V2 build service (server process).
      // The RPC returns a BuildResult; we only need the content fields
      // (html, bundle, css, assets, metadata) for HTTP serving.
      const buildResult = await this.serverInfo.call("build", "getBuild", [panelSource]) as
        import("../server/buildV2/buildStore.js").BuildResult;

      // Read manifest locally for fields not in build metadata
      let manifest: PanelManifest | undefined;
      try {
        manifest = loadPanelManifest(absolutePanelPath);
      } catch {
        // Non-fatal — manifest fields are optional for protocol serving
      }

      if (buildResult.bundle && buildResult.html) {
        // Store panel content in PanelHttpServer for HTTP subdomain serving
        const httpConfig = await this.buildPanelConfig(panel, panelSource);
        this.panelHttpServer!.storePanel(panel.id, buildResult, httpConfig);
        const htmlUrl = this.panelHttpServer!.getPanelUrl(panel.id)!;

        // Update panel with successful build
        panel.artifacts = {
          htmlPath: htmlUrl,
          buildState: "ready",
          buildProgress: "Build complete",
        };
        this.persistArtifacts(panel.id, panel.artifacts);

        // Create WebContentsView for this panel (HTTP subdomain — no partition needed)
        await this.createViewForPanel(panel.id, htmlUrl, "panel", getPanelContextId(panel));
      } else {
        // Build returned no bundle/html
        panel.artifacts = {
          error: "Build produced no output",
          buildState: "error",
          buildProgress: "Build produced no output",
        };
        this.persistArtifacts(panel.id, panel.artifacts);
      }

      this.notifyPanelTreeUpdate();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      panel.artifacts = {
        error: errorMsg,
        buildState: "error",
        buildProgress: errorMsg,
      };
      this.persistArtifacts(panel.id, panel.artifacts);
      this.notifyPanelTreeUpdate();
    }
  }

  /**
   * Update artifacts in memory.
   * Note: Artifacts are NOT persisted to the database - they're runtime-only state.
   * This method exists to maintain the call pattern but is now a no-op.
   */
  private persistArtifacts(_panelId: string, _artifacts: SharedPanel.PanelArtifacts): void {
    // Artifacts are runtime-only - no database persistence needed.
    // The in-memory panel.artifacts is already updated by the caller.
  }

  /**
   * Invalidate all ready/error app/worker panels: reset to pending and unload resources.
   * Called when build cache is cleared to ensure panels rebuild with fresh code.
   * Note: Artifacts are runtime-only, so we just iterate over in-memory panels.
   */
  invalidateReadyPanels(): void {
    const focusedPanelId = this.focusedPanelId;
    let focusedWasReset = false;

    // Reset and unload ready/error panels (in-memory only)
    for (const [panelId, panel] of this.panels) {
      const buildState = panel.artifacts?.buildState;
      const panelType = panel.history[panel.historyIndex]?.type;

      // Only reset app panels with ready or error state
      if (panelType === "app" &&
          (buildState === "ready" || buildState === "error")) {
        this.invalidatePanelInMemory(panelId);
        if (panelId === focusedPanelId) focusedWasReset = true;
      }
    }

    this.notifyPanelTreeUpdate();

    // Rebuild focused panel immediately so user doesn't see blank
    if (focusedWasReset && focusedPanelId) {
      void this.rebuildUnloadedPanel(focusedPanelId);
    }
  }

  /** Helper: unload resources and set pending state for one panel */
  private invalidatePanelInMemory(panelId: string): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;
    this.unloadPanelResources(panelId);
    panel.artifacts = {
      buildState: "pending",
      buildProgress: "Build cache cleared - will rebuild when focused",
    };
  }

  /**
   * Unload a panel and all its descendants (release resources but keep in tree).
   * The panel stays in the database and can be re-loaded later.
   */
  async unloadPanel(panelId: string): Promise<void> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    // Unload this panel and all its descendants (resources AND artifacts)
    this.unloadPanelTree(panelId);

    // Notify renderer
    this.notifyPanelTreeUpdate();
  }

  /**
   * Recursively unload a panel tree - releases resources and resets artifacts.
   * Preserves error/dirty/not-git-repo states so users can still see actionable UI.
   */
  private unloadPanelTree(panelId: string): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;

    // Recursively unload children first
    for (const child of panel.children) {
      this.unloadPanelTree(child.id);
    }

    // Release resources for this panel
    this.unloadPanelResources(panelId);

    // Don't reset if already pending without build artifacts
    const hasBuildArtifacts = Boolean(panel.artifacts?.htmlPath || panel.artifacts?.bundlePath);
    if (panel.artifacts?.buildState === "pending" && !hasBuildArtifacts) {
      return;
    }

    // Reset the build state to indicate it needs to be rebuilt
    panel.artifacts = {
      buildState: "pending",
      buildProgress: "Panel unloaded - will rebuild when focused",
    };

    // Persist the new state
    this.persistArtifacts(panelId, panel.artifacts);
  }

  /**
   * Rebuild an app panel by reconstructing its env and triggering the build.
   */
  private async rebuildAppPanel(panel: Panel): Promise<void> {
    await this.buildPanelAsync(panel);
  }

  /**
   * Rebuild an unloaded panel. Called when user focuses or reloads a panel
   * that was previously unloaded.
   */
  async rebuildUnloadedPanel(panelId: string): Promise<void> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    // Only rebuild if panel is in pending state (unloaded)
    if (panel.artifacts.buildState !== "pending") {
      return;
    }

    // Ensure auth tokens exist — they don't persist across restarts and are
    // revoked on unload, so we must recreate them before buildPanelConfig().
    getTokenManager().ensureToken(panelId, "panel");
    await this.serverInfo.ensurePanelToken(panelId, "panel");

    // Set building state
    panel.artifacts = {
      buildState: "building",
      buildProgress: "Rebuilding panel...",
    };
    this.notifyPanelTreeUpdate();

    // Rebuild based on panel type
    const panelType = getPanelType(panel);
    if (panelType === "app") {
      await this.rebuildAppPanel(panel);
    } else if (panelType === "browser") {
      // Browser panels can be recreated directly
      const snapshot = getCurrentSnapshot(panel);
      const url = snapshot.resolvedUrl ?? getPanelSource(panel);
      await this.createViewForPanel(panel.id, url, "browser", getPanelContextId(panel));
      panel.artifacts = { buildState: "ready" };
      this.persistArtifacts(panelId, panel.artifacts);
      this.notifyPanelTreeUpdate();
    } else if (panelType === "shell") {
      // Shell panels can be recreated directly
      await this.restoreShellPanel(panel);
    }
  }

  /**
   * Ensure a panel is loaded and running.
   * If the panel exists but is unloaded (pending state), rebuild it.
   * Returns detailed result with build state and any errors.
   * Used for agent worker recovery - reloading workers that disconnected unexpectedly.
   */
  async ensurePanelLoaded(panelId: string): Promise<SharedPanel.EnsureLoadedResult> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      log.verbose(` ensurePanelLoaded: Panel not found: ${panelId}`);
      return { success: false, buildState: "not-found", error: "Panel not found" };
    }

    const currentState = panel.artifacts?.buildState;

    // Already loaded - return success
    if (currentState === "ready") {
      log.verbose(` ensurePanelLoaded: Panel already loaded: ${panelId}`);
      return { success: true, buildState: "ready" };
    }

    // Currently building - wait for completion
    if (currentState === "building" || currentState === "cloning") {
      log.verbose(` ensurePanelLoaded: Waiting for build: ${panelId}`);
      return await this.waitForBuildComplete(panelId);
    }

    // Error states - return the error info
    if (currentState === "error") {
      return {
        success: false,
        buildState: "error",
        error: panel.artifacts?.error ?? panel.artifacts?.buildProgress ?? "Build failed",
        buildLog: panel.artifacts?.buildLog,
      };
    }

    // State is "pending" - trigger rebuild
    log.verbose(` ensurePanelLoaded: Rebuilding unloaded panel: ${panelId}`);
    await this.rebuildUnloadedPanel(panelId);

    // Wait for rebuild to complete
    return await this.waitForBuildComplete(panelId);
  }

  /**
   * Wait for a panel build to complete, polling until ready or error.
   */
  private async waitForBuildComplete(panelId: string, timeoutMs = 60000): Promise<SharedPanel.EnsureLoadedResult> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const panel = this.panels.get(panelId);
      if (!panel) {
        return { success: false, buildState: "not-found", error: "Panel disappeared" };
      }

      const state = panel.artifacts?.buildState;
      if (state === "ready") {
        return { success: true, buildState: "ready" };
      }
      if (state === "error") {
        return {
          success: false,
          buildState: state,
          error: panel.artifacts?.error ?? panel.artifacts?.buildProgress ?? `Build failed: ${state}`,
          buildLog: panel.artifacts?.buildLog,
        };
      }

      // Still building - wait and poll
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return { success: false, buildState: "timeout", error: "Build timed out" };
  }

  /**
   * Update state args for a panel.
   * Validates the merged args against the manifest schema, persists to current snapshot.
   */
  async handleSetStateArgs(panelId: string, updates: Record<string, unknown>): Promise<StateArgsValue> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    const panelType = getPanelType(panel);
    if (panelType !== "app") {
      throw new Error(`setStateArgs not supported for ${panelType} panels`);
    }

    // Load manifest to get schema (resolve against workspace root, not CWD)
    const panelSource = getPanelSource(panel);
    const absolutePath = path.resolve(this.panelsRoot, panelSource);
    const manifest = await loadPanelManifest(absolutePath);
    const currentArgs = getPanelStateArgs(panel) ?? {};
    const merged = { ...currentArgs, ...updates };

    // Validate merged args against schema
    const validation = validateStateArgs(merged, manifest.stateArgs);
    if (!validation.success) {
      throw new Error(`Invalid stateArgs: ${validation.error}`);
    }

    // Update current snapshot's stateArgs
    const snapshot = getCurrentSnapshot(panel);
    snapshot.stateArgs = validation.data;

    // Persist panel history (includes current snapshot)
    this.persistHistory(panel);

    // Update stored HTTP config so page reloads get fresh stateArgs
    if (this.panelHttpServer) {
      const httpConfig = await this.buildPanelConfig(panel, getPanelSource(panel));
      this.panelHttpServer.updatePanelConfig(panelId, httpConfig);
    }

    // Broadcast to panel for reactive update (no reload)
    if (this.rpcServer) {
      this.rpcServer.sendToClient(panelId, {
        type: "ws:event",
        event: "stateArgs:updated",
        payload: validation.data,
      });
    }

    return validation.data!;
  }

  /**
   * Retry a build for a panel that was blocked by dirty worktree.
   * Called after user commits or discards changes in the Git UI.
   */
  async retryBuild(panelId: string): Promise<void> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    // Navigate back from dirty-repo shell page to trigger rebuild
    const snapshot = getCurrentSnapshot(panel);
    if (snapshot.type === "shell" && snapshot.source === "shell:dirty-repo") {
      await this.goBack(panelId);
      return;
    }
  }

  /**
   * Initialize git repo after user clicks initialize in GitInitView.
   * Re-runs build checks which will now pass git repo check and go to dirty check.
   */
  async initializeGitRepo(panelId: string): Promise<void> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    // Navigate back from git-init shell page to trigger rebuild
    const snapshot = getCurrentSnapshot(panel);
    if (snapshot.type === "shell" && snapshot.source === "shell:git-init") {
      await this.goBack(panelId);
      return;
    }
  }

  getInfo(panelId: string): SharedPanel.PanelInfo {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }
    const contextId = getPanelContextId(panel);
    return {
      panelId: panel.id,
      partition: contextId, // Partition is now based on session, not panel ID
      contextId,
    };
  }

  /**
   * Get child panels for a given panel (slim projection).
   *
   * Note: createdAt is approximated with Date.now() since the Panel in-memory
   * structure doesn't include it (it's only in the DB). This means timestamps
   * will show "Just now" after refresh. For accurate timestamps, we'd need to
   * query the database for each child panel.
   */
  getChildPanels(
    panelId: string,
    options?: { includeStateArgs?: boolean }
  ): Array<{
    id: string;
    title: string;
    source: string;
    createdAt: number;
    stateArgs?: Record<string, unknown>;
  }> {
    const panel = this.panels.get(panelId);
    if (!panel) return [];
    return panel.children.map((child) => {
      const base = {
        id: child.id,
        title: child.title,
        source: getPanelSource(child),
        // TODO: Query DB for actual created_at if accurate timestamps are needed
        createdAt: Date.now(),
      };
      // Only include stateArgs if explicitly requested (perf/data-exposure concern)
      if (options?.includeStateArgs) {
        return { ...base, stateArgs: getPanelStateArgs(child) };
      }
      return base;
    });
  }

  getSerializablePanelTree(): Panel[] {
    return this.rootPanels.map((panel) => this.serializePanel(panel));
  }

  /**
   * Find which panel a webContents sender belongs to.
   * Uses ViewManager's reverse lookup from webContents ID to view ID.
   * Returns the panel ID if found, null otherwise.
   */
  findPanelIdBySenderId(senderId: number): string | null {
    if (!this.viewManager) {
      return null;
    }
    return this.viewManager.findViewIdByWebContentsId(senderId);
  }

  setCurrentTheme(theme: "light" | "dark"): void {
    this.currentTheme = theme;

    // Update stored HTTP configs so page reloads pick up the new theme
    if (this.panelHttpServer) {
      for (const [panelId, panel] of this.panels) {
        const pType = getPanelType(panel);
        if ((pType === "app" || pType === "shell") && panel.artifacts?.buildState === "ready") {
          void this.buildPanelConfig(panel, getPanelSource(panel)).then((httpConfig) => {
            this.panelHttpServer?.updatePanelConfig(panelId, httpConfig);
          }).catch(() => { /* non-fatal — panel may be closing */ });
        }
      }
    }
  }

  sendPanelEvent(panelId: string, payload: PanelEventPayload): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;

    if (this.rpcServer) {
      this.rpcServer.sendToClient(panelId, {
        type: "ws:event",
        event: "panel:event",
        payload: { panelId, ...payload },
      });
    }
  }

  broadcastTheme(theme: "light" | "dark"): void {
    for (const panelId of this.panels.keys()) {
      // Only send to panels that have views (skip unloaded panels)
      if (this.viewManager?.hasView(panelId)) {
        this.sendPanelEvent(panelId, { type: "theme", theme });
      }
    }
  }

  // Private methods

  /**
   * Unload panel resources (release WebContentsView, tokens, etc.) but keep panel in tree.
   * Called by unloadPanelTree for each panel in the subtree.
   * Note: Does NOT recurse into children - caller handles recursion.
   */
  private unloadPanelResources(panelId: string, typeOverride?: SharedPanel.PanelType): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;

    // Close open file handles for this panel (safe on any teardown path)
    this.fsService?.closeHandlesForPanel(panelId);

    // Revoke auth token (disconnects WS connections via onRevoke listener)
    getTokenManager().revokeToken(panelId);

    // Clean up crash history for this panel
    this.crashHistory.delete(panelId);

    // Get webContents for cleanup before destroying view
    const contents = this.viewManager?.getWebContents(panelId) ?? undefined;

    // Clean up event listener tracking (must happen before view destruction)
    this.cleanupBrowserStateTracking(panelId, contents);
    this.cleanupLinkInterception(panelId, contents);

    // Cleanup based on panel type (typeOverride used during type-change teardown
    // when the snapshot already reflects the new type)
    const panelType = typeOverride ?? getPanelType(panel);
    switch (panelType) {
      case "browser":
        // Unregister from CDP server
        getCdpServer().unregisterBrowser(panelId);
        break;

      case "app":
        // App panel cleanup
        // Revoke server-side tokens for this panel (fire-and-forget)
        void this.serverInfo.revokePanelToken(panelId);
        void this.serverInfo.revokeGitToken(panelId);

        // Revoke CDP token for this panel (cleans up browser ownership)
        getCdpServer().revokeTokenForPanel(panelId);

        // Clean up any Claude Code conversations for this panel
        getClaudeCodeConversationManager().endPanelConversations(panelId);

        // Clean up HTTP-served panel content
        this.panelHttpServer?.removePanel(panelId);
        break;

      case "shell":
        // Shell panel cleanup — remove from PanelHttpServer
        this.panelHttpServer?.removePanel(panelId);
        break;
    }

    // Destroy the WebContentsView (but keep panel in memory/tree)
    if (this.viewManager?.hasView(panelId)) {
      this.viewManager.destroyView(panelId);
    }

    // Note: We intentionally do NOT delete from this.panels - panel stays in tree
  }

  private findParentPanel(childId: string): Panel | null {
    for (const panel of this.panels.values()) {
      if (panel.children.some((c) => c.id === childId)) {
        return panel;
      }
    }
    return null;
  }

  /**
   * Close a panel and all its descendants, cleaning up resources.
   * Does NOT remove from parent's children array (caller handles that via splice).
   */
  private closePanelSubtree(panel: Panel): void {
    // Recursively close children first (copy to avoid mutation during iteration)
    for (const child of [...panel.children]) {
      this.closePanelSubtree(child);
    }

    // Unload all resources (view, CDP, git tokens, Claude Code, HTTP panel)
    // Note: unloadPanelResources handles:
    //   - browserStateCleanup and linkInterceptionHandlers cleanup
    //   - viewManager.destroyView (which triggers cleanup via 'destroyed' event)
    //   - getCdpServer().revokeTokenForPanel / unregisterBrowser
    //   - gitServer.revokeTokenForPanel
    //   - getClaudeCodeConversationManager().endPanelConversations
    //   - panelHttpServer.removePanel (if applicable)
    this.unloadPanelResources(panel.id);

    // Unregister panel→context mapping (permanent removal only)
    this.fsService?.unregisterPanelContext(panel.id);

    // Clean up other ID-keyed structures not covered by unloadPanelResources
    this.pendingBrowserNavigations.delete(panel.id);

    // Remove from panels map
    this.panels.delete(panel.id);

    // Archive in persistence
    const persistence = getPanelPersistence();
    persistence.archivePanel(panel.id);
  }

  /**
   * Find the parent panel ID for a given child panel ID.
   * Returns null if the panel is a root panel or not found.
   */
  findParentId(childId: string): string | null {
    const parent = this.findParentPanel(childId);
    return parent?.id ?? null;
  }

  /**
   * Check if a panel is a descendant of another panel.
   */
  isDescendantOf(panelId: string, potentialAncestorId: string): boolean {
    const visited = new Set<string>();
    const MAX_DEPTH = 100;
    let depth = 0;

    let currentId: string | null = panelId;
    while (currentId && depth < MAX_DEPTH) {
      if (visited.has(currentId)) {
        console.error(`[PanelManager] Cycle detected at ${currentId}`);
        return false;
      }
      visited.add(currentId);

      const parent = this.findParentPanel(currentId);
      if (!parent) return false;
      if (parent.id === potentialAncestorId) return true;

      currentId = parent.id;
      depth++;
    }

    return false;
  }

  /**
   * Move a panel to a new parent at a specific position.
   * Used for drag-and-drop reordering and reparenting.
   */
  movePanel(panelId: string, newParentId: string | null, targetPosition: number): void {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    // Validate: can't move panel into its own descendants
    if (newParentId && this.isDescendantOf(newParentId, panelId)) {
      throw new Error("Cannot move panel into its own subtree");
    }

    // Validate newParentId exists BEFORE modifying the tree.
    // This prevents orphaning the panel if validation fails.
    let newParent: SharedPanel.Panel | undefined;
    if (newParentId) {
      newParent = this.panels.get(newParentId);
      if (!newParent) {
        throw new Error(`New parent panel not found: ${newParentId}`);
      }
    }

    // Remove from current parent's children array
    const currentParent = this.findParentPanel(panelId);
    if (currentParent) {
      const idx = currentParent.children.findIndex((c) => c.id === panelId);
      if (idx >= 0) {
        currentParent.children.splice(idx, 1);
      }
      // Clear selectedChildId if it pointed to the moved panel
      if (currentParent.selectedChildId === panelId) {
        currentParent.selectedChildId = null;
      }
    } else {
      // It's a root panel - remove from rootPanels
      const idx = this.rootPanels.findIndex((p) => p.id === panelId);
      if (idx >= 0) {
        this.rootPanels.splice(idx, 1);
      }
    }

    // Add to new parent at target position
    if (newParent) {
      // Clamp position to valid range
      const clampedPosition = Math.max(0, Math.min(targetPosition, newParent.children.length));
      newParent.children.splice(clampedPosition, 0, panel);
    } else {
      // Moving to root level
      const clampedPosition = Math.max(0, Math.min(targetPosition, this.rootPanels.length));
      this.rootPanels.splice(clampedPosition, 0, panel);
    }

    // Persist to database
    const persistence = getPanelPersistence();
    persistence.movePanel(panelId, newParentId, targetPosition);

    // Notify renderer
    this.notifyPanelTreeUpdate();
  }

  // =========================================================================
  // Collapse State
  // =========================================================================

  /**
   * Get all collapsed panel IDs for the current workspace.
   */
  getCollapsedIds(): string[] {
    return getPanelPersistence().getCollapsedIds();
  }

  /**
   * Set collapse state for a single panel.
   */
  setCollapsed(panelId: string, collapsed: boolean): void {
    getPanelPersistence().setCollapsed(panelId, collapsed);
  }

  /**
   * Expand multiple panels (set collapsed = false).
   */
  expandIds(panelIds: string[]): void {
    getPanelPersistence().setCollapsedBatch(panelIds, false);
  }

  /**
   * Update the selected path in the in-memory tree when a panel is focused.
   * Walks up from the focused panel and sets each ancestor's selectedChildId.
   */
  updateSelectedPath(focusedPanelId: string): void {
    this.focusedPanelId = focusedPanelId;
    const visited = new Set<string>();
    const MAX_DEPTH = 100;
    let currentId: string | null = focusedPanelId;
    let depth = 0;

    while (currentId && depth < MAX_DEPTH) {
      if (visited.has(currentId)) {
        console.error(`[PanelManager] Cycle detected in panel tree at ${currentId}`);
        break;
      }
      visited.add(currentId);

      const parent = this.findParentPanel(currentId);
      if (!parent) break;

      // Update the parent's selectedChildId to point to current
      parent.selectedChildId = currentId;

      // Move up to the parent
      currentId = parent.id;
      depth++;
    }

    if (depth >= MAX_DEPTH) {
      console.error(`[PanelManager] Max depth exceeded in updateSelectedPath`);
    }

    // Update which views are protected from throttling/disposal
    this.updateProtectedViews(focusedPanelId);
  }

  /**
   * Get all panel IDs in the active lineage: ancestors + focused panel + all descendants.
   * These panels should have background throttling disabled to prevent Electron from
   * garbage collecting their render frames during idle periods.
   */
  private getActivePanelLineage(focusedPanelId: string): Set<string> {
    const lineage = new Set<string>();

    // Add the focused panel
    lineage.add(focusedPanelId);

    // Walk up to get all ancestors
    let currentId: string | null = focusedPanelId;
    let depth = 0;
    const MAX_DEPTH = 100;

    while (currentId && depth < MAX_DEPTH) {
      const parent = this.findParentPanel(currentId);
      if (!parent) break;
      lineage.add(parent.id);
      currentId = parent.id;
      depth++;
    }

    // Walk down to get all descendants of the focused panel
    const addDescendants = (panel: Panel) => {
      for (const child of panel.children) {
        lineage.add(child.id);
        addDescendants(child);
      }
    };

    const focusedPanel = this.panels.get(focusedPanelId);
    if (focusedPanel) {
      addDescendants(focusedPanel);
    }

    return lineage;
  }

  /**
   * Update which panels are protected from throttling/disposal.
   * Delegates to ViewManager which handles all the mechanics.
   */
  private updateProtectedViews(focusedPanelId: string): void {
    if (!this.viewManager) return;
    const lineage = this.getActivePanelLineage(focusedPanelId);
    this.viewManager.setProtectedViews(lineage);
  }

  /**
   * Handle a view crash reported by ViewManager.
   * Implements crash recovery policy with loop protection.
   */
  private handleViewCrashed(viewId: string, reason: string): void {
    console.warn(`[PanelManager] View ${viewId} crashed: ${reason}`);
    void logMemorySnapshot({ reason: `view-crash:${viewId}:${reason}` });

    if (!this.shouldAttemptReload(viewId)) {
      console.error(`[PanelManager] Giving up on ${viewId} after repeated crashes`);
      return;
    }

    log.verbose(` Attempting reload of ${viewId}`);
    const reloadSuccess = this.viewManager?.reloadView(viewId) ?? false;

    if (!reloadSuccess) {
      console.warn(`[PanelManager] Reload failed for ${viewId}, attempting view recreation`);
      void this.recreatePanelView(viewId);
    }
  }

  /**
   * Check if we should attempt to reload a crashed view.
   * Returns false if the view has crashed too many times recently (crash loop protection).
   */
  private shouldAttemptReload(viewId: string): boolean {
    const now = Date.now();
    const history = this.crashHistory.get(viewId) ?? [];

    // Keep only recent crashes within the window
    const recent = history.filter((t) => now - t < this.CRASH_WINDOW_MS);

    if (recent.length >= this.MAX_CRASHES) {
      return false;
    }

    // Record this crash
    recent.push(now);
    this.crashHistory.set(viewId, recent);
    return true;
  }

  /**
   * Recreate a panel view after a crash when reload fails.
   * Destroys the zombie view and creates a fresh one.
   */
  private async recreatePanelView(panelId: string): Promise<void> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      console.error(`[PanelManager] Cannot recreate view: panel ${panelId} not found`);
      return;
    }

    // Destroy the zombie view if it exists
    if (this.viewManager?.hasView(panelId)) {
      log.verbose(` Destroying zombie view for ${panelId}`);
      this.viewManager.destroyView(panelId);
    }

    // Recreate based on panel type
    const panelType = getPanelType(panel);
    const contextId = getPanelContextId(panel);

    try {
      if (panelType === "browser") {
        const snapshot = getCurrentSnapshot(panel);
        const url = snapshot.resolvedUrl ?? getPanelSource(panel);
        await this.createViewForPanel(panelId, url, "browser", contextId);
        log.verbose(` Recreated browser view for ${panelId}`);
      } else if (panelType === "shell") {
        await this.restoreShellPanel(panel);
        log.verbose(` Recreated shell view for ${panelId}`);
      } else if (panelType === "app") {
        // For app panels, check if we have a built URL to restore
        const snapshot = getCurrentSnapshot(panel);
        const builtUrl = snapshot.resolvedUrl;
        if (builtUrl) {
          // Panel was built, recreate with the built URL
          await this.createViewForPanel(panelId, builtUrl, "panel", contextId);
          log.verbose(` Recreated ${panelType} view for ${panelId}`);
        } else {
          // Panel wasn't built yet or lost build state - trigger rebuild
          log.verbose(` No built URL for ${panelId}, triggering rebuild`);
          panel.artifacts = { buildState: "pending" };
          this.notifyPanelTreeUpdate();
        }
      }
    } catch (error) {
      console.error(
        `[PanelManager] Failed to recreate view for ${panelId}:`,
        error instanceof Error ? error.message : error
      );
      // Mark panel as needing rebuild
      panel.artifacts = { buildState: "pending" };
      this.notifyPanelTreeUpdate();
    }
  }

  /**
   * Find a browser panel by its URL.
   * Used for auto-registering browser webviews when they attach.
   * Returns null if no matching browser panel is found.
   */
  findBrowserPanelByUrl(url: string): Panel | null {
    // Normalize the URL for comparison
    const normalizedUrl = url.toLowerCase();

    for (const panel of this.panels.values()) {
      if (getPanelType(panel) === "browser") {
        const snapshot = getCurrentSnapshot(panel);
        const browserUrl = snapshot.resolvedUrl?.toLowerCase();
        // Match if URLs are the same or if the browser navigated (URL might have changed)
        if (browserUrl && (normalizedUrl.startsWith(browserUrl) || browserUrl.startsWith(normalizedUrl))) {
          return panel;
        }
      }
    }
    return null;
  }

  /**
   * Notify renderer of panel tree changes.
   * Debounced to batch rapid updates (e.g., worker console logs).
   */
  notifyPanelTreeUpdate(): void {
    // Mark update pending
    this.treeUpdatePending = true;

    // If timer already running, let it handle the update
    if (this.treeUpdateTimer) {
      return;
    }

    // Schedule debounced update
    this.treeUpdateTimer = setTimeout(() => {
      this.treeUpdateTimer = null;
      if (this.treeUpdatePending && this.viewManager) {
        this.treeUpdatePending = false;
        const tree = this.getSerializablePanelTree();
        eventService.emit("panel-tree-updated", tree);
      }
    }, this.TREE_UPDATE_DEBOUNCE_MS);
  }

  private serializePanel(panel: Panel): Panel {
    // Panel is already serializable in the new architecture
    // (env is in snapshot.options, not top-level)
    return {
      ...panel,
      children: panel.children.map((child) => this.serializePanel(child)),
    };
  }

  getRootPanels(): Panel[] {
    return this.rootPanels;
  }

  getPanel(id: string): Panel | undefined {
    return this.panels.get(id);
  }

  getFocusedPanelId(): string | null {
    return this.focusedPanelId;
  }

  /**
   * Get children with pagination, enriched with runtime buildState.
   * Routes through PanelManager to include in-memory build state.
   */
  getChildrenPaginated(
    parentId: string,
    offset: number,
    limit: number
  ): { children: SharedPanel.PanelSummary[]; total: number; hasMore: boolean } {
    const persistence = getPanelPersistence();
    const result = persistence.getChildrenPaginated(parentId, offset, limit);

    // Enrich summaries with runtime buildState from in-memory panels
    const enrichedChildren = result.children.map((summary) => {
      const panel = this.panels.get(summary.id);
      return {
        ...summary,
        buildState: panel?.artifacts?.buildState,
      };
    });

    return {
      ...result,
      children: enrichedChildren,
    };
  }

  /**
   * Get root panels with pagination, enriched with runtime buildState.
   * Routes through PanelManager to include in-memory build state.
   */
  getRootPanelsPaginated(
    offset: number,
    limit: number
  ): { panels: SharedPanel.PanelSummary[]; total: number; hasMore: boolean } {
    const persistence = getPanelPersistence();
    const result = persistence.getRootPanelsPaginated(offset, limit);

    // Enrich summaries with runtime buildState from in-memory panels
    const enrichedPanels = result.panels.map((summary) => {
      const panel = this.panels.get(summary.id);
      return {
        ...summary,
        buildState: panel?.artifacts?.buildState,
      };
    });

    return {
      ...result,
      panels: enrichedPanels,
    };
  }

  /**
   * Get the workspace tree of all git repos.
   * Delegates to server via ServerInfo.
   */
  async getWorkspaceTree(): Promise<SharedPanel.WorkspaceTree> {
    return this.serverInfo.getWorkspaceTree() as Promise<SharedPanel.WorkspaceTree>;
  }

  /**
   * List branches for a repo.
   * Delegates to server via ServerInfo.
   */
  async listBranches(repoPath: string): Promise<SharedPanel.BranchInfo[]> {
    return this.serverInfo.listBranches(repoPath) as Promise<SharedPanel.BranchInfo[]>;
  }

  /**
   * List commits for a repo/ref.
   * Delegates to server via ServerInfo.
   */
  async listCommits(repoPath: string, ref?: string, limit?: number): Promise<SharedPanel.CommitInfo[]> {
    return this.serverInfo.listCommits(repoPath, ref ?? "HEAD", limit ?? 50) as Promise<SharedPanel.CommitInfo[]>;
  }

  /**
   * List discovered agents.
   * Delegates to server via ServerInfo.
   */
  async listAgents(): Promise<unknown> {
    return this.serverInfo.listAgents();
  }

  // Map panelId -> browser state tracking cleanup info
  private browserStateCleanup = new Map<string, { cleanup: () => void; destroyedHandler: () => void }>();
  // Map panelId -> link interception handler for will-navigate
  private linkInterceptionHandlers = new Map<string, (event: Electron.Event, url: string) => void>();
  // Map panelId -> content load handlers (dom-ready, did-finish-load) for cleanup
  private contentLoadHandlers = new Map<string, { domReady?: () => void; didFinishLoad?: () => void }>();

  /**
   * Get WebContents for a panel.
   * Used for sending IPC messages to panels.
   */
  getWebContentsForPanel(panelId: string): Electron.WebContents | undefined {
    if (!this.viewManager) {
      return undefined;
    }
    return this.viewManager.getWebContents(panelId) ?? undefined;
  }

}

// Global PanelManager instance for internal use
let _globalPanelManager: PanelManager | null = null;

/**
 * Set the global PanelManager instance.
 * Called during app initialization.
 */
export function setGlobalPanelManager(pm: PanelManager): void {
  _globalPanelManager = pm;
}

/**
 * Get the global PanelManager instance.
 * Returns null if not yet initialized.
 */
export function getPanelManager(): PanelManager | null {
  return _globalPanelManager;
}
