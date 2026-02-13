import { app, dialog, BaseWindow, nativeTheme, session } from "electron";
import * as path from "path";
import * as fs from "fs";
// Silence Electron security warnings in dev; panels run in isolated webviews.
process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";

import { isDev } from "./utils.js";
import { createDevLogger } from "./devLog.js";

const log = createDevLogger("App");
import { PanelManager, setGlobalPanelManager } from "./panelManager.js";
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
import { getTokenManager } from "./tokenManager.js";
import { eventService } from "./services/eventsService.js";
import { handleBridgeCall } from "./ipc/bridgeHandlers.js";
import { handleBrowserCall } from "./ipc/browserHandlers.js";
import {
  initViewManager,
  getViewManager,
  type ViewManager,
} from "./viewManager.js";
import { getServiceDispatcher } from "./serviceDispatcher.js";
import type { RpcServer } from "../server/rpcServer.js";
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
  setShellServicesServerClient,
} from "./ipc/shellServices.js";
import { handleEventsService } from "./services/eventsService.js";
import { setupTestApi } from "./testApi.js";
import { getAdBlockManager } from "./adblock/index.js";
import { handleAdBlockServiceCall } from "./ipc/adblockHandlers.js";
import { startMemoryMonitor } from "./memoryMonitor.js";
import { ServerProcessManager, type ServerPorts } from "./serverProcessManager.js";
import { createServerClient, type ServerClient } from "./serverClient.js";
import { setVerdaccioConfig } from "./verdaccioConfig.js";
import type { ServerInfo } from "./serverInfo.js";

// =============================================================================
// Early Diagnostics (enabled via NATSTACK_DEBUG_PATHS=1)
// =============================================================================

if (process.env["NATSTACK_DEBUG_PATHS"] === "1") {
  console.log("=".repeat(60));
  console.log("[diagnostics] NatStack startup diagnostics");
  console.log("[diagnostics] process.platform:", process.platform);
  console.log("[diagnostics] process.arch:", process.arch);
  console.log("[diagnostics] process.cwd():", process.cwd());
  console.log("[diagnostics] process.execPath:", process.execPath);
  console.log("[diagnostics] app.getAppPath():", app.getAppPath());
  console.log("[diagnostics] app.getPath('userData'):", app.getPath("userData"));
  console.log("[diagnostics] NODE_ENV:", process.env["NODE_ENV"]);
  console.log("[diagnostics] isDev():", isDev());
  console.log("[diagnostics] getAppRoot():", getAppRoot());
  console.log("=".repeat(60));
}

// =============================================================================
// GPU/Compositor Flags (optional, must happen before app ready)
// =============================================================================

// If WebContentsViews become transparent after extended idle periods (compositor stalls),
// try enabling these flags. The 3-second keepalive in ViewManager should handle this,
// but these are a more aggressive fallback if needed.
// app.commandLine.appendSwitch("disable-renderer-backgrounding");
// app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

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
let cdpServer: CdpServer | null = null;
let panelManager: PanelManager | null = null;
let rpcServer: RpcServer | null = null;
let serverProcessManager: ServerProcessManager | null = null;
let serverClient: ServerClient | null = null;
let serverInfo: ServerInfo | null = null;
let mainWindow: BaseWindow | null = null;
let viewManager: ViewManager | null = null;
let isCleaningUp = false; // Prevent re-entry in will-quit handler

/** Guard — throws controlled error instead of raw TypeError */
function requireServerClient(): ServerClient {
  if (!serverClient) throw new Error("Server not available");
  return serverClient;
}

/** Get the current ServerInfo (null in chooser mode or before server init) */
export function getServerInfo(): ServerInfo | null {
  return serverInfo;
}

// =============================================================================
// Main Mode Initialization
// =============================================================================

if (appMode === "main" && hasWorkspaceConfig) {
  try {
    workspace = createWorkspace(discoveredWorkspacePath);
    setActiveWorkspace(workspace);
    log.info(`[Workspace] Loaded: ${workspace.path} (id: ${workspace.config.id})`);

    // Add to recent workspaces
    const centralData = getCentralData();
    centralData.addRecentWorkspace(workspace.path, workspace.config.id);
  } catch (error) {
    console.error(
      "[Workspace] Failed to initialize workspace, falling back to chooser mode:",
      error
    );
    appMode = "chooser";
  }
}

setShellServicesAppMode(appMode);
log.info(` Starting in ${appMode} mode`);

// =============================================================================
// ServerInfo Builder
// =============================================================================

function buildServerInfo(ports: ServerPorts): ServerInfo {
  return {
    rpcPort: ports.rpcPort,
    gitBaseUrl: `http://127.0.0.1:${ports.gitPort}`,
    pubsubUrl: `ws://127.0.0.1:${ports.pubsubPort}`,
    createPanelToken: (panelId, kind) =>
      requireServerClient().call("tokens", "create", [panelId, kind]) as Promise<string>,
    ensurePanelToken: (panelId, kind) =>
      requireServerClient().call("tokens", "ensure", [panelId, kind]) as Promise<string>,
    revokePanelToken: (panelId) =>
      requireServerClient().call("tokens", "revoke", [panelId]) as Promise<void>,
    getPanelToken: (panelId) =>
      requireServerClient().call("tokens", "get", [panelId]) as Promise<string | null>,
    getGitTokenForPanel: (panelId) =>
      requireServerClient().call("git", "getTokenForPanel", [panelId]) as Promise<string>,
    revokeGitToken: (panelId) =>
      requireServerClient().call("git", "revokeTokenForPanel", [panelId]) as Promise<void>,
    getWorkspaceTree: () =>
      requireServerClient().call("git", "getWorkspaceTree", []),
    listBranches: (repoPath) =>
      requireServerClient().call("git", "listBranches", [repoPath]),
    listCommits: (repoPath, ref, limit) =>
      requireServerClient().call("git", "listCommits", [repoPath, ref, limit]),
    resolveRef: (repoPath, ref) =>
      requireServerClient().call("git", "resolveRef", [repoPath, ref]) as Promise<string>,
    listAgents: () =>
      requireServerClient().call("agentSettings", "listAgents", []),
  };
}

// =============================================================================
// Window Creation
// =============================================================================

function createWindow(wsArgs: { rpcPort: number; shellToken: string }): void {
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

  // Initialize ViewManager with shell view (pass WS connection args to shell preload)
  viewManager = initViewManager({
    window: mainWindow,
    shellPreload: path.join(__dirname, "preload.cjs"),
    safePreload: path.join(__dirname, "safePreload.cjs"),
    shellHtmlPath: path.join(__dirname, "index.html"),
    shellAdditionalArguments: [
      `--natstack-ws-port=${wsArgs.rpcPort}`,
      `--natstack-shell-token=${wsArgs.shellToken}`,
    ],
    devTools: false,
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
  // Guard callbacks: panelManager is null in chooser mode — early return instead of throwing.
  setupMenu(mainWindow, viewManager.getShellWebContents(), {
    onHistoryBack: () => {
      if (!panelManager) return;
      const panelId = panelManager.getFocusedPanelId();
      if (!panelId || !panelManager.getPanel(panelId)) return;
      void panelManager.goBack(panelId).catch((error) => {
        console.error(`[Menu] Failed to navigate back for ${panelId}:`, error);
      });
    },
    onHistoryForward: () => {
      if (!panelManager) return;
      const panelId = panelManager.getFocusedPanelId();
      if (!panelId || !panelManager.getPanel(panelId)) return;
      void panelManager.goForward(panelId).catch((error) => {
        console.error(`[Menu] Failed to navigate forward for ${panelId}:`, error);
      });
    },
  });
}

// Helper to ensure we're in main mode with panel manager
function requirePanelManager(): PanelManager {
  if (!panelManager) {
    throw new Error("Panel operations not available in workspace chooser mode");
  }
  return panelManager;
}

// =============================================================================
// App Lifecycle
// =============================================================================

app.on("ready", async () => {
  performance.mark("startup:ready");

  // Set up panel protocol handler
  setupPanelProtocol();
  setupAboutProtocol();

  // Auto-update check (production only)
  if (!isDev()) {
    try {
      // Dynamic import to avoid bundling electron-updater in development
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { autoUpdater } = require("electron-updater") as {
        autoUpdater: {
          logger: unknown;
          autoDownload: boolean;
          autoInstallOnAppQuit: boolean;
          on: (event: string, callback: (info: { version?: string; message?: string }) => void) => void;
          checkForUpdates: () => Promise<unknown>;
        };
      };

      autoUpdater.logger = {
        info: (msg: string) => console.log(`[AutoUpdater] ${msg}`),
        warn: (msg: string) => console.warn(`[AutoUpdater] ${msg}`),
        error: (msg: string) => console.error(`[AutoUpdater] ${msg}`),
        debug: (msg: string) => console.log(`[AutoUpdater:debug] ${msg}`),
      };
      autoUpdater.autoDownload = false; // Don't auto-download, let user decide
      autoUpdater.autoInstallOnAppQuit = true;

      autoUpdater.on("update-available", (info: { version?: string }) => {
        console.log(`[AutoUpdater] Update available: ${info.version}`);
      });

      autoUpdater.on("update-downloaded", (info: { version?: string }) => {
        console.log(`[AutoUpdater] Update downloaded: ${info.version}`);
      });

      autoUpdater.on("error", (error: { message?: string }) => {
        console.warn(`[AutoUpdater] Error: ${error.message}`);
      });

      // Check for updates (non-blocking)
      autoUpdater.checkForUpdates().catch((err: Error) => {
        console.warn(`[AutoUpdater] Failed to check for updates: ${err.message}`);
      });
    } catch {
      // electron-updater not available or failed to load - this is fine in development
      console.log("[AutoUpdater] Not available (this is normal in development)");
    }
  }

  // Start cache manager initialization in the background (non-blocking).
  // get()/set() work immediately; disk entries merge when ready.
  const cacheManager = getMainCacheManager();
  cacheManager.startInitialize();

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

  performance.mark("startup:services-registered");

  // Initialize services only in main mode
  if (appMode === "main" && workspace) {
    try {
      performance.mark("startup:server-spawn-begin");
      // Spawn server as child process
      serverProcessManager = new ServerProcessManager({
        workspacePath: workspace.path,
        appRoot: getAppRoot(),
        onCrash: (code) => {
          console.error(`[App] Server process crashed with code ${code}`);
          dialog.showErrorBox(
            "Server Process Crashed",
            "The NatStack server process exited unexpectedly. The app will now restart."
          );
          app.relaunch();
          app.exit(1);
        },
      });

      const ports = await serverProcessManager.start();
      performance.mark("startup:server-spawned");
      log.info(`[Server] Child process started (RPC: ${ports.rpcPort}, Verdaccio: ${ports.verdaccioPort}, Git: ${ports.gitPort}, PubSub: ${ports.pubsubPort})`);

      // Connect to server as admin
      serverClient = await createServerClient(ports.rpcPort, ports.adminToken);
      performance.mark("startup:server-connected");
      log.info("[Server] Admin WS client connected");

      // Configure verdaccio URL for build pipeline
      setVerdaccioConfig({
        url: `http://127.0.0.1:${ports.verdaccioPort}`,
        getPackageVersion: (name) =>
          requireServerClient().call("verdaccio", "getPackageVersion", [name]) as Promise<string | null>,
      });

      // Wire shell services
      setShellServicesServerClient(serverClient);

      // Create panel manager with server info
      serverInfo = buildServerInfo(ports);
      panelManager = new PanelManager(serverInfo);
      setGlobalPanelManager(panelManager);

      // Set up test API for E2E testing (only when NATSTACK_TEST_MODE=1)
      setupTestApi(panelManager);

      // Electron-only registrations
      dispatcher.register("panel", handlePanelService);
      setShellServicesPanelManager(panelManager);

      // CDP server (Electron-local)
      cdpServer = getCdpServer();
      const cdpPort = await cdpServer.start();
      log.info(`[CDP] Server started on port ${cdpPort}`);

      dispatcher.register("bridge", async (ctx, serviceMethod, serviceArgs) => {
        return handleBridgeCall(panelManager!, getCdpServer(), ctx.callerId, serviceMethod, serviceArgs);
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

      dispatcher.markInitialized();

      const { RpcServer: RpcServerClass } = await import("../server/rpcServer.js");
      rpcServer = new RpcServerClass({
        tokenManager: getTokenManager(),
        panelManager: panelManager ?? undefined,
      });
      const rpcPort = await rpcServer.start();
      log.info(`[RPC] Server started on port ${rpcPort}`);

      // Wire RPC server into panel manager
      panelManager.setRpcServer(rpcServer);
      panelManager.setRpcPort(rpcPort);

      // Generate shell token and create window
      const shellToken = getTokenManager().ensureToken("shell", "shell");
      void createWindow({ rpcPort, shellToken });
      performance.mark("startup:window-created");

      // Log startup timing in dev mode
      if (isDev()) {
        performance.measure("startup:total", "startup:ready", "startup:window-created");
        performance.measure("startup:server-spawn", "startup:server-spawn-begin", "startup:server-spawned");
        performance.measure("startup:server-connect", "startup:server-spawned", "startup:server-connected");
        performance.measure("startup:post-connect", "startup:server-connected", "startup:window-created");
        const entries = performance.getEntriesByType("measure").filter((e) => e.name.startsWith("startup:"));
        for (const entry of entries) {
          console.log(`[Perf] ${entry.name}: ${Math.round(entry.duration)}ms`);
        }
      }

      // Defer ad-block initialization (non-critical, ~500-1000ms).
      // The onBeforeRequest handler has a !this.engine fast path that passes requests through.
      setTimeout(async () => {
        try {
          const adBlockManager = getAdBlockManager();
          await adBlockManager.initialize();
          adBlockManager.enableForSession(session.defaultSession);
          console.log("[AdBlock] Initialized and enabled for default session");
        } catch (error) {
          console.warn("[AdBlock] Failed to initialize (non-fatal):", error);
        }
      }, 100);
    } catch (error) {
      console.error("[App] Startup failed:", error);

      // Fail-fast: clean up all partial state, show error, and exit.
      // Await each cleanup to avoid orphaned child processes or leaked ports.
      const cleanupPromises: Promise<void>[] = [];

      if (serverClient) {
        cleanupPromises.push(
          serverClient.close().catch((e) => console.error("[App] serverClient cleanup error:", e))
        );
        serverClient = null;
      }
      if (serverProcessManager) {
        cleanupPromises.push(
          serverProcessManager.shutdown().catch((e) => console.error("[App] serverProcess cleanup error:", e))
        );
        serverProcessManager = null;
      }
      if (rpcServer) {
        cleanupPromises.push(
          rpcServer.stop().catch((e) => console.error("[App] rpcServer cleanup error:", e))
        );
        rpcServer = null;
      }
      if (cdpServer) {
        cleanupPromises.push(
          cdpServer.stop().catch((e) => console.error("[App] cdpServer cleanup error:", e))
        );
        cdpServer = null;
      }
      serverInfo = null;

      // Reset shell service refs
      setShellServicesServerClient(null);
      setShellServicesPanelManager(null);

      await Promise.all(cleanupPromises);

      dialog.showErrorBox(
        "Startup Failed",
        error instanceof Error ? error.message : String(error)
      );
      app.exit(1);
    }
  } else {
    // Chooser mode
    try {
      dispatcher.markInitialized();

      const { RpcServer: RpcServerClass } = await import("../server/rpcServer.js");
      rpcServer = new RpcServerClass({
        tokenManager: getTokenManager(),
      });
      const rpcPort = await rpcServer.start();
      log.info(`[RPC] Server started on port ${rpcPort}`);

      const shellToken = getTokenManager().ensureToken("shell", "shell");
      void createWindow({ rpcPort, shellToken });
    } catch (error) {
      console.error("[App] Chooser startup failed:", error);

      if (rpcServer) {
        await rpcServer.stop().catch((e) => console.error("[App] rpcServer cleanup error:", e));
        rpcServer = null;
      }

      dialog.showErrorBox(
        "Startup Failed",
        error instanceof Error ? error.message : String(error)
      );
      app.exit(1);
    }
  }
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

  const hasResourcesToClean = serverClient || serverProcessManager || rpcServer || cdpServer;
  if (hasResourcesToClean) {
    isCleaningUp = true;
    event.preventDefault();

    console.log("[App] Shutting down...");

    const stopPromises: Promise<void>[] = [];

    // Server client (WS admin connection)
    if (serverClient) {
      stopPromises.push(
        serverClient.close().catch((e) => console.error("[App] Server client close error:", e))
      );
      serverClient = null;
    }

    // Server process (sends shutdown IPC, waits for exit)
    if (serverProcessManager) {
      stopPromises.push(
        serverProcessManager
          .shutdown()
          .then(() => console.log("[App] Server process stopped"))
          .catch((e) => console.error("[App] Server process shutdown error:", e))
      );
    }

    // Electron-local servers
    if (rpcServer) {
      stopPromises.push(
        rpcServer
          .stop()
          .then(() => console.log("[App] RPC server stopped"))
          .catch((e) => console.error("[App] Error stopping RPC server:", e))
      );
    }

    if (cdpServer) {
      stopPromises.push(
        cdpServer
          .stop()
          .then(() => console.log("[App] CDP server stopped"))
          .catch((e) => console.error("[App] Error stopping CDP server:", e))
      );
    }

    // No more: dependency graph flush, package store shutdown (server handles these)

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
  if (mainWindow === null && rpcServer) {
    const shellToken = getTokenManager().ensureToken("shell", "shell");
    const rpcPort = rpcServer.getPort();
    if (rpcPort) {
      void createWindow({ rpcPort, shellToken });
    }
  }
});

// Listen for system theme changes and notify subscribers
nativeTheme.on("updated", () => {
  eventService.emit(
    "system-theme-changed",
    nativeTheme.shouldUseDarkColors ? "dark" : "light"
  );
});
