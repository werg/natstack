import { app, dialog, BaseWindow, nativeTheme, session } from "electron";
import * as path from "path";
import * as fs from "fs";
// Silence Electron security warnings in dev; panels run in isolated webviews.
process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";

import { isDev } from "./utils.js";
import { createDevLogger } from "../shared/devLog.js";

const log = createDevLogger("App");
import { PanelRegistry } from "../shared/panelRegistry.js";
import { PanelLifecycle } from "../shared/panelLifecycle.js";
import { PanelView } from "./panelView.js";
import { setupMenu, setMenuPanelLifecycle, setMenuPanelRegistry, setMenuViewManager, setMenuEventService } from "./menu.js";
import { getAppRoot } from "./paths.js";
import {
  parseCliWorkspacePath,
  discoverWorkspace,
  createWorkspace,
  loadCentralEnv,
} from "../shared/workspace/loader.js";
import type { Workspace } from "../shared/workspace/types.js";
import { CentralDataManager } from "./centralData.js";
import { CdpServer } from "./cdpServer.js";
import { TokenManager } from "../shared/tokenManager.js";
import { EventService } from "../shared/eventsService.js";

const eventService = new EventService();
import { ViewManager } from "./viewManager.js";
import { ServiceDispatcher } from "../shared/serviceDispatcher.js";
import type { RpcServer } from "../server/rpcServer.js";
import { registerElectronServices } from "./electronServiceRegistry.js";
import { setupTestApi } from "./testApi.js";
import { AdBlockManager } from "./adblock/index.js";
import { ContextFolderManager } from "../shared/contextFolderManager.js";
import { FsService } from "../shared/fsService.js";
import { startMemoryMonitor, setMemoryMonitorViewManager } from "./memoryMonitor.js";
import { ServerProcessManager, type ServerPorts } from "./serverProcessManager.js";
import { createServerClient, type ServerClient } from "./serverClient.js";
import type { ServerInfo } from "./serverInfo.js";
import { getPanelPersistence } from "../shared/db/panelPersistence.js";
import { getPanelSearchIndex } from "../shared/db/panelSearchIndex.js";
import { getPanelSource } from "../shared/panelTypes.js";

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

// Workspace is always required — fail fast if not found
if (!hasWorkspaceConfig) {
  console.error(`[Error] Workspace config not found at ${discoveredWorkspacePath}`);
  console.error(`[Error] Expected natstack.yml at: ${configPath}`);
  app.quit();
  process.exit(1);
}

let workspace: Workspace | null = null;
let centralData: CentralDataManager | null = null;
const tokenManager = new TokenManager();
let cdpServer: CdpServer | null = null;
let panelRegistry: PanelRegistry | null = null;
let panelLifecycle: PanelLifecycle | null = null;
let panelView: PanelView | null = null;
let rpcServer: RpcServer | null = null;
let serverProcessManager: ServerProcessManager | null = null;
let serverClient: ServerClient | null = null;
let panelHttpServer: import("../server/panelHttpServer.js").PanelHttpServer | null = null;
let mainWindow: BaseWindow | null = null;
let viewManager: ViewManager | null = null;
let isCleaningUp = false; // Prevent re-entry in will-quit handler

/** Guard — throws controlled error instead of raw TypeError */
function requireServerClient(): ServerClient {
  if (!serverClient) throw new Error("Server not available");
  return serverClient;
}


// =============================================================================
// Main Mode Initialization
// =============================================================================

try {
  workspace = createWorkspace(discoveredWorkspacePath);
  log.info(`[Workspace] Loaded: ${workspace.path} (id: ${workspace.config.id})`);

  // Add to recent workspaces
  centralData = new CentralDataManager();
  centralData.addRecentWorkspace(workspace.path, workspace.config.id);
} catch (error) {
  console.error("[Workspace] Failed to initialize workspace:", error);
  app.quit();
  process.exit(1);
}

log.info(` Starting in main mode`);

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
    call: (service, method, args) =>
      requireServerClient().call(service, method, args),
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
    height: 600,
    show: false,
    titleBarStyle: "hidden",
    ...(process.platform !== "darwin"
      ? {
          titleBarOverlay: true,
        }
      : {}),
  });

  // Initialize ViewManager with shell view (pass WS connection args to shell preload)
  viewManager = new ViewManager({
    window: mainWindow,
    shellPreload: path.join(__dirname, "preload.cjs"),
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

  // Set ViewManager reference in PanelView and PanelLifecycle
  if (panelLifecycle && viewManager && panelView) {
    panelLifecycle.setPanelView(panelView);
  }
  if (cdpServer && viewManager) {
    cdpServer.setViewManager(viewManager);
  }

  // Optional memory diagnostics (env-driven).
  if (viewManager) setMemoryMonitorViewManager(viewManager);
  startMemoryMonitor();

  // Setup application menu (uses shell webContents for menu events)
  if (viewManager) setMenuViewManager(viewManager);
  setupMenu(mainWindow, viewManager.getShellWebContents(), {
    onHistoryBack: () => {
      if (!panelRegistry || !viewManager) return;
      const panelId = panelRegistry.getFocusedPanelId();
      if (!panelId) return;
      const contents = viewManager.getWebContents(panelId);
      if (contents && !contents.isDestroyed() && contents.canGoBack()) {
        contents.goBack();
      }
    },
    onHistoryForward: () => {
      if (!panelRegistry || !viewManager) return;
      const panelId = panelRegistry.getFocusedPanelId();
      if (!panelId) return;
      const contents = viewManager.getWebContents(panelId);
      if (contents && !contents.isDestroyed() && contents.canGoForward()) {
        contents.goForward();
      }
    },
  });

  // Initialize panel tree after window is ready
  if (panelLifecycle) {
    panelLifecycle.initializePanelTree().catch((error) => {
      console.error("[App] Failed to initialize panel tree:", error);
      eventService.emit("panel-initialization-error", {
        path: "",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

// =============================================================================
// App Lifecycle
// =============================================================================

app.on("ready", async () => {
  performance.mark("startup:ready");

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

  const dispatcher = new ServiceDispatcher();

  performance.mark("startup:services-registered");

  try {
    performance.mark("startup:server-spawn-begin");
    // Spawn server as child process
    serverProcessManager = new ServerProcessManager({
      workspacePath: workspace!.path,
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
    log.info(`[Server] Child process started (RPC: ${ports.rpcPort}, Git: ${ports.gitPort}, PubSub: ${ports.pubsubPort})`);

    // Connect to server as admin
    serverClient = await createServerClient(ports.rpcPort, ports.adminToken);
    performance.mark("startup:server-connected");
    log.info("[Server] Admin WS client connected");

    const serverInfo = buildServerInfo(ports);

    // CDP server (Electron-local) — must start before panel services
    cdpServer = new CdpServer(tokenManager);
    if (viewManager) cdpServer.setViewManager(viewManager);
    const cdpPort = await cdpServer.start();
    log.info(`[CDP] Server started on port ${cdpPort}`);

    // Filesystem service — per-context sandboxed fs via RPC
    const contextFolderManager = new ContextFolderManager({
      workspacePath: workspace!.path,
      getWorkspaceTree: () =>
        requireServerClient().call("git", "getWorkspaceTree", []) as Promise<any>,
    });
    const fsService = new FsService(contextFolderManager);

    // Create PanelRegistry (data layer)
    const persistence = getPanelPersistence();
    const searchIndex = getPanelSearchIndex();
    panelRegistry = new PanelRegistry({
      workspace,
      eventService,
      persistence,
      searchIndex,
    });

    // Create PanelLifecycle (orchestration layer)
    panelLifecycle = new PanelLifecycle({
      registry: panelRegistry,
      tokenManager,
      fsService,
      eventService,
      panelsRoot: workspace!.path,
      serverInfo,
      cdpServer,
    });

    // Set up test API for E2E testing (only when NATSTACK_TEST_MODE=1)
    setupTestApi(panelLifecycle, panelRegistry, null);
    setMenuPanelLifecycle(panelLifecycle);
    setMenuPanelRegistry(panelRegistry);
    setMenuEventService(eventService);

    // Register all Electron-main services via registry
    // PanelView is created later after ViewManager exists, but we need a
    // placeholder for the service registry. We'll create PanelView with a
    // deferred viewManager pattern.
    const adBlockManager = new AdBlockManager();

    // We need the RPC server before PanelView (for port), so create RPC first
    const { RpcServer: RpcServerClass } = await import("../server/rpcServer.js");
    rpcServer = new RpcServerClass({
      tokenManager: tokenManager,
      dispatcher,
      panelManager: panelRegistry, // PanelRegistry implements PanelRelationshipProvider
      onClientDisconnect: (callerId, callerKind) => {
        const handleKey = callerKind === "panel" ? callerId : `server:${callerId}`;
        fsService.closeHandlesForPanel(handleKey);
      },
    });
    const rpcPort = await rpcServer.start();
    log.info(`[RPC] Server started on port ${rpcPort}`);

    // Wire sendToClient into PanelLifecycle
    panelLifecycle.setSendToClient((callerId, msg) => rpcServer!.sendToClient(callerId, msg as import("../shared/ws/protocol.js").WsServerMessage));

    // Start PanelHttpServer for HTTP subdomain panel serving in Electron
    const { PanelHttpServer } = await import("../server/panelHttpServer.js");
    const { randomBytes } = await import("crypto");
    panelHttpServer = new PanelHttpServer("127.0.0.1", randomBytes(32).toString("hex"));
    const panelHttpPort = await panelHttpServer.start(0);
    log.info(`[PanelHTTP] Panel HTTP server started on port ${panelHttpPort}`);

    // Wire PanelHttpServer into PanelLifecycle
    panelLifecycle.setPanelHttpServer(panelHttpServer, panelHttpPort);

    // Wire PanelHttpServer callbacks
    panelHttpServer.setCallbacks({
      onDemandCreate: async (source, subdomain) => {
        const panelId = await panelLifecycle!.createPanelOnDemand(source, subdomain);
        const rpcToken = tokenManager.ensureToken(panelId, "panel");
        const serverRpcToken = await serverInfo.ensurePanelToken(panelId, "panel");
        return { panelId, rpcPort, rpcToken, serverRpcPort: serverInfo.rpcPort, serverRpcToken };
      },
      listPanels: () => panelLifecycle!.listPanels(),
      onBuildComplete: (source, error) => {
        // Per-panel fan-out: notify all panels using this source
        const allPanels = panelRegistry!.listPanels();
        for (const entry of allPanels) {
          const panel = panelRegistry!.getPanel(entry.panelId);
          if (panel && getPanelSource(panel) === source) {
            if (error) {
              panelRegistry!.updateArtifacts(entry.panelId, {
                buildState: "error",
                error,
                buildProgress: error,
              });
            } else {
              panelRegistry!.updateArtifacts(entry.panelId, {
                htmlPath: panelLifecycle!.getPanelUrl(entry.panelId) ?? undefined,
                buildState: "ready",
              });
            }
          }
        }
        panelRegistry!.notifyPanelTreeUpdate();
      },
      getBuild: async (source) => {
        return serverInfo.call("build", "getBuild", [source]) as Promise<
          import("../server/buildV2/buildStore.js").BuildResult
        >;
      },
    });

    // Now create PanelView (needs viewManager, which is created in createWindow)
    // PanelView will be created inside createWindow after viewManager exists.
    // For now, register services with a deferred PanelView.

    // We'll create a temporary PanelView placeholder and update it in createWindow.
    // Actually, the services need PanelView at registration time, so let's defer
    // service registration until after createWindow... but that breaks the flow.
    //
    // Better approach: register services now, but PanelView is created inside
    // createWindow. The panelShellService and others reference panelView via
    // a getter pattern. Let's use the same getViewManager pattern.

    // Create a shell PanelView that will be fully initialized in createWindow
    // For now, services that need PanelView will get it lazily.

    // Register all Electron-main services
    // PanelView needs viewManager which doesn't exist yet, so we use a lazy wrapper
    const getPanelView = (): PanelView => {
      if (!panelView) throw new Error("PanelView not initialized yet");
      return panelView;
    };

    registerElectronServices(dispatcher, {
      panelLifecycle,
      panelRegistry,
      // PanelView is created lazily in createWindow. Services that need it
      // (like panelShellService) will call methods on it during handler
      // execution, by which time createWindow has already run.
      get panelView(): PanelView { return getPanelView(); },
      cdpServer,
      fsService,
      eventService,
      serverClient,
      serverInfo,
      getViewManager: () => viewManager!,
      centralData: centralData!,
      adBlockManager,
      workspace,
    });

    dispatcher.markInitialized();

    // Generate shell token and create window
    const shellToken = tokenManager.ensureToken("shell", "shell");
    // createWindow will create ViewManager, PanelView, and initialize panel tree
    void createWindow({ rpcPort, shellToken });

    // Create PanelView now that viewManager exists (set in createWindow)
    if (viewManager) {
      panelView = new PanelView({
        viewManager,
        panelRegistry,
        tokenManager,
        panelHttpServer,
        panelHttpPort,
        rpcPort,
        serverInfo,
        cdpServer,
        panelLifecycle,
        sendToClient: (callerId, msg) => rpcServer!.sendToClient(callerId, msg as import("../shared/ws/protocol.js").WsServerMessage),
      });

      // Wire PanelView into PanelLifecycle
      panelLifecycle.setPanelView(panelView);

      // Register crash handler
      viewManager.onViewCrashed((viewId, reason) => {
        panelView!.handleViewCrashed(viewId, reason);
      });

      // Update test API with PanelView
      setupTestApi(panelLifecycle, panelRegistry, panelView);
    }

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
    if (panelHttpServer) {
      cleanupPromises.push(
        panelHttpServer.stop().catch((e) => console.error("[App] panelHttpServer cleanup error:", e))
      );
      panelHttpServer = null;
    }
    await Promise.all(cleanupPromises);

    dialog.showErrorBox(
      "Startup Failed",
      error instanceof Error ? error.message : String(error)
    );
    app.exit(1);
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
  if (panelRegistry) {
    try {
      panelRegistry.runShutdownCleanup();
    } catch (e) {
      console.error("[App] Failed to run shutdown cleanup:", e);
    }
  }

  const hasResourcesToClean = serverClient || serverProcessManager || rpcServer || cdpServer || panelHttpServer;
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

    if (panelHttpServer) {
      stopPromises.push(
        panelHttpServer
          .stop()
          .then(() => console.log("[App] Panel HTTP server stopped"))
          .catch((e) => console.error("[App] Error stopping panel HTTP server:", e))
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
  if (mainWindow === null && rpcServer) {
    const shellToken = tokenManager.ensureToken("shell", "shell");
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
