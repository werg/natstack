import { app, dialog, BaseWindow, nativeTheme, session, ipcMain, type Session } from "electron";
import * as path from "path";
import * as fs from "fs";
// Silence Electron security warnings in dev; panels run in isolated webviews.
process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";

import { isDev } from "./utils.js";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("App");
import { PanelRegistry } from "@natstack/shared/panelRegistry";
import { PanelOrchestrator } from "./panelOrchestrator.js";
import { PanelView } from "./panelView.js";
import { setupMenu, setMenuPanelLifecycle, setMenuPanelRegistry, setMenuViewManager, setMenuEventService } from "./menu.js";
import { getAppRoot } from "./paths.js";
import {
  loadCentralEnv,
  deleteWorkspaceDir,
} from "@natstack/shared/workspace/loader";
import { CentralDataManager } from "@natstack/shared/centralData";
import { resolveStartupMode, getRemoteUserDataDir, type StartupMode } from "./startupMode.js";
import { establishServerSession, type SessionConnection } from "./serverSession.js";
import { CdpServer } from "./cdpServer.js";
import { TokenManager } from "@natstack/shared/tokenManager";
import { EventService } from "@natstack/shared/eventsService";
import { isValidEventName, type EventName } from "@natstack/shared/events";
import { pemFileFingerprint, pemFingerprint } from "./tlsPinning.js";

const eventService = new EventService();
import { ViewManager } from "./viewManager.js";
import { ServiceDispatcher, parseServiceMethod } from "@natstack/shared/serviceDispatcher";
// RpcServer type: inline import("...") used intentionally — main/ constructs
// server objects via dynamic import at runtime; inline types are acceptable
// in entry points per the boundary rule (no static module-level imports).
import { z } from "zod";
import { ServiceContainer } from "@natstack/shared/serviceContainer";
import { rpcService } from "@natstack/shared/managedService";
import { createEventsServiceDefinition } from "@natstack/shared/eventsService";
import { setupTestApi } from "./testApi.js";
import { AdBlockManager } from "./adblock/index.js";
import { startMemoryMonitor, setMemoryMonitorViewManager } from "./memoryMonitor.js";
// ServerProcessManager and createServerClient are now used by serverSession.ts
import { getPanelSource } from "@natstack/shared/panelTypes";

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

// Load central environment variables first (.env from ~/.config/natstack/)
loadCentralEnv();

const centralData = new CentralDataManager();
let startupMode: StartupMode;
let workspaceId: string = "unknown";

try {
  startupMode = resolveStartupMode(centralData);
} catch (error) {
  console.error("[Workspace] Failed to initialize workspace:", error);
  app.quit();
  process.exit(1);
}

if (startupMode.kind === "local") {
  workspaceId = startupMode.workspaceId;
  app.setPath("userData", path.join(startupMode.wsDir, "state"));
} else {
  app.setPath("userData", getRemoteUserDataDir());
}

installRemoteCertificateOverride(startupMode);

const tokenManager = new TokenManager();
let cdpServer: CdpServer | null = null;
let panelRegistry: PanelRegistry | null = null;
let panelOrchestrator: PanelOrchestrator | null = null;
let panelView: PanelView | null = null;
let shellCore: ReturnType<typeof import("./shellCore/createElectronShellCore.js").createElectronShellCore> | null = null;
let ipcDispatcher: import("./ipcDispatcher.js").IpcDispatcher | null = null;
let serverSession: SessionConnection | null = null;
let mainWindow: BaseWindow | null = null;
let viewManager: ViewManager | null = null;
let isCleaningUp = false; // Prevent re-entry in will-quit handler
let autofillManager: import("./autofill/autofillManager.js").AutofillManager | null = null;

log.info(` Starting in main mode`);

function installRemoteCertificateOverride(mode: StartupMode): void {
  if (mode.kind !== "remote" || mode.remoteUrl.protocol !== "https:") {
    return;
  }

  const expectedFingerprint = (
    mode.tls?.fingerprint ??
    (mode.tls?.caPath ? pemFileFingerprint(mode.tls.caPath) : undefined)
  )?.toUpperCase();

  if (!expectedFingerprint) {
    return;
  }

  const remoteHost = mode.remoteUrl.hostname;
  const installForSession = (targetSession: Session): void => {
    targetSession.setCertificateVerifyProc((request, callback) => {
      const sameManagedHost =
        request.hostname === remoteHost || request.hostname.endsWith(`.${remoteHost}`);

      if (!sameManagedHost) {
        callback(-3);
        return;
      }

      try {
        const actualFingerprint = pemFingerprint(request.certificate.data).toUpperCase();
        callback(actualFingerprint === expectedFingerprint ? 0 : -2);
      } catch {
        callback(-2);
      }
    });
  };

  app.on("session-created", installForSession);
  if (app.isReady()) {
    installForSession(session.defaultSession);
  } else {
    void app.whenReady().then(() => {
      installForSession(session.defaultSession);
    });
  }
}

// =============================================================================
// Window Creation
// =============================================================================

function createWindow(): void {
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

  // Initialize ViewManager with shell view (IPC transport — no WS args needed)
  viewManager = new ViewManager({
    window: mainWindow,
    shellPreload: path.join(__dirname, "preload.cjs"),
    shellHtmlPath: path.join(__dirname, "index.html"),
    shellAdditionalArguments: [],
    devTools: false,
  });

  // Set native window title for OS taskbar / window switcher (Alt+Tab / dock)
  mainWindow.setTitle(`NatStack — ${workspaceId}`);

  mainWindow.on("closed", () => {
    mainWindow = null;
    viewManager = null;
    panelView = null;  // Clear so getPanelView() returns null until recreated
  });

  // PanelView is resolved lazily by PanelOrchestrator via getPanelView()
  if (cdpServer && viewManager) {
    cdpServer.setViewManager(viewManager);
  }

  if (viewManager && panelRegistry && panelOrchestrator && cdpServer && serverSession) {
    panelView = new PanelView({
      viewManager,
      panelRegistry,
      serverInfo: serverSession.serverInfo,
      cdpServer,
      panelOrchestrator,
      sendPanelEvent: (panelId, event, payload) => {
        const wc = viewManager?.getWebContents(panelId);
        if (wc && !wc.isDestroyed()) {
          wc.send("natstack:event", event, payload);
        }
      },
      autofillManager: autofillManager ?? undefined,
      autofillPreloadPath: path.join(__dirname, "autofillPreload.cjs"),
      panelPreloadPath: path.join(__dirname, "panelPreload.cjs"),
      browserPreloadPath: path.join(__dirname, "browserPreload.cjs"),
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

    setupTestApi(panelOrchestrator, panelRegistry, panelView);
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
  if (panelOrchestrator) {
    panelOrchestrator.initializePanelTree().catch((error) => {
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

  // Strip CORS restrictions for app panels (defaultSession).
  // App panels are trusted workspace code that needs to call external APIs
  // (Gmail, Notion, etc.) directly via fetch(). Browser panels use
  // a separate "persist:browser" partition and are unaffected.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    headers["access-control-allow-origin"] = ["*"];
    headers["access-control-allow-headers"] = ["*"];
    headers["access-control-allow-methods"] = ["*"];
    callback({ responseHeaders: headers });
  });

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

  // Active shell subscriptions on the server side. The bridging events
  // service (registered further down) keeps this in sync with what the shell
  // has asked to receive. On serverClient reconnect the server forgets all
  // subscriptions (fresh auth → fresh callerId → fresh subscriber), so we
  // replay this set on every transition to "connected" — see
  // `replayShellSubscriptionsToServer` below.
  const shellEventSubscriptions = new Set<EventName>();
  let serverClientRef: import("./serverClient.js").ServerClient | null = null;
  const replayShellSubscriptionsToServer = async () => {
    if (!serverClientRef || shellEventSubscriptions.size === 0) return;
    const events = [...shellEventSubscriptions];
    log.info(`[events] replaying ${events.length} shell subscription(s) to server`);
    await Promise.all(events.map((event) =>
      serverClientRef!.call("events", "subscribe", [event]).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[events] replay subscribe(${event}) failed: ${msg}`);
      }),
    ));
  };

  // Bridge server→main events. Two distinct sources arrive through this
  // callback (serverClient.onEvent), and both need handling:
  //
  //   1. `build:complete` — broadcast manually via rpcServer.broadcastToControlPlane
  //      (no "event:" prefix). Has a panel-registry side effect.
  //
  //   2. Anything the server's EventService emits. WsSubscriber.send prefixes
  //      those with "event:" (e.g. "event:notification:show"). Nothing in
  //      main reads them directly — we re-emit them on main's local
  //      EventService so local subscribers (shell IpcSubscriber, etc.) see
  //      them uniformly alongside main-originated events.
  function handleServerEvent(event: string, payload: unknown) {
    if (event === "build:complete" && panelRegistry && panelOrchestrator) {
      const { source, error } = payload as { source: string; error?: string };
      const allPanels = panelRegistry.listPanels();
      for (const entry of allPanels) {
        const panel = panelRegistry.getPanel(entry.panelId);
        if (panel && getPanelSource(panel) === source) {
          if (error) {
            panelRegistry.updateArtifacts(entry.panelId, {
              buildState: "error",
              error,
              buildProgress: error,
            });
          } else {
            panelRegistry.updateArtifacts(entry.panelId, {
              htmlPath: panelOrchestrator.getPanelUrl(entry.panelId) ?? undefined,
              buildState: "ready",
            });
          }
        }
      }
      panelRegistry.notifyPanelTreeUpdate();
      return;
    }

    if (event.startsWith("event:")) {
      const bareEvent = event.slice("event:".length);
      if (isValidEventName(bareEvent)) {
        (eventService.emit as (e: EventName, d: unknown) => void)(bareEvent, payload);
      }
    }
  }

  try {
    performance.mark("startup:server-spawn-begin");

    // Emit a synthetic "connecting" sample so the connection badge has a
    // state to render from the very first frame (rather than flickering
    // from empty → connected). This mirrors what ServerClient's own
    // onConnectionStatusChanged callback will emit a few moments later
    // once the WS lifecycle begins.
    eventService.emit("server-connection-changed", {
      status: "connecting",
      isRemote: startupMode.kind === "remote",
      remoteHost: startupMode.kind === "remote" ? startupMode.remoteUrl.hostname : undefined,
    });

    // Phase 1: Establish server session (spawn or connect)
    let previousStatus: import("./serverClient.js").ConnectionStatus | null = null;
    serverSession = await establishServerSession({
      mode: startupMode,
      centralData,
      onServerEvent: handleServerEvent,
      onConnectionStatusChanged: (status) => {
        eventService.emit("server-connection-changed", {
          status,
          isRemote: startupMode.kind === "remote",
          remoteHost: startupMode.kind === "remote" ? startupMode.remoteUrl.hostname : undefined,
        });
        // On every transition into "connected" (including the very first one
        // and any subsequent reconnect), replay shell subscriptions. The
        // initial transition is a no-op because the shell hasn't subscribed
        // to anything yet; subsequent reconnects actually matter because the
        // server's EventService forgets subscriptions when the old WS closes.
        if (status === "connected" && previousStatus !== "connected") {
          void replayShellSubscriptionsToServer();
        }
        previousStatus = status;
      },
    });
    serverClientRef = serverSession.serverClient;
    workspaceId = serverSession.workspaceId;

    performance.mark("startup:server-spawned");
    performance.mark("startup:server-connected");

    if (mainWindow) {
      mainWindow.setTitle(`NatStack — ${workspaceId}`);
    }

    // Remote-mode only: poll /healthz from main-process every 60s and emit
    // `server-health` samples to the renderer. Local mode manages the
    // server process directly and doesn't need polled liveness info.
    if (startupMode.kind === "remote") {
      const { startRemoteHealthPoll } = await import("./remoteHealthPoll.js");
      startRemoteHealthPoll({
        baseUrl: startupMode.remoteUrl,
        adminToken: startupMode.adminToken,
        caPath: startupMode.tls?.caPath,
        fingerprint: startupMode.tls?.fingerprint,
        eventService,
      });
    }

    // CDP server (Electron-local) — must start before panel services
    cdpServer = new CdpServer(tokenManager);
    if (viewManager) cdpServer.setViewManager(viewManager);
    const cdpPort = await cdpServer.start();
    log.info(`[CDP] Server started on port ${cdpPort}`);

    // Create PanelRegistry (pure in-memory — server owns persistence)
    panelRegistry = new PanelRegistry({
      onTreeUpdated: (tree) => eventService.emit("panel-tree-updated", tree),
    });

    const { createElectronShellCore } = await import("./shellCore/createElectronShellCore.js");
    shellCore = createElectronShellCore({
      statePath: startupMode.kind === "remote" ? getRemoteUserDataDir() : serverSession.statePath,
      workspaceId: serverSession.workspaceId,
      workspacePath: serverSession.workspacePath,
      // In remote mode the workspace source tree lives on the server, so the
      // Electron process cannot require local panel manifests during bootstrap.
      allowMissingManifests: startupMode.kind === "remote",
      registry: panelRegistry,
      serverClient: serverSession.serverClient,
      protocol: serverSession.protocol,
      externalHost: serverSession.externalHost,
      gatewayPort: serverSession.gatewayPort,
      rpcPort: serverSession.rpcPort,
      workerdPort: serverSession.workerdPort,
      gitBaseUrl: serverSession.gitBaseUrl,
      rpcWsUrl: serverSession.rpcWsUrl,
      pubsubUrl: serverSession.pubsubUrl,
      workspaceConfig: serverSession.workspaceConfig,
    });

    // PanelHttpServer is created by serverSession (RPC-backed proxy)
    const conn = serverSession!;

    // Create IpcDispatcher (replaces Electron-side RpcServer for shell)
    // Forwards server-service calls to the server, dispatches Electron-local
    // services to the local dispatcher.
    const { IpcDispatcher } = await import("./ipcDispatcher.js");
    ipcDispatcher = new IpcDispatcher({
      dispatcher,
      serverClient: conn.serverClient,
      getShellWebContents: () => viewManager?.getShellWebContents() ?? null,
      eventService,
    });
    log.info(`[PanelHTTP] Using server's panel HTTP via gateway port ${conn.gatewayPort}`);

    // Create PanelOrchestrator
    panelOrchestrator = new PanelOrchestrator({
      registry: panelRegistry,
      tokenManager,
      eventService,
      serverClient: conn.serverClient,
      shellCore: shellCore.panelManager,
      cdpServer,
      getPanelView: () => panelView,
      panelHttpServer: conn.panelHttpServer,
      externalHost: conn.externalHost,
      protocol: conn.protocol,
      gatewayPort: conn.gatewayPort,
      sendPanelEvent: (panelId, event, payload) => {
        const wc = viewManager?.getWebContents(panelId);
        if (wc && !wc.isDestroyed()) {
          wc.send("natstack:event", event, payload);
        }
      },
      workspaceConfig: conn.workspaceConfig,
    });

    // Set up test API for E2E testing (only when NATSTACK_TEST_MODE=1)
    setupTestApi(panelOrchestrator, panelRegistry, null);
    setMenuPanelLifecycle(panelOrchestrator);
    setMenuPanelRegistry(panelRegistry);
    setMenuEventService(eventService);

    const adBlockManager = new AdBlockManager();

    // Autofill manager — password auto-fill for browser panels
    const { AutofillManager } = await import("./autofill/autofillManager.js");

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
    const { createSettingsService } = await import("./services/settingsService.js");
    const { createAdblockService } = await import("./services/adblockService.js");
    const { createBrowserService } = await import("./services/browserService.js");
    // FS and git-local services removed — server owns these via panel service
    const { createBrowserDataService } = await import("./services/browserDataService.js");
    const { BrowserDataStore } = await import("@natstack/browser-data");
    const { getCentralConfigDirectory } = await import("./paths.js");

    const electronContainer = new ServiceContainer(dispatcher);

    const { serverClient: sc } = conn;

    // Shell-only services
    electronContainer.register(rpcService(createAppService({
      panelOrchestrator, serverClient: sc, getViewManager,
      connectionMode: startupMode.kind === "remote" ? "remote" : "local",
      remoteHost: startupMode.kind === "remote" ? startupMode.remoteUrl.hostname : undefined,
    })));
    electronContainer.register(rpcService(createPanelShellService({
      panelOrchestrator, panelRegistry,
      get panelView(): PanelView { return getPanelView(); },
      getViewManager,
    })));
    electronContainer.register(rpcService(createViewService({ getViewManager })));
    electronContainer.register(rpcService(createMenuService({
      panelOrchestrator, panelRegistry, getViewManager, serverClient: sc,
    })));
    // Workspace operations live entirely on the server now (single source of
    // truth, accessible to panels/workers/shell). The shell renderer's
    // `workspace.*` calls reach the server via IpcDispatcher's forwardToServer
    // path because "workspace" is in SERVER_SERVICE_NAMES. Workspace.select
    // (relaunch) is signalled from the server back to Electron main via
    // ServerProcessManager.onRelaunch (wired in serverSession.ts).
    electronContainer.register(rpcService(createSettingsService({ serverClient: sc })));
    const { createRemoteCredService } = await import("./services/remoteCredService.js");
    electronContainer.register(rpcService(createRemoteCredService({ startupMode })));
    electronContainer.register(rpcService(createAdblockService({ adBlockManager })));
    // Client-owned OAuth flow — opens the user's browser, captures the
    // loopback redirect, exchanges the code, and forwards tokens to the
    // server's authTokens.persist. With `auth` removed from
    // SERVER_SERVICE_NAMES, panel calls to `auth.*` land here instead of
    // the (potentially remote) server.
    const { createAuthService } = await import("./services/authService.js");
    electronContainer.register(rpcService(createAuthService({ serverClient: sc })));

    // Locally-hosted services
    electronContainer.register(rpcService(createBrowserService({
      cdpServer, getViewManager, panelRegistry,
    })));
    // FS and git-local services removed — server-side only now
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
    // Events service — local subscription on main's EventService plus a
    // fire-and-forget forward to the server. The forward makes main's
    // serverClient WS a subscriber on the server's EventService for the same
    // event, so anything the server emits (notification:show, oauth consent
    // prompts, etc.) comes back over that WS and is re-emitted on main's
    // EventService by handleServerEvent. Net effect: the shell sees one
    // logical event bus across the main/server split.
    //
    // We also keep `shellEventSubscriptions` in sync with what the shell
    // has subscribed to, so that on serverClient reconnect we can replay
    // the set to the server's freshly-authenticated connection (the old
    // subscriber dies with the old WS).
    {
      const baseEventsService = createEventsServiceDefinition(eventService);
      electronContainer.register(rpcService({
        ...baseEventsService,
        handler: async (ctx, method, args) => {
          const result = await baseEventsService.handler(ctx, method, args);
          if (ctx.callerKind !== "shell") return result;

          if (method === "subscribe") {
            shellEventSubscriptions.add(args[0] as EventName);
          } else if (method === "unsubscribe") {
            shellEventSubscriptions.delete(args[0] as EventName);
          } else if (method === "unsubscribeAll") {
            shellEventSubscriptions.clear();
          }

          void sc.call("events", method, args as unknown[]).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`[events] forward ${method} to server failed: ${msg}`);
          });
          return result;
        },
      }));
    }

    await electronContainer.startAll();

    dispatcher.markInitialized();

    // =========================================================================
    // Register ipcMain.handle handlers for __natstackElectron (panel preload)
    // =========================================================================
    // These handlers service panel IPC calls. Caller identity is resolved
    // via ViewManager's findViewIdByWebContentsId (which tracks the
    // webContents.id → viewId mapping for all created views).
    // The shell webContents is registered as viewId "shell".

    const resolveCallerId = (event: Electron.IpcMainInvokeEvent): string => {
      if (!viewManager) throw new Error("ViewManager not initialized");
      // Check if it's the shell
      const shellContents = viewManager.getShellWebContents();
      if (shellContents && !shellContents.isDestroyed() && shellContents.id === event.sender.id) {
        return "shell";
      }
      const viewId = viewManager.findViewIdByWebContentsId(event.sender.id);
      if (!viewId) throw new Error("Unknown caller webContents");
      return viewId;
    };

    ipcMain.handle("natstack:getPanelInit", async (event) => {
      const callerId = resolveCallerId(event);
      return shellCore?.panelManager.getPanelInit(callerId);
    });

    // Panel lifecycle
    ipcMain.handle("natstack:bridge.closeSelf", async (event) => {
      const callerId = resolveCallerId(event);
      return panelOrchestrator!.closePanel(callerId);
    });
    ipcMain.handle("natstack:closeSelf", async (event) => {
      const callerId = resolveCallerId(event);
      return panelOrchestrator!.closePanel(callerId);
    });
    ipcMain.handle("natstack:bridge.closeChild", async (event, childId: string) => {
      const callerId = resolveCallerId(event);
      return panelOrchestrator!.closeChild(callerId, childId);
    });
    ipcMain.handle("natstack:closeChild", async (event, childId: string) => {
      const callerId = resolveCallerId(event);
      return panelOrchestrator!.closeChild(callerId, childId);
    });
    ipcMain.handle("natstack:bridge.focusPanel", async (_event, panelId: string) => {
      panelOrchestrator!.focusPanel(panelId);
    });
    ipcMain.handle("natstack:focusPanel", async (_event, panelId: string) => {
      panelOrchestrator!.focusPanel(panelId);
    });
    ipcMain.handle("natstack:bridge.createBrowserPanel", async (event, url: string, opts?: { name?: string; focus?: boolean }) => {
      const callerId = resolveCallerId(event);
      return panelOrchestrator!.createBrowserPanel(callerId, url, opts);
    });
    ipcMain.handle("natstack:createBrowserPanel", async (event, url: string, opts?: { name?: string; focus?: boolean }) => {
      const callerId = resolveCallerId(event);
      return panelOrchestrator!.createBrowserPanel(callerId, url, opts);
    });
    ipcMain.handle("natstack:bridge.getInfo", async (event) => {
      const callerId = resolveCallerId(event);
      return shellCore?.panelManager.getInfo(callerId);
    });
    ipcMain.handle("natstack:bridge.setStateArgs", async (event, updates: Record<string, unknown>) => {
      const callerId = resolveCallerId(event);
      return shellCore?.panelManager.updateStateArgs(callerId, updates);
    });
    ipcMain.handle("natstack:getBootstrapConfig", async (event) => {
      const callerId = resolveCallerId(event);
      return shellCore?.panelManager.getPanelInit(callerId);
    });

    // Electron-native
    ipcMain.handle("natstack:bridge.openDevtools", async (event) => {
      const callerId = resolveCallerId(event);
      if (!viewManager) throw new Error("ViewManager not initialized");
      viewManager.openDevTools(callerId);
    });
    ipcMain.handle("natstack:openDevtools", async (event) => {
      const callerId = resolveCallerId(event);
      if (!viewManager) throw new Error("ViewManager not initialized");
      viewManager.openDevTools(callerId);
    });
    ipcMain.handle("natstack:bridge.openFolderDialog", async (_event, opts?: { title?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title: opts?.title ?? "Select Folder",
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
    ipcMain.handle("natstack:openFolderDialog", async (_event, opts?: { title?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title: opts?.title ?? "Select Folder",
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
    ipcMain.handle("natstack:openFileDialog", async (
      _event,
      opts?: { title?: string; filters?: { name: string; extensions: string[] }[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile"],
        title: opts?.title ?? "Select File",
        filters: opts?.filters,
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
    ipcMain.handle("natstack:bridge.openExternal", async (_event, url: string) => {
      if (!/^https?:\/\//i.test(url)) {
        throw new Error("openExternal only supports http/https URLs");
      }
      const { shell } = await import("electron");
      await shell.openExternal(url);
    });
    ipcMain.handle("natstack:openExternal", async (_event, url: string) => {
      if (!/^https?:\/\//i.test(url)) {
        throw new Error("openExternal only supports http/https URLs");
      }
      const { shell } = await import("electron");
      await shell.openExternal(url);
    });

    // Generic Electron service dispatch — lets panels call Electron-local
    // services (browser-data, autofill, etc.) directly via IPC instead of
    // going through the server, which may be remote.
    ipcMain.handle("natstack:serviceCall", async (event, method: string, args: unknown[]) => {
      const callerId = resolveCallerId(event);
      const parsed = parseServiceMethod(method);
      if (!parsed) throw new Error(`Invalid method format: "${method}". Expected "service.method"`);
      const callerKind = callerId === "shell" ? "shell" as const : "panel" as const;
      return dispatcher.dispatch({ callerId, callerKind }, parsed.service, parsed.method, args);
    });

    // Browser automation (CdpServer)
    ipcMain.handle("natstack:getCdpEndpoint", async (event, browserId: string) => {
      const callerId = resolveCallerId(event);
      const { getCdpEndpointForCaller } = await import("./services/browserService.js");
      return getCdpEndpointForCaller(cdpServer!, browserId, callerId);
    });
    ipcMain.handle("natstack:navigate", async (event, browserId: string, url: string) => {
      resolveCallerId(event); // auth check
      const wc = viewManager!.getWebContents(browserId);
      if (!wc) throw new Error(`Browser webContents not found for ${browserId}`);
      try { await wc.loadURL(url); } catch (err) {
        const error = err as { code?: string; errno?: number };
        if (error.errno === -3 || error.code === "ERR_ABORTED") return;
        throw err;
      }
    });
    ipcMain.handle("natstack:goBack", async (event, browserId: string) => {
      resolveCallerId(event);
      viewManager!.getWebContents(browserId)?.goBack();
    });
    ipcMain.handle("natstack:goForward", async (event, browserId: string) => {
      resolveCallerId(event);
      viewManager!.getWebContents(browserId)?.goForward();
    });
    ipcMain.handle("natstack:reload", async (event, browserId: string) => {
      resolveCallerId(event);
      viewManager!.getWebContents(browserId)?.reload();
    });
    ipcMain.handle("natstack:stop", async (event, browserId: string) => {
      resolveCallerId(event);
      viewManager!.getWebContents(browserId)?.stop();
    });

    // createWindow will create ViewManager, PanelView, and initialize panel tree
    void createWindow();

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

    if (serverSession?.serverClient) {
      cleanupPromises.push(
        serverSession.serverClient.close().catch((e) => console.error("[App] serverClient cleanup error:", e))
      );
    }
    if (serverSession?.serverProcessManager) {
      cleanupPromises.push(
        serverSession.serverProcessManager.shutdown().catch((e) => console.error("[App] serverProcess cleanup error:", e))
      );
    }
    serverSession = null;
    if (cdpServer) {
      cleanupPromises.push(
        cdpServer.stop().catch((e) => console.error("[App] cdpServer cleanup error:", e))
      );
      cdpServer = null;
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
  app.quit();
});

// Use will-quit with preventDefault to properly await async shutdown
app.on("will-quit", (event) => {
  // Prevent re-entry - if we're already cleaning up, let the app exit
  if (isCleaningUp) {
    return;
  }

  // Cleanup helper for ephemeral dev workspaces (called sync, after servers stop)
  const isEphemeral = startupMode.kind === "local" && startupMode.isEphemeral;
  const cleanupDevWorkspace = () => {
    if (isEphemeral && workspaceId) {
      try {
        deleteWorkspaceDir(workspaceId);
        centralData.removeWorkspace(workspaceId);
        console.log(`[App] Deleted ephemeral dev workspace "${workspaceId}"`);
      } catch (e) {
        console.error("[App] Failed to delete dev workspace:", e);
      }
    }
  };

  const hasResourcesToClean = serverSession || cdpServer;
  if (hasResourcesToClean) {
    isCleaningUp = true;
    event.preventDefault();

    console.log("[App] Shutting down...");

    const stopPromises: Promise<void>[] = [];

    // Server client (WS admin connection) + server process
    if (serverSession) {
      // Run panel cleanup via server (archive childless shell panels),
      // then close the connection and stop the server process.
      const session = serverSession;
      serverSession = null;

      const cleanupThenClose = (async () => {
        if (panelRegistry && shellCore) {
          const livePanelIds = panelRegistry.listPanels().map(p => p.panelId);
          await shellCore.panelManager.shutdownCleanup(livePanelIds)
            .catch((e: unknown) => console.error("[App] Failed to run shutdown cleanup:", e));
        }
        await session.serverClient.close()
          .catch((e) => console.error("[App] Server client close error:", e));
      })();
      stopPromises.push(cleanupThenClose);

      if (session.serverProcessManager) {
        stopPromises.push(
          cleanupThenClose.then(() =>
            session.serverProcessManager!
              .shutdown()
              .then(() => console.log("[App] Server process stopped"))
              .catch((e) => console.error("[App] Server process shutdown error:", e))
          )
        );
      }
    }

    if (cdpServer) {
      stopPromises.push(
        cdpServer
          .stop()
          .then(() => console.log("[App] CDP server stopped"))
          .catch((e) => console.error("[App] Error stopping CDP server:", e))
      );
    }

    // Add a timeout to ensure we exit even if cleanup hangs
    const shutdownTimeout = setTimeout(() => {
      console.warn("[App] Shutdown timeout - forcing exit");
      app.exit(1);
    }, 5000);

    Promise.all(stopPromises).finally(() => {
      shellCore?.shutdown?.();
      shellCore = null;
      clearTimeout(shutdownTimeout);
      cleanupDevWorkspace();
      console.log("[App] Shutdown complete");
      app.exit(0);
    });
  } else {
    cleanupDevWorkspace();
  }
});

app.on("activate", () => {
  if (mainWindow === null && serverSession) {
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
