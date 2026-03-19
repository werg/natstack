import { app, dialog, BaseWindow, nativeTheme, session } from "electron";
import * as path from "path";
import * as fs from "fs";
// Silence Electron security warnings in dev; panels run in isolated webviews.
process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";

import { isDev } from "./utils.js";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("App");
import { PanelRegistry } from "../shared/panelRegistry.js";
import { PanelLifecycle } from "../shared/panelLifecycle.js";
import { PanelView } from "./panelView.js";
import { setupMenu, setMenuPanelLifecycle, setMenuPanelRegistry, setMenuViewManager, setMenuEventService } from "./menu.js";
import { getAppRoot, getWorkspaceTemplateDir } from "./paths.js";
import {
  resolveWorkspaceName,
  initWorkspace,
  createWorkspace,
  loadCentralEnv,
} from "../shared/workspace/loader.js";
import { getWorkspaceDir } from "@natstack/env-paths";
import type { Workspace } from "../shared/workspace/types.js";
import { CentralDataManager } from "./centralData.js";
import { CdpServer } from "./cdpServer.js";
import { TokenManager } from "../shared/tokenManager.js";
import { EventService } from "../shared/eventsService.js";

const eventService = new EventService();
import { ViewManager } from "./viewManager.js";
import { ServiceDispatcher } from "../shared/serviceDispatcher.js";
// RpcServer type: inline import("...") used intentionally — main/ constructs
// server objects via dynamic import at runtime; inline types are acceptable
// in entry points per the boundary rule (no static module-level imports).
import { z } from "zod";
import { ServiceContainer } from "../shared/serviceContainer.js";
import { rpcService } from "../shared/managedService.js";
import { createEventsServiceDefinition } from "../shared/eventsService.js";
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

// Resolve workspace: --workspace=name → env NATSTACK_WORKSPACE → last-opened → auto-create "default"
const wsName = resolveWorkspaceName();
const centralData = new CentralDataManager();
let wsDir: string;

if (wsName) {
  // Managed workspace by name — must exist on disk
  const dir = getWorkspaceDir(wsName);
  if (!fs.existsSync(path.join(dir, "source", "natstack.yml"))) {
    console.error(`[Error] Workspace "${wsName}" does not exist.`);
    app.quit();
    process.exit(1);
  }
  wsDir = dir;
  if (!centralData.hasWorkspace(wsName)) {
    centralData.addWorkspace(wsName);
  } else {
    centralData.touchWorkspace(wsName);
  }
} else {
  // No explicit workspace — try last-opened from registry
  const last = centralData.getLastOpenedWorkspace();
  if (last) {
    wsDir = getWorkspaceDir(last.name);
    centralData.touchWorkspace(last.name);
  } else {
    // First run: auto-create "default" workspace from the shipped template
    const defaultName = "default";
    const defaultDir = getWorkspaceDir(defaultName);
    try {
      if (!fs.existsSync(path.join(defaultDir, "source", "natstack.yml"))) {
        // Clean up partial directory from a previously interrupted create
        if (fs.existsSync(defaultDir)) {
          fs.rmSync(defaultDir, { recursive: true, force: true });
        }
        const templateDir = getWorkspaceTemplateDir();
        initWorkspace(defaultName, templateDir ? { templateDir, devLink: isDev() } : undefined);
        log.info(`[Workspace] Auto-created "default" workspace${templateDir ? " from template" : ""}`);
      }
      centralData.addWorkspace(defaultName);
      wsDir = defaultDir;
    } catch (error) {
      console.error("[Workspace] Failed to auto-create default workspace:", error);
      app.quit();
      process.exit(1);
    }
  }
}

// Set Electron's userData to the workspace state dir — all internal storage scoped here
app.setPath("userData", path.join(wsDir, "state"));

let workspace: Workspace | null = null;
const tokenManager = new TokenManager();
let cdpServer: CdpServer | null = null;
let panelRegistry: PanelRegistry | null = null;
let panelLifecycle: PanelLifecycle | null = null;
let panelView: PanelView | null = null;
let rpcServer: import("../server/rpcServer.js").RpcServer | null = null;
let serverProcessManager: ServerProcessManager | null = null;
let serverClient: ServerClient | null = null;
let serverInfo: ServerInfo | null = null;
let panelHttpServer: import("../server/panelHttpServer.js").PanelHttpServer | null = null;
let mainWindow: BaseWindow | null = null;
let viewManager: ViewManager | null = null;
let isCleaningUp = false; // Prevent re-entry in will-quit handler
let autofillManager: import("./autofill/autofillManager.js").AutofillManager | null = null;

/** Guard — throws controlled error instead of raw TypeError */
function requireServerClient(): ServerClient {
  if (!serverClient) throw new Error("Server not available");
  return serverClient;
}

// =============================================================================
// Main Mode Initialization
// =============================================================================

try {
  workspace = createWorkspace(wsDir);
  log.info(`[Workspace] Loaded: ${workspace.path} (id: ${workspace.config.id})`);
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
    workerdPort: ports.workerdPort ?? 0,
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

  // Set native window title for OS taskbar / window switcher (Alt+Tab / dock)
  if (workspace) {
    mainWindow.setTitle(`NatStack — ${workspace.config.id}`);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
    viewManager = null;
    panelView = null;  // Clear so getPanelView() returns null until recreated
  });

  // PanelView is resolved lazily by PanelLifecycle via getPanelView()
  if (cdpServer && viewManager) {
    cdpServer.setViewManager(viewManager);
  }

  if (viewManager && panelRegistry && panelLifecycle && panelHttpServer && cdpServer && serverInfo && rpcServer) {
    panelView = new PanelView({
      viewManager,
      panelRegistry,
      tokenManager,
      panelHttpServer,
      panelHttpPort: panelHttpServer.getPort(),
      rpcPort: wsArgs.rpcPort,
      serverInfo,
      cdpServer,
      panelLifecycle,
      sourceRoot: workspace!.path,
      sendToClient: (callerId, msg) => rpcServer!.sendToClient(callerId, msg as import("../shared/ws/protocol.js").WsServerMessage),
      autofillManager: autofillManager ?? undefined,
      autofillPreloadPath: path.join(__dirname, "autofillPreload.cjs"),
    });

    // Wire autofill overlay to window, z-order changes, and panel switches
    if (autofillManager && mainWindow && viewManager) {
      autofillManager.setWindow(mainWindow);
      viewManager.onViewOrderChanged(() => autofillManager?.onViewOrderChanged());
      viewManager.onViewHidden((viewId) => autofillManager?.onPanelHidden(viewId));
    }

    viewManager.onViewCrashed((viewId, reason) => {
      panelView!.handleViewCrashed(viewId, reason);
    });

    setupTestApi(panelLifecycle, panelRegistry, panelView);
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
      statePath: workspace!.statePath,
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

    serverInfo = buildServerInfo(ports);

    // CDP server (Electron-local) — must start before panel services
    cdpServer = new CdpServer(tokenManager);
    if (viewManager) cdpServer.setViewManager(viewManager);
    const cdpPort = await cdpServer.start();
    log.info(`[CDP] Server started on port ${cdpPort}`);

    // Filesystem service — per-context sandboxed fs via RPC
    const contextFolderManager = new ContextFolderManager({
      sourcePath: workspace!.path,
      contextsRoot: workspace!.contextsPath,
      getWorkspaceTree: () =>
        requireServerClient().call("git", "getWorkspaceTree", []) as Promise<any>,
    });
    const fsService = new FsService(contextFolderManager);

    // Create PanelRegistry (data layer)
    const persistence = getPanelPersistence(workspace);
    const searchIndex = getPanelSearchIndex();
    panelRegistry = new PanelRegistry({
      workspace,
      eventService,
      persistence,
      searchIndex,
    });

    // Create RpcServer (needed by PanelLifecycle for sendToClient)
    const { RpcServer: RpcServerClass } = await import("../server/rpcServer.js");
    rpcServer = new RpcServerClass({
      tokenManager: tokenManager,
      dispatcher,
      panelManager: panelRegistry, // PanelRegistry implements PanelRelationshipProvider
      onClientDisconnect: (callerId, callerKind) => {
        const handleKey = callerKind === "panel" || callerKind === "worker" ? callerId : `server:${callerId}`;
        fsService.closeHandlesForCaller(handleKey);
      },
    });
    const rpcPort = await rpcServer.start();
    log.info(`[RPC] Server started on port ${rpcPort}`);

    // Create PanelHttpServer (needed by PanelLifecycle for build state)
    const { PanelHttpServer } = await import("../server/panelHttpServer.js");
    const { randomBytes } = await import("crypto");
    panelHttpServer = new PanelHttpServer("127.0.0.1", randomBytes(32).toString("hex"));
    const panelHttpPort = await panelHttpServer.start(0);
    log.info(`[PanelHTTP] Panel HTTP server started on port ${panelHttpPort}`);

    // Create PanelLifecycle (orchestration layer) — fully initialized at construction
    // getPanelView resolves lazily: PanelView is created after createWindow()
    panelLifecycle = new PanelLifecycle({
      registry: panelRegistry,
      tokenManager,
      fsService,
      eventService,
      panelsRoot: workspace!.path,
      serverInfo,
      cdpServer,
      getPanelView: () => panelView,
      panelHttpServer,
      panelHttpPort,
      sendToClient: (callerId, msg) => rpcServer!.sendToClient(callerId, msg as import("../shared/ws/protocol.js").WsServerMessage),
    });

    // Set up test API for E2E testing (only when NATSTACK_TEST_MODE=1)
    setupTestApi(panelLifecycle, panelRegistry, null);
    setMenuPanelLifecycle(panelLifecycle);
    setMenuPanelRegistry(panelRegistry);
    setMenuEventService(eventService);

    const adBlockManager = new AdBlockManager();

    // Autofill manager — password auto-fill for browser panels
    const { AutofillManager } = await import("./autofill/autofillManager.js");

    // Wire PanelHttpServer callbacks
    panelHttpServer.setCallbacks({
      onDemandCreate: async (source, subdomain) => {
        const panelId = await panelLifecycle!.createPanelOnDemand(source, subdomain);
        const rpcToken = tokenManager.ensureToken(panelId, "panel");
        const serverRpcToken = await serverInfo!.ensurePanelToken(panelId, "panel");
        return { panelId, rpcPort, rpcToken, serverRpcPort: serverInfo!.rpcPort, serverRpcToken };
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
        return serverInfo!.call("build", "getBuild", [source]) as Promise<
          import("../server/buildV2/buildStore.js").BuildResult
        >;
      },
    });

    // Register all Electron-main RPC services via ServiceContainer
    // PanelView needs viewManager which doesn't exist yet, so we use a lazy wrapper
    const getPanelView = (): PanelView => {
      if (!panelView) throw new Error("PanelView not initialized yet");
      return panelView;
    };
    const getViewManager = () => viewManager!;

    const { createAppService } = await import("./services/appService.js");
    const { createPanelShellService } = await import("./services/panelShellService.js");
    const { createViewService } = await import("./services/viewService.js");
    const { createMenuService } = await import("./services/menuService.js");
    const { createWorkspaceService } = await import("./services/workspaceService.js");
    const { createSettingsService } = await import("./services/settingsService.js");
    const { createAdblockService } = await import("./services/adblockService.js");
    const { createBridgeService } = await import("./services/bridgeService.js");
    const { createBrowserService } = await import("./services/browserService.js");
    const { createFsServiceDefinition } = await import("./services/fsServiceDef.js");
    const { createGitLocalService } = await import("./services/gitLocalService.js");
    const { createBrowserDataService } = await import("./services/browserDataService.js");
    const { BrowserDataStore } = await import("@natstack/browser-data");
    const { getCentralConfigDirectory } = await import("./paths.js");

    const electronContainer = new ServiceContainer(dispatcher);

    // Shell-only services
    electronContainer.register(rpcService(createAppService({
      panelLifecycle, serverClient, getViewManager,
    })));
    electronContainer.register(rpcService(createPanelShellService({
      panelLifecycle, panelRegistry,
      get panelView(): PanelView { return getPanelView(); },
      getViewManager,
    })));
    electronContainer.register(rpcService(createViewService({ getViewManager })));
    electronContainer.register(rpcService(createMenuService({
      panelLifecycle, panelRegistry, getViewManager, serverClient,
    })));
    // Workspace config manager for atomic config reads/writes
    const { createWorkspaceConfigManager } = await import("./workspaceOps.js");
    const wsConfigPath = path.join(workspace!.path, "natstack.yml");
    const wsConfigManager = createWorkspaceConfigManager(wsConfigPath, workspace!.config);
    electronContainer.register(rpcService(createWorkspaceService({
      centralData,
      activeWorkspaceName: workspace!.config.id,
      getWorkspaceConfig: wsConfigManager.get,
      setWorkspaceConfigField: wsConfigManager.set,
    })));
    electronContainer.register(rpcService(createSettingsService({ serverClient })));
    electronContainer.register(rpcService(createAdblockService({ adBlockManager })));

    // Locally-hosted services
    electronContainer.register(rpcService(createBridgeService({
      panelLifecycle, cdpServer, getViewManager, workspace, serverInfo,
    })));
    electronContainer.register(rpcService(createBrowserService({
      cdpServer, getViewManager, panelRegistry,
    })));
    electronContainer.register(rpcService(createFsServiceDefinition({ fsService })));
    electronContainer.register(rpcService(createGitLocalService()));
    {
      let browserDataStore: InstanceType<typeof BrowserDataStore>;
      electronContainer.register({
        name: "browser-data",
        async start() {
          browserDataStore = new BrowserDataStore(getCentralConfigDirectory());

          // Initialize autofill manager with password store
          autofillManager = new AutofillManager({
            passwordStore: browserDataStore.passwords,
            eventService,
            getViewManager: () => viewManager!,
            autofillOverlayPreloadPath: path.join(__dirname, "autofillOverlayPreload.cjs"),
          });

          return browserDataStore;
        },
        async stop(store: InstanceType<typeof BrowserDataStore>) {
          if (autofillManager) {
            autofillManager.destroy();
            autofillManager = null;
          }
          store.close();
        },
        getServiceDefinition() {
          return createBrowserDataService({ eventService, browserDataStore });
        },
      });
    }

    // Register autofill service (uses lazy resolution since autofillManager is created in browser-data start)
    electronContainer.register(rpcService({
      name: "autofill",
      description: "Password autofill management",
      policy: { allowed: ["shell"] },
      methods: {
        confirmSave: {
          args: z.tuple([z.string(), z.enum(["save", "never", "dismiss"])]),
        },
      },
      handler: async (_ctx, method, args) => {
        if (!autofillManager) throw new Error("Autofill not initialized");
        const def = autofillManager.getServiceDefinition();
        return def.handler(_ctx, method, args);
      },
    }));
    electronContainer.register(rpcService(createEventsServiceDefinition(eventService)));

    await electronContainer.startAll();

    dispatcher.markInitialized();

    // Generate shell token and create window
    const shellToken = tokenManager.ensureToken("shell", "shell");
    // createWindow will create ViewManager, PanelView, and initialize panel tree
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
