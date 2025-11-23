import { app, BrowserWindow, ipcMain, nativeTheme, webContents } from "electron";
import * as path from "path";
import { isDev } from "./utils.js";
import { PanelManager } from "./panelManager.js";
import { resolveInitialRootPanelPath } from "./rootPanelResolver.js";
import { GitServer } from "./gitServer.js";
import { handle } from "./ipc/handlers.js";
import type { ThemeMode, ThemeAppearance } from "../shared/ipc/index.js";

let mainWindow: BrowserWindow | null = null;
const initialRootPanelPath = resolveInitialRootPanelPath();
console.log("Using root panel path:", initialRootPanelPath);
const gitServer = new GitServer();
const panelManager = new PanelManager(initialRootPanelPath, gitServer);

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 600,
    titleBarStyle: "hidden",
    ...(process.platform !== "darwin"
      ? {
          titleBarOverlay: true,
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
    },
  });

  void mainWindow.loadFile(path.join(__dirname, "index.html"));

  if (isDev()) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Set main window reference in panel manager
  panelManager.setMainWindow(mainWindow);
}

// =============================================================================
// App IPC Handlers (renderer <-> main)
// =============================================================================

handle("app:get-info", async () => {
  return { version: app.getVersion() };
});

handle("app:get-system-theme", async () => {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
});

handle("app:set-theme-mode", async (_event, mode: ThemeMode) => {
  nativeTheme.themeSource = mode;
});

handle("app:open-devtools", async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
});

handle("app:get-panel-preload-path", async () => {
  return path.join(__dirname, "panelPreload.cjs");
});

// =============================================================================
// Panel IPC Handlers (renderer <-> main)
// =============================================================================

handle("panel:get-tree", async () => {
  return panelManager.getSerializablePanelTree();
});

handle("panel:notify-focus", async (_event, panelId: string) => {
  panelManager.sendPanelEvent(panelId, { type: "focus" });
});

handle("panel:update-theme", async (_event, theme: ThemeAppearance) => {
  panelManager.setCurrentTheme(theme);
  panelManager.broadcastTheme(theme);
});

handle("panel:open-devtools", async (_event, panelId: string) => {
  const views = panelManager.getPanelViews(panelId);
  if (!views || views.size === 0) {
    throw new Error(`No active webviews for panel ${panelId}`);
  }

  for (const contentsId of views) {
    const contents = webContents.fromId(contentsId);
    if (contents && !contents.isDestroyed()) {
      contents.openDevTools({ mode: "detach" });
    }
  }
});

// =============================================================================
// Panel Bridge IPC Handlers (panel webview <-> main)
// =============================================================================

// Helper to get sender ID and validate authorization
function assertAuthorized(event: Electron.IpcMainInvokeEvent, panelId: string): void {
  const senderId = event.sender.id;
  const views = panelManager.getPanelViews(panelId);
  if (!views || !views.has(senderId)) {
    throw new Error(`Unauthorized: sender is not a registered view for panel ${panelId}`);
  }
}

handle(
  "panel-bridge:create-child",
  async (event, parentId: string, panelPath: string, env?: Record<string, string>, requestedPanelId?: string) => {
    assertAuthorized(event, parentId);
    return panelManager.createChild(parentId, panelPath, env, requestedPanelId);
  }
);

handle("panel-bridge:remove-child", async (event, parentId: string, childId: string) => {
  assertAuthorized(event, parentId);
  return panelManager.removeChild(parentId, childId);
});

handle("panel-bridge:set-title", async (event, panelId: string, title: string) => {
  assertAuthorized(event, panelId);
  return panelManager.setTitle(panelId, title);
});

handle("panel-bridge:close", async (event, panelId: string) => {
  assertAuthorized(event, panelId);
  return panelManager.closePanel(panelId);
});

handle("panel-bridge:register-view", async (event, panelId: string) => {
  // Note: registerView is intentionally not authorized - it's how panels establish identity
  // The panelId comes from a trusted source (URL query param set by the host)
  panelManager.registerPanelView(panelId, event.sender.id);
});

handle("panel-bridge:get-env", async (event, panelId: string) => {
  assertAuthorized(event, panelId);
  return panelManager.getEnv(panelId);
});

handle("panel-bridge:get-info", async (event, panelId: string) => {
  assertAuthorized(event, panelId);
  return panelManager.getInfo(panelId);
});

// =============================================================================
// Panel-to-Panel RPC Handlers
// =============================================================================

// Helper to check if two panels can communicate (parent-child relationship)
function assertCanCommunicate(fromPanelId: string, toPanelId: string): void {
  const fromPanel = panelManager.getPanel(fromPanelId);
  const toPanel = panelManager.getPanel(toPanelId);

  if (!fromPanel || !toPanel) {
    throw new Error("One or both panels not found");
  }

  // Check if fromPanel is parent of toPanel
  const isParent = fromPanel.children.some((child) => child.id === toPanelId);
  // Check if toPanel is parent of fromPanel
  const isChild = toPanel.children.some((child) => child.id === fromPanelId);

  if (!isParent && !isChild) {
    throw new Error("Panels can only communicate with their direct parent or children");
  }
}

handle(
  "panel-rpc:call",
  async (event, fromPanelId: string, toPanelId: string, method: string, args: unknown[]) => {
    assertAuthorized(event, fromPanelId);
    assertCanCommunicate(fromPanelId, toPanelId);

    // Get the target panel's webContents and forward the call
    const targetViews = panelManager.getPanelViews(toPanelId);
    if (!targetViews || targetViews.size === 0) {
      throw new Error(`Target panel ${toPanelId} has no active views`);
    }

    // Get the first view (panels typically have one view)
    const targetContentsId = targetViews.values().next().value as number | undefined;
    if (targetContentsId === undefined) {
      throw new Error(`Target panel ${toPanelId} has no active views`);
    }

    const targetContents = webContents.fromId(targetContentsId);
    if (!targetContents || targetContents.isDestroyed()) {
      throw new Error(`Target panel ${toPanelId} view is not available`);
    }

    // Generate a unique request ID
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Send the RPC request to the target panel and wait for response
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`RPC call to ${toPanelId}.${method} timed out`));
      }, 30000);

      const responseChannel = `panel-rpc:response:${requestId}`;

      const responseHandler = (
        responseEvent: Electron.IpcMainEvent,
        response: { result?: unknown; error?: string }
      ) => {
        if (responseEvent.sender.id !== targetContentsId) {
          return;
        }
        cleanup();
        if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response.result);
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        ipcMain.removeListener(responseChannel, responseHandler);
      };

      ipcMain.on(responseChannel, responseHandler);

      targetContents.send("panel-rpc:request", {
        requestId,
        fromPanelId,
        method,
        args,
      });
    });
  }
);

handle(
  "panel-rpc:emit",
  async (event, fromPanelId: string, toPanelId: string, eventName: string, payload: unknown) => {
    assertAuthorized(event, fromPanelId);
    assertCanCommunicate(fromPanelId, toPanelId);

    // Get the target panel's webContents and forward the event
    const targetViews = panelManager.getPanelViews(toPanelId);
    if (!targetViews || targetViews.size === 0) {
      // Silently ignore if target has no views (panel might be initializing)
      return;
    }

    for (const contentsId of targetViews) {
      const contents = webContents.fromId(contentsId);
      if (contents && !contents.isDestroyed()) {
        contents.send("panel-rpc:event", {
          fromPanelId,
          event: eventName,
          payload,
        });
      }
    }
  }
);

// =============================================================================
// App Lifecycle
// =============================================================================

app.on("ready", async () => {
  try {
    const port = await gitServer.start();
    console.log(`Git server started on port ${port}`);
  } catch (error) {
    console.error("Failed to start git server:", error);
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
  event.preventDefault();
  gitServer
    .stop()
    .catch((error) => {
      console.error("Error stopping git server:", error);
    })
    .finally(() => {
      app.exit(0);
    });
});

app.on("activate", () => {
  if (mainWindow === null) {
    void createWindow();
  }
});

// Listen for system theme changes and notify renderer
nativeTheme.on("updated", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(
      "system-theme-changed",
      nativeTheme.shouldUseDarkColors ? "dark" : "light"
    );
  }
});
