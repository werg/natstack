import { app, BrowserWindow, ipcMain, nativeTheme, type IpcMainInvokeEvent } from "electron";
import * as path from "path";
import { isDev } from "./utils.js";
import { PanelManager } from "./panelManager.js";
import { resolveInitialRootPanelPath } from "./rootPanelResolver.js";
import { GitServer } from "./gitServer.js";

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

ipcMain.handle("get-app-info", async (_event: IpcMainInvokeEvent): Promise<{ version: string }> => {
  return {
    version: app.getVersion(),
  };
});

// Theme IPC handlers
ipcMain.handle("get-system-theme", async (): Promise<"light" | "dark"> => {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
});

ipcMain.handle(
  "set-theme-mode",
  async (_event: IpcMainInvokeEvent, mode: "light" | "dark" | "system"): Promise<void> => {
    nativeTheme.themeSource = mode;
  }
);

ipcMain.handle("panel:get-preload-path", async (): Promise<string> => {
  return path.join(__dirname, "panelPreload.cjs");
});

ipcMain.handle("app:open-devtools", async (): Promise<void> => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
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
