import { app, BaseWindow, nativeTheme, session } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// Silence Electron security warnings in dev; panels run in isolated webviews.
process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";

import { isDev } from "./utils.js";
import { createDevLogger } from "./devLog.js";

const log = createDevLogger("App");
import { PanelManager, setGlobalPanelManager } from "./panelManager.js";
import { GitServer } from "./gitServer.js";
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
import { getNatstackPackageWatcher, shutdownNatstackWatcher, type NatstackPackageWatcher } from "./natstackPackageWatcher.js";
import { initAgentDiscovery, shutdownAgentDiscovery } from "./agentDiscovery.js";
import { initAgentSettingsService, shutdownAgentSettingsService } from "./agentSettings.js";
import { initAgentHost, shutdownAgentHost, setAgentHostAiHandler } from "./agentHost.js";
import { getTokenManager } from "./tokenManager.js";
import { eventService } from "./services/eventsService.js";
import { getDatabaseManager } from "./db/databaseManager.js";
import { shutdownPackageStore, scheduleGC } from "./package-store/index.js";
import { getDependencyGraph } from "./dependencyGraph.js";
import { handleDbCall } from "./ipc/dbHandlers.js";
import { handleBridgeCall } from "./ipc/bridgeHandlers.js";
import { handleBrowserCall } from "./ipc/browserHandlers.js";
import { handleAiServiceCall } from "./ipc/aiHandlers.js";
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
  setShellServicesAiHandler,
} from "./ipc/shellServices.js";
import { handleEventsService } from "./services/eventsService.js";
import { typeCheckRpcMethods, getTypeDefinitionService } from "./typecheck/service.js";
import { setupTestApi } from "./testApi.js";
import { getAdBlockManager } from "./adblock/index.js";
import { handleAdBlockServiceCall } from "./ipc/adblockHandlers.js";
import { handleAgentSettingsCall } from "./ipc/agentSettingsHandlers.js";
import { preloadNatstackTypesAsync } from "@natstack/typecheck";
import { startMemoryMonitor } from "./memoryMonitor.js";

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
let gitServer: GitServer | null = null;
let gitWatcher: GitWatcher | null = null;
let cdpServer: CdpServer | null = null;
let pubsubServer: PubSubServer | null = null;
let verdaccioServer: VerdaccioServer | null = null;
let natstackWatcher: NatstackPackageWatcher | null = null;
let panelManager: PanelManager | null = null;
let rpcServer: RpcServer | null = null;
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
    log.info(`[Workspace] Loaded: ${workspace.path} (id: ${workspace.config.id})`);

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
log.info(` Starting in ${appMode} mode`);

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

      // Initialize agent discovery (scans agents/ directory and starts file watching)
      await initAgentDiscovery(workspace.path);
      log.info("[AgentDiscovery] Initialized");

      // Initialize agent settings service (syncs with discovery)
      await initAgentSettingsService();
      log.info("[AgentSettingsService] Initialized");

      // Register agentSettings service
      dispatcher.register("agentSettings", async (_ctx, serviceMethod, serviceArgs) => {
        return handleAgentSettingsCall(serviceMethod, serviceArgs as unknown[]);
      });

      // Start Verdaccio server FIRST (other services may need to install packages)
      try {
        // Use app root for finding packages/ (not workspace parent)
        verdaccioServer = createVerdaccioServer({
          workspaceRoot: getAppRoot(),
          storagePath: path.join(app.getPath("userData"), "verdaccio-storage"),
        });
        // Wire up types cache invalidation hook (avoids circular imports in verdaccioServer)
        verdaccioServer.setNatstackPublishHook(() => getTypeDefinitionService().invalidateNatstackTypes());

        // Build all workspace packages before starting the server
        // This handles the "blank slate" case (fresh clone with no dist/ folders)
        // and prevents the cascading lazy-build issue at startup
        await verdaccioServer.buildAllWorkspacePackages();

        const verdaccioPort = await verdaccioServer.start();
        log.info(`[Verdaccio] Registry started on port ${verdaccioPort}`);

        // Sync all workspace packages with Verdaccio on startup
        // This compares expected versions (from git) with actual versions in Verdaccio
        // and republishes any packages that are stale or missing
        const publishResult = await verdaccioServer.publishChangedPackages();
        if (publishResult.changesDetected.changed.length > 0) {
          log.info(`[Verdaccio] Synced ${publishResult.changesDetected.changed.length} packages: ${publishResult.changesDetected.changed.join(", ")}`);
        } else {
          log.info("[Verdaccio] All packages up-to-date");
        }

        // Start NatstackPackageWatcher to watch packages/ for file changes
        // This enables instant iteration on @natstack/* packages without git commits
        natstackWatcher = getNatstackPackageWatcher(getAppRoot());
        await natstackWatcher.initialize((pkgPath, pkgName) =>
          verdaccioServer!.republishPackage(pkgPath, pkgName)
        );
        log.info("[NatstackWatcher] Watching packages/ for file changes");
      } catch (verdaccioError) {
        // Verdaccio is required - log error but continue (panel builds will fail gracefully)
        console.error("[Verdaccio] Failed to start. Panel builds will fail until Verdaccio is running:", verdaccioError);
        verdaccioServer = null;
      }

      // Start git server
      const port = await gitServer.start();
      log.info(`[Git] Server started on port ${port}`);

      // Create GitWatcher to monitor workspace for repo changes
      gitWatcher = createGitWatcher(workspace);
      log.info("[GitWatcher] Started watching workspace for git changes");

      // Subscribe servers to GitWatcher events
      gitServer.subscribeToGitWatcher(gitWatcher);
      if (verdaccioServer) {
        // Pass workspace path so Verdaccio can resolve workspace-relative paths
        // (distinct from workspaceRoot which is for built-in @natstack/* packages)
        await verdaccioServer.subscribeToGitWatcher(gitWatcher, workspace.path);
        // Note: User workspace packages are now published on-demand during panel builds
      }

      // Start CDP server for browser automation
      cdpServer = getCdpServer();
      const cdpPort = await cdpServer.start();
      log.info(`[CDP] Server started on port ${cdpPort}`);

      // Start PubSub server for real-time messaging
      pubsubServer = getPubSubServer();
      const pubsubPort = await pubsubServer.start();
      log.info(`[PubSub] Server started on port ${pubsubPort}`);

      // Initialize AgentHost for spawning agent processes
      const agentHost = initAgentHost({
        workspaceRoot: workspace.path,
        pubsubUrl: `ws://127.0.0.1:${pubsubPort}`,
        messageStore: pubsubServer.getMessageStore(),
        createToken: (instanceId) => getTokenManager().createToken(instanceId, "worker"),
        revokeToken: (instanceId) => getTokenManager().revokeToken(instanceId),
      });
      await agentHost.initialize();
      pubsubServer.setAgentHost(agentHost);
      log.info("[AgentHost] Initialized");

      dispatcher.register("bridge", async (ctx, serviceMethod, serviceArgs) => {
        return handleBridgeCall(panelManager, getCdpServer(), ctx.callerId, serviceMethod, serviceArgs);
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
      setAgentHostAiHandler(aiHandler);

      dispatcher.register("ai", async (ctx, serviceMethod, serviceArgs) => {
        return handleAiServiceCall(aiHandler, serviceMethod, serviceArgs, (handler, options, streamId) => {
          if (!ctx.wsClient) {
            throw new Error("AI streaming requires a WS connection");
          }
          const target = rpcServer!.createWsStreamTarget(ctx.wsClient, streamId);
          handler.startTargetStream(target, options, streamId);
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
          case "check":
            return typeCheckRpcMethods["typecheck.check"](
              args[0] as string,
              args[1] as string | undefined,
              args[2] as string | undefined
            );
          case "getTypeInfo":
            return typeCheckRpcMethods["typecheck.getTypeInfo"](
              args[0] as string,
              args[1] as string,
              args[2] as number,
              args[3] as number,
              args[4] as string | undefined
            );
          case "getCompletions":
            return typeCheckRpcMethods["typecheck.getCompletions"](
              args[0] as string,
              args[1] as string,
              args[2] as number,
              args[3] as number,
              args[4] as string | undefined
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

  // Start RPC server (both modes — shell always connects over WS)
  const { RpcServer: RpcServerClass } = await import("../server/rpcServer.js");
  rpcServer = new RpcServerClass({
    tokenManager: getTokenManager(),
    panelManager: panelManager ?? undefined,
  });
  const rpcPort = await rpcServer.start();
  log.info(`[RPC] Server started on port ${rpcPort}`);

  // Generate shell token
  const shellToken = getTokenManager().getOrCreateShellToken();

  // Wire RPC server into panel manager (if in main mode)
  if (panelManager) {
    panelManager.setRpcServer(rpcServer);
    panelManager.setRpcPort(rpcPort);
  }

  // Create window (shell preload receives WS port + shell token)
  void createWindow({ rpcPort, shellToken });
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

  // Shutdown agent settings service (closes database)
  shutdownAgentSettingsService();

  // Stop agent discovery file watching
  shutdownAgentDiscovery();

  // Shutdown AgentHost FIRST - gives agents time to close pubsub connections
  // before we stop the pubsub server
  shutdownAgentHost();

  // Shutdown NatstackWatcher (saves dirty package state for next startup)
  void shutdownNatstackWatcher();

  const hasResourcesToClean = gitServer || gitWatcher || cdpServer || pubsubServer || verdaccioServer || rpcServer;
  if (hasResourcesToClean) {
    isCleaningUp = true;
    event.preventDefault();

    console.log("[App] Shutting down...");

    // Stop all servers in parallel
    const stopPromises: Promise<void>[] = [];

    if (rpcServer) {
      stopPromises.push(
        rpcServer
          .stop()
          .then(() => console.log("[App] RPC server stopped"))
          .catch((error) => {
            console.error("Error stopping RPC server:", error);
          })
      );
    }

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

    // Flush dependency graph consumer registrations to disk
    stopPromises.push(
      getDependencyGraph()
        .then((graph) => graph.flush())
        .then(() => console.log("[App] Dependency graph flushed"))
        .catch((error) => {
          console.error("[App] Error flushing dependency graph:", error);
        })
    );

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
  if (mainWindow === null && rpcServer) {
    const shellToken = getTokenManager().getOrCreateShellToken();
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
