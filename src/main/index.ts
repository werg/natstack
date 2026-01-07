import { app, BaseWindow, Menu, nativeTheme, ipcMain, type MenuItemConstructorOptions } from "electron";
import { buildHamburgerMenuTemplate } from "./menu.js";
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
import type { PanelContextMenuAction } from "../shared/ipc/types.js";
import { setupMenu } from "./menu.js";
import { setActiveWorkspace, getBuildArtifactsDirectory } from "./paths.js";
import { getWorkerManager } from "./workerManager.js";
import { registerWorkerHandlers } from "./ipc/workerHandlers.js";
import {
  parseCliWorkspacePath,
  discoverWorkspace,
  createWorkspace,
  loadCentralEnv,
} from "./workspace/loader.js";
import type { Workspace, AppMode } from "./workspace/types.js";
import { setAppMode } from "./ipc/workspaceHandlers.js";
import { getCentralData } from "./centralData.js";
import { registerPanelProtocol, setupPanelProtocol } from "./panelProtocol.js";
import { getMainCacheManager } from "./cacheManager.js";
import { getCdpServer, type CdpServer } from "./cdpServer.js";
import { getPubSubServer, type PubSubServer } from "./pubsubServer.js";
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
import { getServiceDispatcher, parseServiceMethod } from "./serviceDispatcher.js";

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
let panelManager: PanelManager | null = null;
let mainWindow: BaseWindow | null = null;
let viewManager: ViewManager | null = null;
let workerManagerInitialized = false;
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

setAppMode(appMode);
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
    panelPreload: path.join(__dirname, "panelPreload.cjs"),
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
// App IPC Handlers (renderer <-> main) - Always available
// =============================================================================

handle("app:get-info", async () => {
  return { version: app.getVersion() };
});

handle("app:get-system-theme", async () => {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
});

handle("app:set-theme-mode", async (_event, mode: SharedPanel.ThemeMode) => {
  nativeTheme.themeSource = mode;
});

handle("app:open-devtools", async () => {
  if (viewManager) {
    viewManager.openDevTools("shell");
  }
});

handle("app:get-panel-preload-path", async () => {
  return path.join(__dirname, "panelPreload.cjs");
});

handle("app:clear-build-cache", async () => {
  // Clear main-process cache and build artifacts
  const cacheManager = getMainCacheManager();
  await cacheManager.clear();

  // Clear build artifacts
  const artifactsDir = getBuildArtifactsDirectory();
  if (fs.existsSync(artifactsDir)) {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  }

  console.log("[App] Build cache and artifacts cleared");
});

// =============================================================================
// Native Menu IPC Handlers (for menus that need to render above WebContentsViews)
// =============================================================================

handle("menu:show-hamburger", async (_event, position: { x: number; y: number }) => {
  const vm = getViewManager();
  const shellContents = vm.getShellWebContents();

  const clearBuildCache = async () => {
    const cacheManager = getMainCacheManager();
    await cacheManager.clear();
    console.log("[App] Build cache cleared via menu");
  };

  const template = buildHamburgerMenuTemplate(shellContents, clearBuildCache);
  const menu = Menu.buildFromTemplate(template);
  // Use window option so Electron converts content-relative coords to screen coords
  menu.popup({ window: vm.getWindow(), x: position.x, y: position.y });
});

handle(
  "menu:show-context",
  async (
    _event,
    items: Array<{ id: string; label: string }>,
    position: { x: number; y: number }
  ): Promise<string | null> => {
    const vm = getViewManager();
    return new Promise((resolve) => {
      const template: MenuItemConstructorOptions[] = items.map((item) => ({
        label: item.label,
        click: () => resolve(item.id),
      }));

      const menu = Menu.buildFromTemplate(template);
      // Use window option so Electron converts content-relative coords to screen coords
      menu.popup({
        window: vm.getWindow(),
        x: position.x,
        y: position.y,
        callback: () => resolve(null), // User dismissed menu without selecting
      });
    });
  }
);

handle(
  "menu:show-panel-context",
  async (
    _event,
    _panelId: string,
    panelType: string,
    position: { x: number; y: number }
  ): Promise<PanelContextMenuAction | null> => {
    const vm = getViewManager();
    return new Promise((resolve) => {
      const template: MenuItemConstructorOptions[] = [];

      // Reload - only for app and browser panels (workers don't have a view to reload)
      if (panelType === "app" || panelType === "browser") {
        template.push({
          label: "Reload",
          click: () => resolve("reload"),
        });
        template.push({ type: "separator" });
      }

      // Close actions - available for all panel types
      template.push({
        label: "Close",
        click: () => resolve("close"),
      });
      template.push({
        label: "Close Siblings",
        click: () => resolve("close-siblings"),
      });
      template.push({
        label: "Close Subtree",
        click: () => resolve("close-subtree"),
      });

      const menu = Menu.buildFromTemplate(template);
      // Use window option so Electron converts content-relative coords to screen coords
      menu.popup({
        window: vm.getWindow(),
        x: position.x,
        y: position.y,
        callback: () => resolve(null),
      });
    });
  }
);

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

handle("panel:get-tree", async () => {
  return requirePanelManager().getSerializablePanelTree();
});

handle("panel:notify-focus", async (_event, panelId: string) => {
  requirePanelManager().sendPanelEvent(panelId, { type: "focus" });
});

handle("panel:update-theme", async (_event, theme: SharedPanel.ThemeAppearance) => {
  const pm = requirePanelManager();
  pm.setCurrentTheme(theme);
  pm.broadcastTheme(theme);
});

handle("panel:open-devtools", async (_event, panelId: string) => {
  requirePanelManager();
  const vm = getViewManager();
  if (!vm.hasView(panelId)) {
    throw new Error(`No view found for panel ${panelId}`);
  }
  vm.openDevTools(panelId);
});

handle("panel:reload", async (_event, panelId: string) => {
  requirePanelManager();
  const vm = getViewManager();
  if (!vm.hasView(panelId)) {
    throw new Error(`No view found for panel ${panelId}`);
  }
  vm.reload(panelId);
});

handle("panel:close", async (_event, panelId: string) => {
  const pm = requirePanelManager();
  await pm.closePanel(panelId);
});

handle("panel:retry-dirty-build", async (_event, panelId: string) => {
  const pm = requirePanelManager();
  await pm.retryBuild(panelId);
});

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

  const dispatcher = getServiceDispatcher();
  const ctx = { callerId: panelId, callerKind: "panel" as const, webContents: event.sender };

  try {
    const result = await dispatcher.dispatch(ctx, parsedMethod.service, parsedMethod.method, args);
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

// =============================================================================
// View Management IPC Handlers (renderer <-> main)
// =============================================================================

handle(
  "view:set-bounds",
  async (
    _event,
    viewId: string,
    bounds: { x: number; y: number; width: number; height: number }
  ) => {
    const vm = getViewManager();
    vm.setViewBounds(viewId, bounds);
  }
);

handle("view:set-visible", async (_event, viewId: string, visible: boolean) => {
  const vm = getViewManager();
  vm.setViewVisible(viewId, visible);
});

handle(
  "view:set-theme-css",
  async (_event, css: string) => {
    const vm = getViewManager();
    vm.setThemeCss(css);
  }
);

// Browser navigation via ViewManager (for renderer UI controls)
handle("view:browser-navigate", async (_event, browserId: string, url: string) => {
  const vm = getViewManager();
  await vm.navigateView(browserId, url);
});

handle("view:browser-go-back", async (_event, browserId: string) => {
  const vm = getViewManager();
  vm.goBack(browserId);
});

handle("view:browser-go-forward", async (_event, browserId: string) => {
  const vm = getViewManager();
  vm.goForward(browserId);
});

handle("view:browser-reload", async (_event, browserId: string) => {
  const vm = getViewManager();
  vm.reload(browserId);
});

handle("view:browser-stop", async (_event, browserId: string) => {
  const vm = getViewManager();
  vm.stop(browserId);
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
  checkDbFile("after setupPanelProtocol");

  // Initialize cache manager (shared across all panels)
  const cacheManager = getMainCacheManager();
  checkDbFile("before cacheManager.initialize");
  await cacheManager.initialize();
  checkDbFile("after cacheManager.initialize");

  // Initialize services only in main mode
  if (appMode === "main" && gitServer && panelManager && workspace) {
    try {
      checkDbFile("before getServiceDispatcher");
      const dispatcher = getServiceDispatcher();
      checkDbFile("after getServiceDispatcher");

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

      // Initialize WorkerManager (uses getActiveWorkspace() internally)
      getWorkerManager();
      workerManagerInitialized = true;
      registerWorkerHandlers(panelManager);
      console.log("[Workers] Manager initialized");

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

      dispatcher.register("ai", async (ctx, serviceMethod, serviceArgs) => {
        return handleAiServiceCall(aiHandler, serviceMethod, serviceArgs, (handler, options, streamId) => {
          if (ctx.callerKind === "panel") {
            if (!ctx.webContents) {
              throw new Error("Missing webContents for panel AI stream");
            }
            handler.startPanelStream(ctx.webContents, ctx.callerId, options, streamId);
            return;
          }

          void handler.streamTextToWorker(getWorkerManager(), ctx.callerId, generateRequestId(), options, streamId);
        });
      });

      dispatcher.markInitialized();
    } catch (error) {
      console.error("Failed to initialize services:", error);
    }
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

  const hasResourcesToClean = gitServer || cdpServer || pubsubServer || workerManagerInitialized;
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

    // Shutdown worker manager (kills utility process)
    if (workerManagerInitialized) {
      try {
        getWorkerManager().shutdown();
      } catch (error) {
        console.error("Error shutting down worker manager:", error);
      }
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

// Listen for system theme changes and notify renderer
nativeTheme.on("updated", () => {
  if (viewManager) {
    const shellContents = viewManager.getShellWebContents();
    if (!shellContents.isDestroyed()) {
      shellContents.send(
        "system-theme-changed",
        nativeTheme.shouldUseDarkColors ? "dark" : "light"
      );
    }
  }
});

// Import workspace handlers to register them
import "./ipc/workspaceHandlers.js";
