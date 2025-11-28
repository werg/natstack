import { app, BrowserWindow, nativeTheme, webContents } from "electron";
import * as path from "path";
import * as fs from "fs";

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
import { setAppMode } from "./ipc/workspaceHandlers.js";
import { getCentralData } from "./centralData.js";
import { registerPanelProtocol, setupPanelProtocol } from "./panelProtocol.js";
import { getMainCacheManager } from "./cacheManager.js";

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
let panelManager: PanelManager | null = null;
let mainWindow: BrowserWindow | null = null;

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
  mainWindow = new BrowserWindow({
    width: 1200,
    height: appMode === "main" ? 600 : 500,
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

  // Set main window reference in panel manager (if in main mode)
  if (panelManager) {
    panelManager.setMainWindow(mainWindow);
  }

  // Setup application menu
  setupMenu(mainWindow);
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
});

handle("app:get-panel-preload-path", async () => {
  return path.join(__dirname, "panelPreload.cjs");
});

handle("app:clear-build-cache", async () => {
  // Clear main-process cache and repo manifest
  const cacheManager = getMainCacheManager();
  await cacheManager.clear();

  console.log("[App] Build cache cleared");
});

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
  const pm = requirePanelManager();
  const views = pm.getPanelViews(panelId);
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
// Panel Bridge IPC Handlers (panel webview <-> main) - Only in main mode
// =============================================================================

// Create child panel - main process handles git checkout and build
handle(
  "panel-bridge:create-child",
  async (event, parentId: string, childPath: string, options?: SharedPanel.CreateChildOptions) => {
    assertAuthorized(event, parentId);
    return requirePanelManager().createChild(parentId, childPath, options);
  }
);

handle("panel-bridge:remove-child", async (event, parentId: string, childId: string) => {
  assertAuthorized(event, parentId);
  return requirePanelManager().removeChild(parentId, childId);
});

handle("panel-bridge:set-title", async (event, panelId: string, title: string) => {
  assertAuthorized(event, panelId);
  return requirePanelManager().setTitle(panelId, title);
});

handle("panel-bridge:close", async (event, panelId: string) => {
  assertAuthorized(event, panelId);
  return requirePanelManager().closePanel(panelId);
});

handle("panel-bridge:register", async (event, panelId: string, authToken: string) => {
  // This is the initial handshake, so we don't use assertAuthorized yet.
  // Instead, we verify the token which proves identity.
  requirePanelManager().verifyAndRegister(panelId, authToken, event.sender.id);
});

handle("panel-bridge:get-env", async (event, panelId: string) => {
  assertAuthorized(event, panelId);
  return requirePanelManager().getEnv(panelId);
});

handle("panel-bridge:get-info", async (event, panelId: string) => {
  assertAuthorized(event, panelId);
  return requirePanelManager().getInfo(panelId);
});

handle("panel-bridge:get-git-config", async (event, panelId: string) => {
  assertAuthorized(event, panelId);
  return requirePanelManager().getGitConfig(panelId);
});

// =============================================================================
// App Lifecycle
// =============================================================================

app.on("ready", async () => {
  // Set up panel protocol handler
  setupPanelProtocol();

  // Initialize cache manager (shared across all panels)
  const cacheManager = getMainCacheManager();
  await cacheManager.initialize();

  // Initialize services only in main mode
  if (appMode === "main" && gitServer && panelManager) {
    try {
      // Start git server
      const port = await gitServer.start();
      console.log(`[Git] Server started on port ${port}`);

      // Initialize RPC handler
      const { PanelRpcHandler } = await import("./ipc/rpcHandler.js");
      new PanelRpcHandler(panelManager);

      // Initialize AI handler
      const { AIHandler } = await import("./ai/aiHandler.js");
      aiHandler = new AIHandler(panelManager);
      await aiHandler.initialize();
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
  if (gitServer) {
    event.preventDefault();
    gitServer
      .stop()
      .catch((error) => {
        console.error("Error stopping git server:", error);
      })
      .finally(() => {
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(
      "system-theme-changed",
      nativeTheme.shouldUseDarkColors ? "dark" : "light"
    );
  }
});

// Import workspace handlers to register them
import "./ipc/workspaceHandlers.js";
