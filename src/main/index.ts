import { app, BaseWindow, nativeTheme } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// DEBUG: Check if databases directory exists at the very start of main process
const earlyDbCheck = (() => {
  const home = os.homedir();
  const configDir = path.join(home, ".config", "natstack");
  const dbDir = path.join(configDir, "databases");
  const workspaceDbDir = path.join(dbDir, "natstack-dev");
  const dbFile = path.join(workspaceDbDir, "pubsub-messages.db");

  console.log(`[EARLY CHECK] At main process start:`);
  console.log(`[EARLY CHECK] - configDir exists: ${fs.existsSync(configDir)}`);
  console.log(`[EARLY CHECK] - dbDir exists: ${fs.existsSync(dbDir)}`);
  console.log(`[EARLY CHECK] - workspaceDbDir exists: ${fs.existsSync(workspaceDbDir)}`);
  console.log(`[EARLY CHECK] - dbFile exists: ${fs.existsSync(dbFile)}`);
  if (fs.existsSync(dbFile)) {
    const stats = fs.statSync(dbFile);
    console.log(`[EARLY CHECK] - dbFile size: ${stats.size}, inode: ${stats.ino}`);
  }
})();

// Silence Electron security warnings in dev; panels run in isolated webviews.
process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";

import { isDev } from "./utils.js";
import { PanelManager } from "./panelManager.js";
import { resolveInitialRootPanelPath, parseCliRootPanelPath } from "./rootPanelResolver.js";
import { GitServer } from "./gitServer.js";
import { handle } from "./ipc/handlers.js";
import type * as SharedPanel from "../shared/ipc/types.js";
import { setupMenu } from "./menu.js";
import { setActiveWorkspace } from "./paths.js";
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
import { eventService } from "./services/eventsService.js";
import { getDatabaseManager } from "./db/databaseManager.js";
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
const cliRootPanelPath = parseCliRootPanelPath();

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
let cdpServer: CdpServer | null = null;
let pubsubServer: PubSubServer | null = null;
let verdaccioServer: VerdaccioServer | null = null;
let panelManager: PanelManager | null = null;
let mainWindow: BaseWindow | null = null;
let viewManager: ViewManager | null = null;
let isCleaningUp = false; // Prevent re-entry in will-quit handler

// Export AI handler for use by other modules (will be set during initialization)
export let aiHandler: import("./ai/aiHandler.js").AIHandler | null = null;

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

    // Resolve root panel path: CLI arg > workspace config > default
    // Normalize all paths to be relative to workspace
    let initialRootPanelPath =
      cliRootPanelPath ?? workspace.config["root-panel"] ?? resolveInitialRootPanelPath();

    // If path is absolute, make it relative to workspace
    if (path.isAbsolute(initialRootPanelPath)) {
      initialRootPanelPath = path.relative(workspace.path, initialRootPanelPath);
    }

    console.log(`[Panel] Root panel: ${initialRootPanelPath}`);

    // Create git server with workspace configuration
    gitServer = new GitServer({
      port: workspace.config.git?.port,
      reposPath: workspace.gitReposPath,
    });

    // Create panel manager
    panelManager = new PanelManager(initialRootPanelPath, gitServer);
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

  // Setup application menu (uses shell webContents for menu events)
  setupMenu(mainWindow, viewManager.getShellWebContents());
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
  const callerKind = (panel?.type === "shell" ? "shell" : "panel") as import("./serviceDispatcher.js").CallerKind;

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
  if (!panel || panel.type !== "browser") {
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
  // DEBUG: Check database file at ready event start
  const dbCheckAtReady = (() => {
    const dbFile = path.join(os.homedir(), ".config", "natstack", "databases", "natstack-dev", "pubsub-messages.db");
    const exists = fs.existsSync(dbFile);
    console.log(`[READY CHECK] At app.ready start: dbFile exists=${exists}`);
    if (exists) {
      const stats = fs.statSync(dbFile);
      console.log(`[READY CHECK] size=${stats.size}, inode=${stats.ino}, birthTime=${stats.birthtime.toISOString()}`);
    }
  })();

  // DEBUG helper to check db file
  const checkDbFile = (label: string) => {
    const dbFile = path.join(os.homedir(), ".config", "natstack", "databases", "natstack-dev", "pubsub-messages.db");
    const exists = fs.existsSync(dbFile);
    console.log(`[DB CHECK: ${label}] exists=${exists}`);
  };

  // Set up panel protocol handler
  checkDbFile("before setupPanelProtocol");
  setupPanelProtocol();
  setupAboutProtocol();
  checkDbFile("after setupPanelProtocol");

  // Initialize cache manager (shared across all panels)
  const cacheManager = getMainCacheManager();
  checkDbFile("before cacheManager.initialize");
  await cacheManager.initialize();
  checkDbFile("after cacheManager.initialize");

  // Register shell services (available in both modes)
  const dispatcher = getServiceDispatcher();
  dispatcher.register("app", handleAppService);
  dispatcher.register("view", handleViewService);
  dispatcher.register("menu", handleMenuService);
  dispatcher.register("workspace", handleWorkspaceService);
  dispatcher.register("central", handleCentralService);
  dispatcher.register("settings", handleSettingsService);
  dispatcher.register("events", handleEventsService);
  setShellServicesAppMode(appMode);

  // Initialize services only in main mode
  if (appMode === "main" && gitServer && panelManager && workspace) {
    try {
      // Register panel service (requires panel manager)
      dispatcher.register("panel", handlePanelService);
      setShellServicesPanelManager(panelManager);

      checkDbFile("before getServiceDispatcher");
      checkDbFile("after getServiceDispatcher");

      // Start Verdaccio server FIRST (other services may need to install packages)
      try {
        // Use project root (parent of workspace) for finding packages/
        const projectRoot = path.dirname(workspace.path);
        verdaccioServer = createVerdaccioServer({
          workspaceRoot: projectRoot,
          storagePath: path.join(app.getPath("userData"), "verdaccio-storage"),
        });
        const verdaccioPort = await verdaccioServer.start();
        console.log(`[Verdaccio] Registry started on port ${verdaccioPort}`);

        // Publish workspace packages to local registry
        const publishResult = await verdaccioServer.publishWorkspacePackages();
        if (!publishResult.success) {
          console.warn(`[Verdaccio] Some packages failed to publish: ${publishResult.failed.map(f => f.name).join(", ")}`);
        }
      } catch (verdaccioError) {
        console.warn("[Verdaccio] Failed to start (falling back to file: path resolution):", verdaccioError);
        verdaccioServer = null;
      }

      // Start git server
      checkDbFile("before gitServer.start");
      const port = await gitServer.start();
      console.log(`[Git] Server started on port ${port}`);
      checkDbFile("after gitServer.start");

      // Start CDP server for browser automation
      checkDbFile("before cdpServer.start");
      cdpServer = getCdpServer();
      const cdpPort = await cdpServer.start();
      console.log(`[CDP] Server started on port ${cdpPort}`);
      checkDbFile("after cdpServer.start");

      // Start PubSub server for real-time messaging
      // DEBUG: Check right before pubsub server starts
      const dbFileBeforePubsub = path.join(os.homedir(), ".config", "natstack", "databases", "natstack-dev", "pubsub-messages.db");
      console.log(`[BEFORE PUBSUB] dbFile exists=${fs.existsSync(dbFileBeforePubsub)}`);
      if (fs.existsSync(dbFileBeforePubsub)) {
        const stats = fs.statSync(dbFileBeforePubsub);
        console.log(`[BEFORE PUBSUB] size=${stats.size}, inode=${stats.ino}`);
      }

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
              args[1] as string,
              args[2] as string | undefined
            );
          case "getDepsDir":
            return typeCheckRpcMethods["typecheck.getDepsDir"](args[0] as string);
          case "clearCache":
            return typeCheckRpcMethods["typecheck.clearCache"]();
          case "clearPackageCache":
            return typeCheckRpcMethods["typecheck.clearPackageCache"](
              args[0] as string,
              args[1] as string | undefined
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

  const hasResourcesToClean = gitServer || cdpServer || pubsubServer || verdaccioServer;
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

