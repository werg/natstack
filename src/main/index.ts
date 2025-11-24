import dotenv from "dotenv";
import { app, BrowserWindow, nativeTheme, webContents } from "electron";
import * as path from "path";
import { createAnthropic } from "@ai-sdk/anthropic";

dotenv.config();
import { isDev } from "./utils.js";
import { PanelManager } from "./panelManager.js";
import { resolveInitialRootPanelPath } from "./rootPanelResolver.js";
import { GitServer } from "./gitServer.js";
import { handle } from "./ipc/handlers.js";
import * as SharedPanel from "../shared/ipc/types.js";
import { setupMenu } from "./menu.js";

let mainWindow: BrowserWindow | null = null;
const initialRootPanelPath = resolveInitialRootPanelPath();
// console.log("Using root panel path:", initialRootPanelPath);
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

  // Setup application menu
  setupMenu(mainWindow);
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

handle("app:set-theme-mode", async (_event, mode: SharedPanel.ThemeMode) => {
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

handle("panel:update-theme", async (_event, theme: SharedPanel.ThemeAppearance) => {
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

// Initialize RPC handler
import { PanelRpcHandler } from "./ipc/rpcHandler.js";
new PanelRpcHandler(panelManager);

// Initialize AI handler
import { AIHandler } from "./ai/aiHandler.js";
export const aiHandler = new AIHandler(panelManager);

// Temporary default provider registration until a config file is wired
try {
  const anthropicProvider = createAnthropic({
    apiKey: process.env["ANTHROPIC_API_KEY"],
  });

  if (!process.env["ANTHROPIC_API_KEY"]) {
    console.warn("[AIHandler] ANTHROPIC_API_KEY is not set; AI calls will fail until configured.");
  }

  aiHandler.registerProvider({
    id: "anthropic",
    name: "Anthropic",
    createModel: (modelId) => anthropicProvider(modelId),
    models: [
      {
        id: "claude-haiku-4-5-20251001",
        displayName: "Claude 4.5 Haiku",
        description: "Anthropic Claude 4.5 Haiku model",
      },
    ],
  });
} catch (error) {
  console.warn(
    "Failed to register default Anthropic provider. Configure providers manually.",
    error
  );
}

// =============================================================================
// Panel Bridge IPC Handlers (panel webview <-> main)
// =============================================================================

// Helper to get sender ID and validate authorization
function assertAuthorized(event: Electron.IpcMainInvokeEvent, panelId: string): void {
  const senderPanelId = panelManager.getPanelIdForWebContents(event.sender);
  if (senderPanelId !== panelId) {
    throw new Error(`Unauthorized: Sender ${senderPanelId} cannot act as ${panelId}`);
  }
}

handle(
  "panel-bridge:create-child",
  async (
    event,
    parentId: string,
    panelPath: string,
    env?: Record<string, string>,
    requestedPanelId?: string
  ) => {
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

handle("panel-bridge:register", async (event, panelId: string, authToken: string) => {
  // This is the initial handshake, so we don't use assertAuthorized yet.
  // Instead, we verify the token which proves identity.
  panelManager.verifyAndRegister(panelId, authToken, event.sender.id);
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
