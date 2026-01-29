import { app, BaseWindow, nativeTheme, session } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// Silence Electron security warnings in dev; panels run in isolated webviews.
process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";

import { isDev } from "./utils.js";
import { PanelManager, setGlobalPanelManager } from "./panelManager.js";
import { GitServer } from "./gitServer.js";
import { handle } from "./ipc/handlers.js";
import type * as SharedPanel from "../shared/ipc/types.js";
import { getPanelType } from "../shared/panel/accessors.js";
import { setupMenu } from "./menu.js";
import { setActiveWorkspace, getAppRoot } from "./paths.js";
import {
  parseCliWorkspacePath,
  discoverWorkspace,
  createWorkspace,
  loadCentralEnv,
} from "./workspace/loader.js";
import type { Workspace, AppMode } from "./workspace/types.js";
import { getCentralData } from "./centralData.js";
import { registerPanelProtocol, setupPanelProtocol } from "./panelProtocol.js";
import { setupAboutProtocol } from "./aboutProtocol.js";
import { getMainCacheManager } from "./cacheManager.js";
import { getCdpServer, type CdpServer } from "./cdpServer.js";
import { getPubSubServer, type PubSubServer } from "./pubsubServer.js";
import { createVerdaccioServer, type VerdaccioServer } from "./verdaccioServer.js";
import { createGitWatcher, type GitWatcher } from "./workspace/gitWatcher.js";
import { eventService } from "./services/eventsService.js";
import { getDatabaseManager } from "./db/databaseManager.js";
import { shutdownPackageStore, scheduleGC } from "./package-store/index.js";
import { handleDbCall } from "./ipc/dbHandlers.js";
import { handleBridgeCall } from "./ipc/bridgeHandlers.js";
import { handleBrowserCall } from "./ipc/browserHandlers.js";
import { handleAiServiceCall } from "./ipc/aiHandlers.js";
import {
  initViewManager,
  getViewManager,
  type ViewManager,
} from "./viewManager.js";
import type { RpcMessage, RpcResponse } from "@natstack/rpc";
import { generateRequestId } from "../shared/logging.js";
import { getServiceDispatcher, parseServiceMethod, SHELL_CALLER_ID } from "./serviceDispatcher.js";
import { checkServiceAccess } from "./servicePolicy.js";
import {
  handleAppService,
  handlePanelService,
  handleViewService,
  handleMenuService,
  handleWorkspaceService,
  handleCentralService,
  handleSettingsService,
  setShellServicesPanelManager,
  setShellServicesAppMode,
  setShellServicesAiHandler,
} from "./ipc/shellServices.js";
import { handleEventsService } from "./services/eventsService.js";
import { typeCheckRpcMethods } from "./typecheck/service.js";
import { setupTestApi } from "./testApi.js";
import { getAdBlockManager } from "./adblock/index.js";
import { handleAdBlockServiceCall } from "./ipc/adblockHandlers.js";
import { preloadNatstackTypesAsync } from "@natstack/runtime/typecheck";
import { startMemoryMonitor } from "./memoryMonitor.js";

// =============================================================================
// Protocol Registration (must happen before app ready)
// =============================================================================

// Register custom protocol for serving panel bundles
registerPanelProtocol();

// =============================================================================
// Configuration Initialization
// =============================================================================

// Load central environment variables first (.env and .secrets.yml from ~/.config/natstack/)
loadCentralEnv();

// Parse CLI arguments
const cliWorkspacePath = parseCliWorkspacePath();

// Determine startup workspace (CLI > env > walk-up > default), but only if config exists
const discoveredWorkspacePath = discoverWorkspace(cliWorkspacePath);
const configPath = path.join(discoveredWorkspacePath, "natstack.yml");
const hasWorkspaceConfig = fs.existsSync(configPath);

// If CLI path was explicitly provided but has no config, error and exit
if (cliWorkspacePath && !hasWorkspaceConfig) {
  console.error(`[Error] Workspace config not found at ${discoveredWorkspacePath}`);
  console.error(`[Error] Expected natstack.yml at: ${configPath}`);
  app.quit();
  process.exit(1);
}

let appMode: AppMode = hasWorkspaceConfig ? "main" : "chooser";
let workspace: Workspace | null = null;
let gitServer: GitServer | null = null;
let gitWatcher: GitWatcher | null = null;
let cdpServer: CdpServer | null = null;
let pubsubServer: PubSubServer | null = null;
let verdaccioServer: VerdaccioServer | null = null;
let panelManager: PanelManager | null = null;
let mainWindow: BaseWindow | null = null;
let viewManager: ViewManager | null = null;
let isCleaningUp = false; // Prevent re-entry in will-quit handler

// Export AI handler for use by other modules (will be set during initialization)
export let aiHandler: import("./ai/aiHandler.js").AIHandler | null = null;

/**
 * Get the GitServer instance.
 * Used by the context template resolver for GitHub ref resolution.
 */
export function getGitServer(): GitServer | null {
  return gitServer;
}

// =============================================================================
// Main Mode Initialization
// =============================================================================

if (appMode === "main" && hasWorkspaceConfig) {
  try {
    workspace = createWorkspace(discoveredWorkspacePath);
    setActiveWorkspace(workspace);
    console.log(`[Workspace] Loaded: ${workspace.path} (id: ${workspace.config.id})`);

    // Add to recent workspaces
    const centralData = getCentralData();
    centralData.addRecentWorkspace(workspace.path, workspace.config.id);

    // Create git server with workspace configuration
    // GitHub token can come from config or GITHUB_TOKEN env var (set from secrets.yml)
    const githubConfig = workspace.config.git?.github;
    gitServer = new GitServer({
      port: workspace.config.git?.port,
      reposPath: workspace.gitReposPath,
      github: {
        ...githubConfig,
        token: githubConfig?.token ?? process.env["GITHUB_TOKEN"],
      },
    });

    // Create panel manager
    panelManager = new PanelManager(gitServer);
    setGlobalPanelManager(panelManager);

    // Set up test API for E2E testing (only when NATSTACK_TEST_MODE=1)
    setupTestApi(panelManager);
  } catch (error) {
    console.error(
      "[Workspace] Failed to initialize workspace, falling back to chooser mode:",
      error
    );
    appMode = "chooser";
  }
}

setShellServicesAppMode(appMode);
console.log(`[App] Starting in ${appMode} mode`);

// =============================================================================
// Window Creation
// =============================================================================

function createWindow(): void {
  // Create BaseWindow (no webContents of its own)
  // Start hidden to avoid layout flash - shown after shell content loads
  mainWindow = new BaseWindow({
    width: 1200,
    height: appMode === "main" ? 600 : 500,
    show: false,
    titleBarStyle: "hidden",
    ...(process.platform !== "darwin"
      ? {
          titleBarOverlay: true,
        }
      : {}),
  });

  // Initialize ViewManager with shell view
  viewManager = initViewManager({
    window: mainWindow,
    shellPreload: path.join(__dirname, "preload.cjs"),
    safePreload: path.join(__dirname, "safePreload.cjs"),
    shellHtmlPath: path.join(__dirname, "index.html"),
    devTools: isDev(),
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    viewManager = null;
  });

  // Set ViewManager reference in panel manager (if in main mode)
  if (panelManager && viewManager) {
    panelManager.setViewManager(viewManager);
  }

  // Optional memory diagnostics (env-driven).
  startMemoryMonitor();

  // Setup application menu (uses shell webContents for menu events)
  setupMenu(mainWindow, viewManager.getShellWebContents(), {
    onHistoryBack: () => {
      const pm = requirePanelManager();
      const panelId = pm.getFocusedPanelId();
      if (!panelId || !pm.getPanel(panelId)) return;
      void pm.goBack(panelId).catch((error) => {
        console.error(`[Menu] Failed to navigate back for ${panelId}:`, error);
      });
    },
    onHistoryForward: () => {
      const pm = requirePanelManager();
      const panelId = pm.getFocusedPanelId();
      if (!panelId || !pm.getPanel(panelId)) return;
      void pm.goForward(panelId).catch((error) => {
        console.error(`[Menu] Failed to navigate forward for ${panelId}:`, error);
      });
    },
  });
}

// =============================================================================
// Panel IPC Handlers (renderer <-> main) - Only in main mode
// =============================================================================

// Helper to ensure we're in main mode with panel manager
function requirePanelManager(): PanelManager {
  if (!panelManager) {
    throw new Error("Panel operations not available in workspace chooser mode");
  }
  return panelManager;
}

// Helper to get sender ID and validate authorization
function assertAuthorized(event: Electron.IpcMainInvokeEvent, panelId: string): void {
  const pm = requirePanelManager();
  const senderPanelId = pm.getPanelIdForWebContents(event.sender);
  if (senderPanelId !== panelId) {
    throw new Error(`Unauthorized: Sender ${senderPanelId} cannot act as ${panelId}`);
  }
}

// =============================================================================
// Unified RPC Handler (panel <-> main) - Only in main mode
// =============================================================================

handle("rpc:call", async (event, panelId: string, message: RpcMessage): Promise<RpcResponse> => {
  assertAuthorized(event, panelId);

  if (message.type !== "request") {
    return {
      type: "response",
      requestId: "unknown",
      error: "Invalid RPC message type (expected request)",
    };
  }

  const { requestId, method, args } = message;
  const parsedMethod = parseServiceMethod(method);
  if (!parsedMethod) {
    return {
      type: "response",
      requestId,
      error: `Invalid method format: "${method}". Expected "service.method"`,
    };
  }

  const { service, method: serviceMethod } = parsedMethod;

  // Determine caller kind based on panel type
  // Shell panels (type: "shell") get shell-level access to services
  const pm = requirePanelManager();
  const panel = pm.getPanel(panelId);
  const panelType = panel ? getPanelType(panel) : undefined;
  const callerKind = (panelType === "shell" ? "shell" : "panel") as import("./serviceDispatcher.js").CallerKind;

  // Check service access policy
  try {
    checkServiceAccess(service, callerKind);
  } catch (error) {
    return {
      type: "response",
      requestId,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const dispatcher = getServiceDispatcher();
  const ctx = { callerId: panelId, callerKind, webContents: event.sender };

  try {
    const result = await dispatcher.dispatch(ctx, service, serviceMethod, args);
    return { type: "response", requestId, result };
  } catch (error) {
    return {
      type: "response",
      requestId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

// =============================================================================
// Panel Bridge IPC Handlers (panel webview <-> main) - Only in main mode
// =============================================================================

handle("panel-bridge:register", async (event, panelId: string, authToken: string) => {
  // This is the initial handshake, so we don't use assertAuthorized yet.
  // Instead, we verify the token which proves identity.
  requirePanelManager().verifyAndRegister(panelId, authToken, event.sender.id);
});

// Register a browser webview with the CDP server (called from renderer when webview is ready)
handle("panel:register-browser-webview", async (_event, browserId: string, webContentsId: number) => {
  const pm = requirePanelManager();

  // Find the parent panel for this browser
  const panel = pm.getPanel(browserId);
  if (!panel || getPanelType(panel) !== "browser") {
    throw new Error(`Browser panel not found: ${browserId}`);
  }

  // Find the parent panel ID
  const parentId = pm.findParentId(browserId);
  if (!parentId) {
    throw new Error(`Parent panel not found for browser: ${browserId}`);
  }

  console.log(`[CDP] registerBrowser: browserId=${browserId}, parentId=${parentId}, webContentsId=${webContentsId}`);
  // Register with CDP server (idempotent - may be called multiple times on dom-ready)
  getCdpServer().registerBrowser(browserId, webContentsId, parentId);
});

// Update browser panel state (called from renderer when webview events fire)
handle(
  "panel:update-browser-state",
  async (
    _event,
    browserId: string,
    state: { url?: string; pageTitle?: string; isLoading?: boolean; canGoBack?: boolean; canGoForward?: boolean }
  ) => {
    const pm = requirePanelManager();
    pm.updateBrowserState(browserId, state);
  }
);

// Unified history integration for app panels (pushState/replaceState/back/forward/go)
handle("panel:history-push", async (event, panelId: string, payload: { state: unknown; path: string }) => {
  assertAuthorized(event, panelId);
  const pm = requirePanelManager();
  pm.handleHistoryPushState(panelId, payload.state, payload.path);
});

handle("panel:history-replace", async (event, panelId: string, payload: { state: unknown; path: string }) => {
  assertAuthorized(event, panelId);
  const pm = requirePanelManager();
  pm.handleHistoryReplaceState(panelId, payload.state, payload.path);
});

handle("panel:history-back", async (event, panelId: string) => {
  assertAuthorized(event, panelId);
  const pm = requirePanelManager();
  await pm.goBack(panelId);
});

handle("panel:history-forward", async (event, panelId: string) => {
  assertAuthorized(event, panelId);
  const pm = requirePanelManager();
  await pm.goForward(panelId);
});

handle("panel:history-go", async (event, panelId: string, offset: number) => {
  assertAuthorized(event, panelId);
  const pm = requirePanelManager();
  await pm.goToHistoryOffset(panelId, offset);
});

handle("panel:history-reload", async (event, panelId: string) => {
  assertAuthorized(event, panelId);
  const pm = requirePanelManager();
  await pm.reloadPanel(panelId);
});

// Open devtools for a panel (called from panel preload keyboard shortcut)
handle("panel:open-devtools", async (event, panelId: string) => {
  assertAuthorized(event, panelId);
  const vm = getViewManager();
  vm.openDevTools(panelId);
});

// =============================================================================
// Shell RPC Handler (unified RPC transport for shell)
// =============================================================================

handle("shell-rpc:call", async (event, message: RpcMessage): Promise<RpcResponse> => {
  // Verify caller is the shell WebContents (security check)
  const vm = getViewManager();
  const shellContents = vm.getShellWebContents();
  if (event.sender !== shellContents) {
    return {
      type: "response",
      requestId: (message as { requestId?: string }).requestId ?? "unknown",
      error: "Unauthorized: only shell can call shell-rpc:call",
    };
  }

  if (message.type !== "request") {
    return {
      type: "response",
      requestId: (message as { requestId?: string }).requestId ?? "unknown",
      error: "Invalid RPC message type (expected request)",
    };
  }

  const { requestId, method, args } = message;
  const parsedMethod = parseServiceMethod(method);
  if (!parsedMethod) {
    return {
      type: "response",
      requestId,
      error: `Invalid method format: "${method}". Expected "service.method"`,
    };
  }

  const { service, method: serviceMethod } = parsedMethod;

  // Check service access policy
  try {
    checkServiceAccess(service, "shell");
  } catch (error) {
    return {
      type: "response",
      requestId,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const dispatcher = getServiceDispatcher();
  const ctx = {
    callerId: SHELL_CALLER_ID,
    callerKind: "shell" as const,
    webContents: event.sender,
  };

  try {
    const result = await dispatcher.dispatch(ctx, service, serviceMethod, args);
    return { type: "response", requestId, result };
  } catch (error) {
    return {
      type: "response",
      requestId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

// =============================================================================
// App Lifecycle
// =============================================================================

app.on("ready", async () => {
  // Set up panel protocol handler
  setupPanelProtocol();
  setupAboutProtocol();

  // Initialize cache manager (shared across all panels)
  const cacheManager = getMainCacheManager();
  await cacheManager.initialize();

  // Schedule package store garbage collection (runs daily, removes packages unused for 30 days)
  // This is non-blocking and runs in the background
  const cancelGC = scheduleGC(24 * 60 * 60 * 1000); // Run daily
  app.on("will-quit", () => cancelGC());

  // Pre-warm @natstack/* type cache before any TypeCheckService is created.
  // This avoids blocking sync I/O when TypeCheckService is first instantiated.
  const packagesDir = path.join(getAppRoot(), "packages");
  if (fs.existsSync(packagesDir)) {
    await preloadNatstackTypesAsync(packagesDir);
  }

  // Initialize ad blocking (shared across all browser panels)
  try {
    const adBlockManager = getAdBlockManager();
    await adBlockManager.initialize();
    // Enable for default session (browser panels use this session)
    adBlockManager.enableForSession(session.defaultSession);
    console.log("[AdBlock] Initialized and enabled for default session");
  } catch (adBlockError) {
    console.warn("[AdBlock] Failed to initialize (non-fatal):", adBlockError);
  }

  // Register shell services (available in both modes)
  const dispatcher = getServiceDispatcher();
  dispatcher.register("app", handleAppService);
  dispatcher.register("view", handleViewService);
  dispatcher.register("menu", handleMenuService);
  dispatcher.register("workspace", handleWorkspaceService);
  dispatcher.register("central", handleCentralService);
  dispatcher.register("settings", handleSettingsService);
  dispatcher.register("events", handleEventsService);
  dispatcher.register("adblock", async (_ctx, serviceMethod, serviceArgs) => {
    return handleAdBlockServiceCall(serviceMethod, serviceArgs as unknown[]);
  });
  setShellServicesAppMode(appMode);

  // Initialize services only in main mode
  if (appMode === "main" && gitServer && panelManager && workspace) {
    try {
      // Register panel service (requires panel manager)
      dispatcher.register("panel", handlePanelService);
      setShellServicesPanelManager(panelManager);

      // Start Verdaccio server FIRST (other services may need to install packages)
      try {
        // Use app root for finding packages/ (not workspace parent)
        verdaccioServer = createVerdaccioServer({
          workspaceRoot: getAppRoot(),
          storagePath: path.join(app.getPath("userData"), "verdaccio-storage"),
        });
        const verdaccioPort = await verdaccioServer.start();
        console.log(`[Verdaccio] Registry started on port ${verdaccioPort}`);
        console.log("[Verdaccio] Lazy publishing enabled - packages published on demand during panel builds");
      } catch (verdaccioError) {
        // Verdaccio is required - log error but continue (panel builds will fail gracefully)
        console.error("[Verdaccio] Failed to start. Panel builds will fail until Verdaccio is running:", verdaccioError);
        verdaccioServer = null;
      }

      // Start git server
      const port = await gitServer.start();
      console.log(`[Git] Server started on port ${port}`);

      // Create GitWatcher to monitor workspace for repo changes
      gitWatcher = createGitWatcher(workspace);
      console.log("[GitWatcher] Started watching workspace for git changes");

      // Subscribe servers to GitWatcher events
      gitServer.subscribeToGitWatcher(gitWatcher);
      if (verdaccioServer) {
        // Pass workspace path so Verdaccio can resolve workspace-relative paths
        // (distinct from workspaceRoot which is for built-in @natstack/* packages)
        verdaccioServer.subscribeToGitWatcher(gitWatcher, workspace.path);
        // Note: User workspace packages are now published on-demand during panel builds
      }

      // Start CDP server for browser automation
      cdpServer = getCdpServer();
      const cdpPort = await cdpServer.start();
      console.log(`[CDP] Server started on port ${cdpPort}`);

      // Start PubSub server for real-time messaging
      pubsubServer = getPubSubServer();
      const pubsubPort = await pubsubServer.start();
      console.log(`[PubSub] Server started on port ${pubsubPort}`);

      // Initialize RPC handler
      const { PanelRpcHandler } = await import("./ipc/rpcHandler.js");
      new PanelRpcHandler(panelManager);

      dispatcher.register("bridge", async (ctx, serviceMethod, serviceArgs) => {
        return handleBridgeCall(panelManager, ctx.callerId, serviceMethod, serviceArgs);
      });

      dispatcher.register("db", async (ctx, serviceMethod, serviceArgs) => {
        return handleDbCall(getDatabaseManager(), ctx.callerId, serviceMethod, serviceArgs);
      });

      dispatcher.register("browser", async (ctx, serviceMethod, serviceArgs) => {
        return handleBrowserCall(
          getCdpServer(),
          getViewManager(),
          requirePanelManager(),
          ctx.callerId,
          ctx.callerKind,
          serviceMethod,
          serviceArgs
        );
      });

      // Initialize AI handler
      const { AIHandler } = await import("./ai/aiHandler.js");
      aiHandler = new AIHandler();
      await aiHandler.initialize();
      setShellServicesAiHandler(aiHandler);

      dispatcher.register("ai", async (ctx, serviceMethod, serviceArgs) => {
        return handleAiServiceCall(aiHandler, serviceMethod, serviceArgs, (handler, options, streamId) => {
          if (!ctx.webContents) {
            throw new Error("Missing webContents for AI stream");
          }
          handler.startPanelStream(ctx.webContents, ctx.callerId, options, streamId);
        });
      });

      // Register typecheck service for type definition fetching
      dispatcher.register("typecheck", async (_ctx, serviceMethod, serviceArgs) => {
        const args = serviceArgs as unknown[];
        switch (serviceMethod) {
          case "getPackageTypes":
            return typeCheckRpcMethods["typecheck.getPackageTypes"](
              args[0] as string,
              args[1] as string
            );
          case "getPackageTypesBatch":
            return typeCheckRpcMethods["typecheck.getPackageTypesBatch"](
              args[0] as string,
              args[1] as string[]
            );
          default:
            throw new Error(`Unknown typecheck method: ${serviceMethod}`);
        }
      });
    } catch (error) {
      console.error("Failed to initialize services:", error);
    }

    // Always mark initialized in main mode so registered services work
    // (even if some services failed to initialize)
    dispatcher.markInitialized();
  } else {
    // In chooser mode, mark initialized so shell services work
    dispatcher.markInitialized();
  }

  void createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Use will-quit with preventDefault to properly await async shutdown
app.on("will-quit", (event) => {
  // Prevent re-entry - if we're already cleaning up, let the app exit
  if (isCleaningUp) {
    return;
  }

  // Run panel cleanup (archive childless shell panels)
  if (panelManager) {
    try {
      panelManager.runShutdownCleanup();
    } catch (e) {
      console.error("[App] Failed to run shutdown cleanup:", e);
    }
  }

  const hasResourcesToClean = gitServer || gitWatcher || cdpServer || pubsubServer || verdaccioServer;
  if (hasResourcesToClean) {
    isCleaningUp = true;
    event.preventDefault();

    console.log("[App] Shutting down...");

    // Stop all servers in parallel
    const stopPromises: Promise<void>[] = [];

    if (cdpServer) {
      stopPromises.push(
        cdpServer
          .stop()
          .then(() => console.log("[App] CDP server stopped"))
          .catch((error) => {
            console.error("Error stopping CDP server:", error);
          })
      );
    }

    if (gitServer) {
      stopPromises.push(
        gitServer
          .stop()
          .then(() => console.log("[App] Git server stopped"))
          .catch((error) => {
            console.error("Error stopping git server:", error);
          })
      );
    }

    if (gitWatcher) {
      stopPromises.push(
        gitWatcher
          .close()
          .then(() => console.log("[App] GitWatcher stopped"))
          .catch((error) => {
            console.error("Error stopping GitWatcher:", error);
          })
      );
    }

    if (pubsubServer) {
      stopPromises.push(
        pubsubServer
          .stop()
          .then(() => console.log("[App] PubSub server stopped"))
          .catch((error) => {
            console.error("Error stopping PubSub server:", error);
          })
      );
    }

    if (verdaccioServer) {
      stopPromises.push(
        verdaccioServer
          .stop()
          .then(() => console.log("[App] Verdaccio server stopped"))
          .catch((error) => {
            console.error("Error stopping Verdaccio server:", error);
          })
      );
    }

    // Shutdown package store (closes SQLite connection)
    try {
      shutdownPackageStore();
      console.log("[App] Package store shutdown");
    } catch (error) {
      console.error("[App] Error shutting down package store:", error);
    }

    // Add a timeout to ensure we exit even if cleanup hangs
    const shutdownTimeout = setTimeout(() => {
      console.warn("[App] Shutdown timeout - forcing exit");
      app.exit(1);
    }, 5000);

    Promise.all(stopPromises).finally(() => {
      clearTimeout(shutdownTimeout);
      console.log("[App] Shutdown complete");
      app.exit(0);
    });
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    void createWindow();
  }
});

// Listen for system theme changes and notify subscribers
nativeTheme.on("updated", () => {
  eventService.emit(
    "system-theme-changed",
    nativeTheme.shouldUseDarkColors ? "dark" : "light"
  );
});
