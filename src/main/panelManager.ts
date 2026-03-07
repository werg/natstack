import * as path from "path";
import { randomBytes } from "crypto";
import { nativeTheme } from "electron";
import { createDevLogger } from "../shared/devLog.js";

const log = createDevLogger("PanelManager");
import type { PanelEventPayload, Panel, PanelManifest } from "./panelTypes.js";
import {
  loadPanelManifest,
  getCurrentSnapshot,
  getPanelSource,
  getPanelContextId,
  createSnapshot,
  getSourcePage,
  getPanelStateArgs,
} from "./panelTypes.js";
import { validateStateArgs } from "../shared/stateArgsValidator.js";
import type { StateArgsValue } from "../shared/stateArgs.js";
import type { ServerInfo } from "./serverInfo.js";
import type { Workspace } from "../shared/workspace/types.js";
import { normalizeRelativePanelPath } from "./pathUtils.js";
import type { FsService } from "../shared/fsService.js";
import {
  computePanelId as _computePanelId,
  sanitizePanelIdSegment as _sanitizePanelIdSegment,
  generatePanelNonce as _generatePanelNonce,
} from "../shared/panelIdUtils.js";
import * as SharedPanel from "../shared/types.js";
import type { ClaudeCodeConversationManager } from "../shared/ai/claudeCodeConversationManager.js";
import { contextIdToSubdomain } from "../shared/panelIdUtils.js";
import { PanelHttpServer } from "../server/panelHttpServer.js";
import type { CdpServer } from "./cdpServer.js";
import type { TokenManager } from "../shared/tokenManager.js";
import type { ViewManager } from "./viewManager.js";
import { checkWorktreeClean, checkGitRepository } from "./gitChecks.js";
import { eventService } from "../shared/eventsService.js";
import { getPanelPersistence, type PanelPersistence } from "../shared/db/panelPersistence.js";
import { getPanelSearchIndex } from "../shared/db/panelSearchIndex.js";
import { logMemorySnapshot } from "./memoryMonitor.js";

type PanelCreateOptions = {
  name?: string;
  env?: Record<string, string>;
  /**
   * Explicit context ID for storage partition sharing.
   * If provided, the panel will use this context ID instead of generating a new one.
   * This enables multiple panels to share the same filesystem and storage partition.
   */
  contextId?: string;
  /** If true, immediately focus the new panel after creation (only applies to app panels) */
  focus?: boolean;
};

/** Parsed result from a *.localhost panel URL */
type ParsedPanelUrl = {
  source: string;
  isShell: boolean;
  contextId?: string;
  options: PanelCreateOptions;
  stateArgs?: Record<string, unknown>;
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

  private cdpServer: CdpServer;
  private tokenManager: TokenManager;
  private workspace: Workspace | null;
  private persistence: PanelPersistence | null;
  private ccConversationManager: ClaudeCodeConversationManager | null;

  constructor(serverInfo: ServerInfo, cdpServer: CdpServer, tokenManager: TokenManager, workspace: Workspace | null, ccConversationManager?: ClaudeCodeConversationManager) {
    this.serverInfo = serverInfo;
    this.cdpServer = cdpServer;
    this.tokenManager = tokenManager;
    this.workspace = workspace;
    this.panelsRoot = workspace?.path ?? path.resolve(process.cwd());
    this.persistence = workspace ? getPanelPersistence(workspace) : null;
    this.ccConversationManager = ccConversationManager ?? null;
  }


  setClaudeCodeConversationManager(mgr: ClaudeCodeConversationManager): void {
    this.ccConversationManager = mgr;
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

    // Wire callbacks: all panel data flows through these — zero per-panel state on server
    server.setCallbacks({
      onDemandCreate: async (source, subdomain) => {
        const panelId = await this.createPanelOnDemand(source, subdomain);
        // Ensure token exists — it may have been revoked if panel was previously unloaded
        const rpcToken = this.tokenManager.ensureToken(panelId, "panel");
        const serverRpcToken = await this.serverInfo.ensurePanelToken(panelId, "panel");
        return { panelId, rpcPort: this.rpcPort!, rpcToken, serverRpcPort: this.serverInfo.rpcPort, serverRpcToken };
      },
      listPanels: () => this.listPanels(),
      onBuildComplete: (source, error) => {
        // Per-panel fan-out: notify all panels using this source
        for (const [panelId, panel] of this.panels) {
          if (getPanelSource(panel) === source) {
            if (error) {
              panel.artifacts = { buildState: "error", error, buildProgress: error };
            } else {
              panel.artifacts = {
                htmlPath: this.getPanelUrl(panelId)!,
                buildState: "ready",
              };
            }
            this.persistArtifacts(panelId, panel.artifacts);
          }
        }
        this.notifyPanelTreeUpdate();
      },
      getBuild: async (source) => {
        return this.serverInfo.call("build", "getBuild", [source]) as Promise<
          import("../server/buildV2/buildStore.js").BuildResult
        >;
      },
    });
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
   * Initialize the panel tree - load from DB if exists, otherwise show about/new launcher.
   */
  private async initializePanelTree(): Promise<void> {
    const persistence = this.persistence!;

    try {
      // Try to load existing panels from database
      const existingPanels = persistence.getFullTree();

      if (existingPanels.length > 0) {
        // Clean up about/* panels that have no children (they served their purpose)
        this.cleanupChildlessShellPanels(existingPanels, persistence);

        // Filter out panels that were archived during cleanup
        const remainingPanels = existingPanels.filter((p: Panel) => !persistence.isArchived(p.id));

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
        await this.createAboutPanel("new");
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
    const initPanels = this.workspace?.config.initPanels ?? [];

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
    const rootPanelSource = this.workspace?.config.rootPanel;
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
    await this.createAboutPanel("new");
  }

  /**
   * Archive shell panels (about/* sources) that have no children at startup/shutdown.
   *
   * Shell panels are launcher UIs (e.g., about/new, about/about) that exist
   * primarily to launch other panels. A childless shell panel indicates the
   * user opened a launcher but never launched anything from it. These serve
   * no purpose in the tree and should be cleaned up.
   *
   * Note: This only applies to about/* panels, not regular app panels
   * which users might legitimately want to keep without children.
   */
  private cleanupChildlessShellPanels(
    panels: Panel[],
    persistence: PanelPersistence
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
      const shellPage = getSourcePage(panel);
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
   * Archives childless about/* panels so they don't clutter the tree on next startup.
   */
  public runShutdownCleanup(): void {
    console.log("[PanelManager] Running shutdown cleanup...");
    const persistence = this.persistence!;
    this.cleanupChildlessShellPanels(this.rootPanels, persistence);

    // Clear accumulated maps to prevent memory leaks
    this.crashHistory.clear();
    this.browserStateCleanup.clear();
    this.linkInterceptionHandlers.clear();
    this.contentLoadHandlers.clear();

  }

  /**
   * Recursively restore panels from database.
   * All panels are restored as unloaded and rebuild on focus.
   */
  private restorePanelViews(panels: Panel[]): void {
    for (const panel of panels) {
      try {
        // All panels rebuild only when focused/loaded.
        this.markPanelUnloaded(panel);
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
   * Get the ViewManager (throws if not set).
   */
  getViewManager(): ViewManager {
    if (!this.viewManager) {
      throw new Error("ViewManager not set - call setViewManager first");
    }
    return this.viewManager;
  }

  /**
   * Create a WebContentsView for a panel.
   * Called when panel build is ready or panel is created.
   * @param panelId - The panel's tree ID
   * @param url - The URL to load
   * @param _type - Unused, kept for call-site compatibility (always "panel")
   * @param contextId - The context ID for partition
   * @throws Error if ViewManager is not set
   */
  async createViewForPanel(panelId: string, url: string, _type: "panel" = "panel", contextId?: string): Promise<void> {
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

    // Set subdomain-scoped auth cookie + nonce-keyed boot cookie before
    // creating the view, so the webview's first request is already authenticated.
    let viewUrl = url;
    if (this.panelHttpServer && this.panelHttpPort && panel) {
      const ctxId = getPanelContextId(panel);
      const subdomain = contextIdToSubdomain(ctxId);
      const source = getPanelSource(panel);
      const rpcToken = this.tokenManager.ensureToken(panelId, "panel");
      const origin = `http://${subdomain}.localhost:${this.panelHttpPort}`;
      const bk = randomBytes(8).toString("hex");

      const sid = this.panelHttpServer.ensureSubdomainSession(subdomain);
      const { session: electronSession } = await import("electron");
      await electronSession.defaultSession.cookies.set({
        url: `${origin}/`,
        name: "_ns_session",
        value: sid,
        path: "/",
        httpOnly: true,
        sameSite: "strict",
      });
      await electronSession.defaultSession.cookies.set({
        url: `${origin}/`,
        name: `_ns_boot_${bk}`,
        value: encodeURIComponent(JSON.stringify({
          pid: panelId,
          rpcPort: this.rpcPort!,
          rpcToken,
        })),
        path: "/",
        httpOnly: false,
        sameSite: "strict",
        expirationDate: Math.floor(Date.now() / 1000) + 60,
      });

      // Server RPC port/token for the second WS connection (build, AI, DB services)
      const serverRpcToken = await this.serverInfo.ensurePanelToken(panelId, "panel");
      viewUrl = `${origin}/${source}/?pid=${encodeURIComponent(panelId)}&_bk=${bk}&rpcPort=${this.rpcPort!}&rpcToken=${encodeURIComponent(rpcToken)}&serverRpcPort=${this.serverInfo.rpcPort}&serverRpcToken=${encodeURIComponent(serverRpcToken)}`;
    }

    // All panels served via HTTP subdomain.
    // Config fetched at runtime by loader script; subdomain origin isolation
    // replaces Electron partition-based isolation.
    const view = this.viewManager.createView({
      id: panelId,
      type: "panel",
      preload: null, // No preload — config fetched at runtime via /__config
      url: viewUrl,
      parentId: parentId ?? undefined,
      injectHostThemeVariables: true,
    });

    // Track browser state (URL, loading, title) for all panels
    this.setupBrowserStateTracking(panelId, view.webContents);

    // Register panels with CDP server for automation/testing
    // Use named handler for cleanup
    if (parentId) {
      const domReadyHandler = () => {
        this.cdpServer.registerBrowser(panelId, view.webContents.id, parentId);
      };
      view.webContents.on("dom-ready", domReadyHandler);
      this.contentLoadHandlers.set(panelId, { domReady: domReadyHandler });
    }

    // Intercept localhost URL and http(s) link clicks to create children
    this.setupLinkInterception(panelId, view.webContents);
  }

  /**
   * Setup webContents event tracking for browser state (URL, loading, navigation).
   */
  private setupBrowserStateTracking(panelId: string, contents: Electron.WebContents): void {
    let pendingState: Partial<{ url?: string; pageTitle?: string; isLoading?: boolean; canGoBack?: boolean; canGoForward?: boolean }> = {};
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let cleaned = false;

    const flushPendingState = () => {
      if (cleaned) return; // Don't update after cleanup
      if (Object.keys(pendingState).length > 0) {
        this.updatePanelState(panelId, pendingState);
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
        // Update panel source metadata if the source path changed (same-subdomain nav)
        try {
          const parsed = new URL(url);
          // Extract source from pathname: /panels/chat/ → panels/chat
          const pathSource = parsed.pathname.replace(/^\//, "").replace(/\/$/, "");
          const panel = this.panels.get(panelId);
          if (panel && pathSource && getPanelSource(panel) !== pathSource) {
            panel.snapshot.source = pathSource;
            log.verbose(` Panel ${panelId} source updated to: ${pathSource}`);
            this.persistPanel(panel, this.findParentId(panelId));
          }
        } catch {
          // Non-URL navigations (about:blank etc.) — ignore
        }
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
   * Set up link interception for HTTP-based panel navigation.
   *
   * Click behavior:
   * - Normal click: Navigate in-place (unless action=child)
   * - Middle/Ctrl/Cmd-click or target="_blank": Create child
   *
   * URL handling:
   * - *.localhost URLs with panel paths → panel navigation/creation
   * - http(s):// external URLs from app panels → browser child
   * - Browser views: allow normal http(s) navigation in place
   */
  private setupLinkInterception(
    panelId: string,
    contents: Electron.WebContents,
  ): void {
    // Intercept new-window requests (middle click / ctrl+click / target="_blank").
    contents.setWindowOpenHandler((details) => {
      const url = details.url;

      const parsed = this.parseLocalhostUrl(url);
      if (parsed) {
        void this.createPanel(
          panelId,
          parsed.source,
          parsed.options,
          parsed.stateArgs
        ).catch((err: unknown) => this.handleChildCreationError(panelId, err, url));
        return { action: "deny" };
      }

      if (/^https?:\/\//i.test(url)) {
        // External URLs — open in system browser
        import("electron").then(({ shell }) => shell.openExternal(url));
        return { action: "deny" };
      }

      return { action: "deny" };
    });

    // Intercept navigation: external URLs → system browser, cross-subdomain → context switch.
    const willNavigateHandler = (event: Electron.Event, url: string) => {
      // External URLs → system browser
      if (!url.includes(".localhost:") && !url.includes("//localhost:")) {
        if (/^https?:\/\//i.test(url)) {
          event.preventDefault();
          import("electron").then(({ shell }) => shell.openExternal(url));
        }
        return;
      }

      // Cross-subdomain: detect and handle context switch
      const panel = this.panels.get(panelId);
      if (!panel || !this.panelHttpServer || !this.panelHttpPort) return;

      const currentSubdomain = contextIdToSubdomain(getPanelContextId(panel));
      try {
        const targetUrl = new URL(url);
        const targetSubdomain = targetUrl.hostname.endsWith(".localhost")
          ? targetUrl.hostname.slice(0, -".localhost".length)
          : null;

        if (!targetSubdomain || targetSubdomain === currentSubdomain) return;
        // Different subdomain → intercept, update context, re-navigate with auth

        event.preventDefault();
        void this.handleCrossContextNavigation(panelId, panel, targetUrl, targetSubdomain)
          .catch((err) => log.warn(`[CrossCtx] Navigation failed for ${panelId}:`, err));
      } catch { /* not a valid URL, let it pass */ }
    };

    // Store and register the handler for cleanup
    this.linkInterceptionHandlers.set(panelId, willNavigateHandler);
    contents.on("will-navigate", willNavigateHandler);
  }

  /**
   * Parse a *.localhost URL into panel navigation parameters.
   * Returns null if the URL is not a localhost panel URL or is an asset request.
   */
  private parseLocalhostUrl(url: string): ParsedPanelUrl | null {
    try {
      const u = new URL(url);
      if (!u.hostname.endsWith(".localhost") && u.hostname !== "localhost") return null;

      // Extract source path (first two segments) from pathname
      const match = u.pathname.match(/^\/([^/]+\/[^/]+)(\/.*)?$/);
      if (!match) return null;
      const source = match[1]!;
      const resource = match[2] || "/";

      // Only treat as panel navigation if resource is "/" (index page).
      // Requests for /bundle.js, /assets/style.css etc. are asset fetches.
      if (resource !== "/") return null;

      // Bootstrap/recovery URLs are the panel's own load, not user navigation.
      // _bk = nonce-keyed boot cookie, pid = Electron panel ID seeding,
      // _fresh = recovery redirect for stale/missing sessionStorage.
      if (u.searchParams.has("_bk") || u.searchParams.has("pid") || u.searchParams.has("_fresh")) return null;

      return {
        source,
        isShell: source.startsWith("about/"),
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
   * Handle cross-subdomain navigation by updating the panel's context in-place
   * and re-navigating the existing webview with proper auth cookies.
   *
   * This avoids triggering onDemandCreate on the HTTP server, which would
   * try to create a duplicate panel.
   */
  private async handleCrossContextNavigation(
    panelId: string,
    panel: Panel,
    targetUrl: URL,
    targetSubdomain: string,
  ): Promise<void> {
    if (!this.panelHttpServer || !this.panelHttpPort || !this.viewManager) return;

    // Parse source from URL pathname: /panels/chat/ → panels/chat
    const pathMatch = targetUrl.pathname.match(/^\/([^/]+\/[^/]+)(\/.*)?$/);
    if (!pathMatch) {
      log.warn(`[CrossCtx] Cannot parse source from URL: ${targetUrl.href}`);
      return;
    }
    const source = pathMatch[1]!;

    // Parse stateArgs from URL query params
    let stateArgs: Record<string, unknown> | undefined;
    if (targetUrl.searchParams.has("stateArgs")) {
      try {
        stateArgs = JSON.parse(targetUrl.searchParams.get("stateArgs")!);
      } catch { /* ignore parse errors */ }
    }

    // Derive new contextId from the target subdomain's query params or the subdomain itself.
    // buildPanelLink puts contextId in the query when crossing contexts.
    const newContextId = targetUrl.searchParams.get("contextId") ?? targetSubdomain;

    log.info(`[CrossCtx] Panel ${panelId}: context switch ${contextIdToSubdomain(getPanelContextId(panel))} → ${targetSubdomain} (source: ${source})`);

    // Save old state for rollback on failure
    const oldContextId = panel.snapshot.contextId;
    const oldSource = panel.snapshot.source;
    const oldStateArgs = panel.snapshot.stateArgs;

    try {
      // 1. Set auth cookies for the new subdomain (same pattern as createViewForPanel)
      const rpcToken = this.tokenManager.ensureToken(panelId, "panel");
      const origin = `http://${targetSubdomain}.localhost:${this.panelHttpPort}`;
      const bk = randomBytes(8).toString("hex");

      const sid = this.panelHttpServer.ensureSubdomainSession(targetSubdomain);
      const { session: electronSession } = await import("electron");
      await electronSession.defaultSession.cookies.set({
        url: `${origin}/`,
        name: "_ns_session",
        value: sid,
        path: "/",
        httpOnly: true,
        sameSite: "strict",
      });
      await electronSession.defaultSession.cookies.set({
        url: `${origin}/`,
        name: `_ns_boot_${bk}`,
        value: encodeURIComponent(JSON.stringify({
          pid: panelId,
          rpcPort: this.rpcPort!,
          rpcToken,
        })),
        path: "/",
        httpOnly: false,
        sameSite: "strict",
        expirationDate: Math.floor(Date.now() / 1000) + 60,
      });

      // 2. Build authenticated URL
      const serverRpcToken = await this.serverInfo.ensurePanelToken(panelId, "panel");
      const authUrl = `${origin}/${source}/?pid=${encodeURIComponent(panelId)}&_bk=${bk}&rpcPort=${this.rpcPort!}&rpcToken=${encodeURIComponent(rpcToken)}&serverRpcPort=${this.serverInfo.rpcPort}&serverRpcToken=${encodeURIComponent(serverRpcToken)}`;

      // 3. Update panel snapshot (context, source, stateArgs) — after async ops succeed
      panel.snapshot.contextId = newContextId;
      panel.snapshot.source = source;
      if (stateArgs !== undefined) {
        panel.snapshot.stateArgs = stateArgs;
      }

      // 4. Re-register FS mapping for the new context
      this.fsService?.registerPanelContext(panelId, newContextId);

      // 5. Navigate the existing webview
      await this.viewManager.navigateView(panelId, authUrl);

      // 6. Persist updated snapshot and notify panel tree
      this.persistPanel(panel, this.findParentId(panelId));
      this.notifyPanelTreeUpdate();
    } catch (err) {
      // Rollback snapshot on failure
      panel.snapshot.contextId = oldContextId;
      panel.snapshot.source = oldSource;
      panel.snapshot.stateArgs = oldStateArgs;
      this.fsService?.registerPanelContext(panelId, oldContextId);
      throw err;
    }
  }

  /**
   * Focus a panel by its ID.
   * Switches the UI to show the specified panel.
   */
  focusPanel(targetPanelId: string): void {
    // Find the panel
    const panel = this.getPanel(targetPanelId);
    if (!panel) {
      console.warn(`[PanelManager] Cannot focus panel - not found: ${targetPanelId}`);
      return;
    }

    this.updateSelectedPath(targetPanelId);
    this.persistence!.updateSelectedPath(targetPanelId);
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
    }
  ): Promise<Record<string, string> | undefined> {
    const gitToken = await this.serverInfo.getGitTokenForPanel(panelId);
    const serverUrl = this.serverInfo.gitBaseUrl;

    // Build git config for panel environment
    const gitConfig = gitInfo
      ? JSON.stringify({
          serverUrl,
          token: gitToken,
          sourceRepo: gitInfo.sourceRepo,
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
    const workspacePath = this.workspace?.path;

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
    stateArgs?: Record<string, unknown>;
  }): Promise<{ id: string; title: string }> {
    const { manifest, relativePath, parent, options, isRoot, addAsRoot, stateArgs } = params;

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
    this.tokenManager.createToken(panelId, "panel");              // Electron WS auth

    try {
      await this.serverInfo.createPanelToken(panelId, "panel");     // Server git/pubsub auth
      // Resolve context ID: use provided contextId if available, otherwise generate a DNS-safe one from panel ID
      const contextId = options.contextId ?? `ctx-${panelId.replace(/[^a-z0-9]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 59)}`;

      // Register panel→context mapping for fs service routing
      this.fsService?.registerPanelContext(panelId, contextId);

      const panelEnv = await this.buildPanelEnv(panelId, options?.env, {
        sourceRepo: relativePath,
      });

      // Create the initial snapshot with all options and stateArgs
      const initialSnapshot = createSnapshot(
        relativePath,
        contextId,
        {
          env: panelEnv,
        },
        validatedStateArgs
      );

      // Create the panel with snapshot
      const panel: Panel = {
        id: panelId,
        title: manifest.title,
        children: [],
        selectedChildId: null,
        snapshot: initialSnapshot,
        artifacts: {
          buildState: "building",
          buildProgress: "Starting build...",
        },
      };

      if (isRoot && addAsRoot) {
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
      if (options?.focus) {
        this.focusPanel(panel.id);
      } else {
        this.notifyPanelTreeUpdate();
      }

      // Compute URL directly — no HTTP server registration needed.
      // Build happens on demand when the webview requests it.
      const panelSource = relativePath;
      const htmlUrl = this.getPanelUrl(panel.id)!;

      // For interactive (non-programmatic) panels, check git state first
      if (!options.contextId) {
        const absolutePanelPath = path.resolve(this.panelsRoot, panelSource);
        const { isRepo, path: repoPath } = await checkGitRepository(absolutePanelPath);
        if (!isRepo) {
          // Load git-init shell page directly in the webview
          const gitInitUrl = this.getPanelUrlForSource(panel, `about/git-init`);
          panel.snapshot = createSnapshot("about/git-init", getPanelContextId(panel), {}, { repoPath });
          await this.createViewForPanel(panel.id, gitInitUrl, "panel", getPanelContextId(panel));
          return { id: panel.id, title: panel.title };
        }
        const { clean, path: cleanRepoPath } = await checkWorktreeClean(absolutePanelPath);
        if (!clean) {
          const dirtyUrl = this.getPanelUrlForSource(panel, `about/dirty-repo`);
          panel.snapshot = createSnapshot("about/dirty-repo", getPanelContextId(panel), {}, { repoPath: cleanRepoPath });
          await this.createViewForPanel(panel.id, dirtyUrl, "panel", getPanelContextId(panel));
          return { id: panel.id, title: panel.title };
        }
      }

      // Create webview immediately — shows building page, then panel when ready
      await this.createViewForPanel(panel.id, htmlUrl, "panel", getPanelContextId(panel));

      // Set build state — if build is already cached, mark ready immediately.
      // Otherwise HTTP server builds on-demand and notifies via onBuildComplete.
      const buildCached = this.panelHttpServer?.hasBuild(panelSource) ?? false;
      panel.artifacts = {
        htmlPath: htmlUrl,
        buildState: buildCached ? "ready" : "building",
        buildProgress: buildCached ? undefined : "Waiting for build...",
      };
      this.notifyPanelTreeUpdate();

      return { id: panel.id, title: panel.title };
    } catch (err) {
      // If panel creation fails after token was created, clean up
      this.tokenManager.revokeToken(panelId);
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
      const persistence = this.persistence!;
      const currentSnapshot = getCurrentSnapshot(panel);
      // Check if panel already exists (e.g., on app restart)
      const existingPanel = persistence.getPanel(panel.id);

      // If the panel exists but is archived, unarchive it and update all fields
      if (existingPanel && persistence.isArchived(panel.id)) {
        persistence.unarchivePanel(panel.id);
        // Update all panel data with current values
        // Note: artifacts are NOT persisted - they're runtime-only state
        persistence.updatePanel(panel.id, {
          parentId,
          snapshot: panel.snapshot,
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
      } else {
        // Update existing active panel's snapshot in DB
        persistence.updatePanel(panel.id, {
          parentId,
          snapshot: currentSnapshot,
        });
      }

      // Index panel for search
      try {
        const searchIndex = getPanelSearchIndex();
        const source = currentSnapshot.source;
        searchIndex.indexPanel({
          id: panel.id,
          title: panel.title,
          path: source,
        });
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
   * - Shell pages with "about/" prefix (e.g., "about/about", "about/model-provider-config")
   *
   * A child panel is created under the caller.
   * Main process handles git checkout and build asynchronously.
   * Returns panel info immediately; build happens in background.
   */
  async createPanel(
    callerId: string,
    source: string,
    options?: PanelCreateOptions,
    stateArgs?: Record<string, unknown>
  ): Promise<{ id: string; title: string }> {
    const caller = this.panels.get(callerId);
    if (!caller) {
      throw new Error(`Caller panel not found: ${callerId}`);
    }

    // Caller is the parent of the new panel
    const parent: Panel | null = caller;

    // Shell pages (about/*) use the same creation path as regular panels
    if (source.startsWith("about/")) {
      // Shell pages don't have manifests on disk; use a minimal manifest
      const page = source.slice(6);
      const manifest: PanelManifest = { title: page };
      return this.createPanelFromManifest({
        manifest,
        relativePath: source,
        parent,
        options: options ?? {},
        stateArgs,
      });
    }

    const { relativePath, absolutePath } = this.normalizePanelPath(source);

    // Read manifest to check singleton state and get title
    let manifest: PanelManifest;
    try {
      manifest = loadPanelManifest(absolutePath);
    } catch (error) {
      if (options?.contextId) {
        // Programmatic launch (e.g. agent's launch_panel tool): workspace
        // directory may not have files yet (push checkout is async). Use a
        // minimal manifest — the build system handles file discovery.
        manifest = { title: path.basename(relativePath) };
      } else {
        throw new Error(
          `Failed to load manifest for ${source}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return this.createPanelFromManifest({
      manifest,
      relativePath,
      parent,
      options: options ?? {},
      stateArgs,
    });
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
        const persistence = this.persistence!;
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
    const persistence = this.persistence!;
    persistence.archivePanel(panelId);

    // Notify tree update
    this.notifyPanelTreeUpdate();
  }

  // Navigation removed — URL-based navigation, browser handles history natively.

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
   * Update search index for a panel.
   */
  private updateSearchIndex(panel: Panel): void {
    try {
      const searchIndex = getPanelSearchIndex();
      const source = getPanelSource(panel);

      searchIndex.indexPanel({
        id: panel.id,
        title: panel.title,
        path: source,
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
    return getPanelSource(panel);
  }


  /**
   * Update browser panel state (URL, loading, navigation capabilities).
   * Called when the renderer forwards webview events.
   */
  /**
   * Update panel metadata from webview navigation events.
   * Simplified: just tracks title changes for the panel tree UI.
   */
  updatePanelState(
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
    if (!panel) return;

    const snapshot = getCurrentSnapshot(panel);

    if (state.url !== undefined) {
      snapshot.resolvedUrl = state.url;
    }

    if (state.pageTitle !== undefined) {
      panel.title = state.pageTitle;
      try {
        const persistence = this.persistence!;
        persistence.setTitle(browserId, state.pageTitle);
      } catch (error) {
        console.error(`[PanelManager] Failed to persist title for ${browserId}:`, error);
      }
      try {
        const searchIndex = getPanelSearchIndex();
        searchIndex.updateTitle(browserId, state.pageTitle);
      } catch {}
    }

    this.notifyPanelTreeUpdate();
  }


  /**
   * Create a shell panel for system pages (model-provider-config, about, etc.).
   * Shell panels are app panels with source `about/{page}`.
   * Most pages are singletons (navigating to existing shows it, not creates new).
   * The "new" page supports multiple instances for launching different panels.
   */
  async createAboutPanel(
    page: SharedPanel.ShellPage
  ): Promise<{ id: string; title: string }> {
    // "new" pages can have multiple instances, others are singletons
    const isMultiInstance = page === "new";

    if (!isMultiInstance) {
      const panelId = `about/${page}`;
      const existing = this.panels.get(panelId);
      if (existing) {
        // Focus existing panel and return
        this.focusPanel(existing.id);
        return { id: existing.id, title: existing.title };
      }
    }

    const source = `about/${page}`;
    const manifest: PanelManifest = { title: page };
    const name = isMultiInstance ? `about/${page}~${Date.now().toString(36)}` : undefined;

    const result = await this.createPanelFromManifest({
      manifest,
      relativePath: source,
      parent: null,
      options: { name, focus: true },
      isRoot: true,
      addAsRoot: true,
    });

    return result;
  }

  /**
   * Create an initialization panel as a root panel.
   * Used for panels specified in workspace config's initPanels array.
   * These panels are created on first initialization when the panel tree is empty.
   * Unlike createPanel, this doesn't require a caller and adds to roots without resetting.
   */
  async createInitPanel(
    source: string
  ): Promise<{ id: string; title: string }> {
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
   * Note: Returns the unified Panel type.
   */
  findShellPanel(page: SharedPanel.ShellPage): Panel | null {
    const panelId = `about/${page}`;
    const panel = this.panels.get(panelId);
    if (panel && getPanelSource(panel).startsWith("about/")) {
      return panel;
    }
    return null;
  }

  /**
   * Create a panel on-demand when a browser visits a registered subdomain.
   * Idempotent: if a panel with this source already runs on this subdomain, returns its ID.
   */
  async createPanelOnDemand(source: string, subdomain: string): Promise<string> {
    // Reuse existing panel on this subdomain if one exists
    for (const [id, panel] of this.panels) {
      if (getPanelSource(panel) === source && contextIdToSubdomain(getPanelContextId(panel)) === subdomain) {
        return id;
      }
    }

    // Use subdomain as contextId so the created panel's HTTP config subdomain
    // matches the requested subdomain (contextIdToSubdomain(subdomain) === subdomain
    // for DNS-safe subdomains from the source registry).
    const { relativePath, absolutePath } = this.normalizePanelPath(source);
    const manifest = loadPanelManifest(absolutePath);
    return (await this.createPanelFromManifest({
      manifest,
      relativePath,
      parent: null,
      options: { contextId: subdomain },
      isRoot: true,
      addAsRoot: true,
    })).id;
  }

  /**
   * Return bootstrap config for a panel, delivered via RPC.
   * Called by bridge.getBootstrapConfig handler.
   */
  async getBootstrapConfig(callerId: string): Promise<unknown> {
    const panel = this.panels.get(callerId);
    if (!panel) throw new Error(`Panel not found: ${callerId}`);

    const contextId = getPanelContextId(panel);
    const subdomain = contextIdToSubdomain(contextId);
    const parentId = this.findParentId(panel.id) ?? null;
    const rpcToken = this.tokenManager.ensureToken(panel.id, "panel");
    const gitToken = await this.serverInfo.getGitTokenForPanel(panel.id);
    const snapshot = getCurrentSnapshot(panel);
    const env = snapshot.options.env ?? {};
    const stateArgs = getPanelStateArgs(panel) ?? {};
    const pubsubPort = parseInt(new URL(this.serverInfo.pubsubUrl).port, 10);

    // Ensure the panel has a server-side token for direct server RPC + PubSub auth
    const serverRpcToken = await this.serverInfo.getPanelToken(panel.id)
      ?? await this.serverInfo.ensurePanelToken(panel.id, "panel");

    const gitConfig = {
      serverUrl: this.serverInfo.gitBaseUrl,
      token: gitToken,
      sourceRepo: getPanelSource(panel),
    };
    const pubsubConfig = {
      serverUrl: `ws://${subdomain}.localhost:${pubsubPort}`,
      token: serverRpcToken,
    };

    return {
      panelId: panel.id,
      contextId,
      parentId,
      theme: this.currentTheme,
      rpcPort: this.rpcPort!,
      rpcToken,
      serverRpcPort: this.serverInfo.rpcPort,
      serverRpcToken,
      gitConfig,
      pubsubConfig,
      env: {
        ...env,
        PARENT_ID: parentId ?? "",
        __GIT_CONFIG: JSON.stringify(gitConfig),
        __PUBSUB_CONFIG: JSON.stringify(pubsubConfig),
      },
      stateArgs,
    };
  }

  /**
   * Get the HTTP URL for a panel (computes from panel data + known port).
   */
  getPanelUrl(panelId: string): string | null {
    const panel = this.panels.get(panelId);
    if (!panel || !this.panelHttpPort) return null;
    const subdomain = contextIdToSubdomain(getPanelContextId(panel));
    return `http://${subdomain}.localhost:${this.panelHttpPort}/${getPanelSource(panel)}/`;
  }

  /**
   * Get the HTTP URL for a panel with a specific source (e.g. shell pages).
   */
  private getPanelUrlForSource(panel: Panel, source: string): string {
    const subdomain = contextIdToSubdomain(getPanelContextId(panel));
    return `http://${subdomain}.localhost:${this.panelHttpPort}/${source}/`;
  }

  /**
   * List all panels for the management API.
   */
  listPanels(): Array<{
    panelId: string;
    title: string;
    subdomain: string;
    source: string;
    parentId: string | null;
    contextId: string;
  }> {
    return [...this.panels.values()].map(panel => ({
      panelId: panel.id,
      title: panel.title,
      subdomain: contextIdToSubdomain(getPanelContextId(panel)),
      source: getPanelSource(panel),
      parentId: this.findParentId(panel.id),
      contextId: getPanelContextId(panel),
    }));
  }

  /**
   * Build a panel asynchronously: invalidate build cache and create/refresh
   * webview. The HTTP server builds on demand when the webview loads the URL
   * and notifies via onBuildComplete.
   */
  private async buildPanelAsync(panel: Panel): Promise<void> {
    const panelSource = getPanelSource(panel);

    // Invalidate cached build so the HTTP server triggers a fresh build
    this.panelHttpServer?.invalidateBuild(panelSource);

    panel.artifacts = {
      ...panel.artifacts,
      buildState: "building",
      buildProgress: "Waiting for build...",
    };
    this.notifyPanelTreeUpdate();

    // Create webview — HTTP server serves building page, then auto-refreshes
    const htmlUrl = this.getPanelUrl(panel.id)!;
    await this.createViewForPanel(panel.id, htmlUrl, "panel", getPanelContextId(panel));
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

      // Only reset panels with ready or error state
      if (buildState === "ready" || buildState === "error") {
        // Invalidate source-keyed build cache so next request triggers fresh build
        const source = getPanelSource(panel);
        this.panelHttpServer?.invalidateBuild(source);
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
    // revoked on unload, so we must recreate them before serving the panel.
    this.tokenManager.ensureToken(panelId, "panel");
    await this.serverInfo.ensurePanelToken(panelId, "panel");

    // Set building state
    panel.artifacts = {
      buildState: "building",
      buildProgress: "Rebuilding panel...",
    };
    this.notifyPanelTreeUpdate();

    // All panels rebuild via the same path
    await this.rebuildAppPanel(panel);
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

    // Persist snapshot
    this.persistPanel(panel, this.findParentId(panel.id));

    // StateArgs changes are picked up via getBootstrapConfig RPC on next load.
    // No per-panel HTTP server state to update.

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

    // Reload the panel — user resolved dirty state, rebuild from scratch
    await this.rebuildUnloadedPanel(panelId);
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

    // Reload the panel — user initialized the git repo, rebuild from scratch
    await this.rebuildUnloadedPanel(panelId);
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
    // Theme changes are picked up via getBootstrapConfig RPC on next load.
    // No per-panel HTTP server state to update.
  }

  /**
   * Clear subdomain sessions if no other panels remain on the same subdomain.
   * Called during panel close cleanup.
   */
  private clearSubdomainSessionsIfEmpty(panelId: string): void {
    if (!this.panelHttpServer) return;
    const panel = this.panels.get(panelId);
    if (!panel) return;
    const subdomain = contextIdToSubdomain(getPanelContextId(panel));
    const remainingOnSubdomain = [...this.panels.values()].some(
      p => p.id !== panelId && contextIdToSubdomain(getPanelContextId(p)) === subdomain,
    );
    if (!remainingOnSubdomain) {
      this.panelHttpServer.clearSubdomainSessions(subdomain);
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
  private unloadPanelResources(panelId: string): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;

    // Close open file handles for this panel (safe on any teardown path)
    this.fsService?.closeHandlesForPanel(panelId);

    // Revoke auth token (disconnects WS connections via onRevoke listener)
    this.tokenManager.revokeToken(panelId);

    // Clean up crash history for this panel
    this.crashHistory.delete(panelId);

    // Get webContents for cleanup before destroying view
    const contents = this.viewManager?.getWebContents(panelId) ?? undefined;

    // Clean up event listener tracking (must happen before view destruction)
    this.cleanupBrowserStateTracking(panelId, contents);
    this.cleanupLinkInterception(panelId, contents);

    // Clean up panel resources (all panels are type "app" now)
    // Revoke server-side tokens for this panel (fire-and-forget)
    void this.serverInfo.revokePanelToken(panelId);
    void this.serverInfo.revokeGitToken(panelId);

    // Revoke CDP token for this panel (cleans up browser ownership)
    this.cdpServer.revokeTokenForPanel(panelId);

    // Clean up any Claude Code conversations for this panel
    this.ccConversationManager?.endPanelConversations(panelId);

    // Clear subdomain sessions if no panels remain on this subdomain
    this.clearSubdomainSessionsIfEmpty(panelId);

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
    //   - this.cdpServer.revokeTokenForPanel
    //   - gitServer.revokeTokenForPanel
    //   - ccConversationManager.endPanelConversations
    //   - clearSubdomainSessionsIfEmpty (cleans up HTTP sessions when last panel on subdomain closes)
    this.unloadPanelResources(panel.id);

    // Unregister panel→context mapping (permanent removal only)
    this.fsService?.unregisterPanelContext(panel.id);

    // Remove from panels map
    this.panels.delete(panel.id);

    // Archive in persistence
    const persistence = this.persistence!;
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
    const persistence = this.persistence!;
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
    return this.persistence!.getCollapsedIds();
  }

  /**
   * Set collapse state for a single panel.
   */
  setCollapsed(panelId: string, collapsed: boolean): void {
    this.persistence!.setCollapsed(panelId, collapsed);
  }

  /**
   * Expand multiple panels (set collapsed = false).
   */
  expandIds(panelIds: string[]): void {
    this.persistence!.setCollapsedBatch(panelIds, false);
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

    // Recreate view for the panel
    const contextId = getPanelContextId(panel);

    try {
      // Check if we have a built URL to restore
      const snapshot = getCurrentSnapshot(panel);
      const builtUrl = snapshot.resolvedUrl;
      if (builtUrl) {
        // Panel was built, recreate with the built URL
        await this.createViewForPanel(panelId, builtUrl, "panel", contextId);
        log.verbose(` Recreated view for ${panelId}`);
      } else {
        // Panel wasn't built yet or lost build state - trigger rebuild
        log.verbose(` No built URL for ${panelId}, triggering rebuild`);
        panel.artifacts = { buildState: "pending" };
        this.notifyPanelTreeUpdate();
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
    const persistence = this.persistence!;
    const result = persistence.getChildrenPaginated(parentId, offset, limit);

    // Enrich summaries with runtime buildState from in-memory panels
    const enrichedChildren = result.children.map((summary: SharedPanel.PanelSummary) => {
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
    const persistence = this.persistence!;
    const result = persistence.getRootPanelsPaginated(offset, limit);

    // Enrich summaries with runtime buildState from in-memory panels
    const enrichedPanels = result.panels.map((summary: SharedPanel.PanelSummary) => {
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

