import { contextBridge, ipcRenderer } from "electron";
import type {
  Panel,
  ThemeAppearance,
  ThemeMode,
  AppInfo,
} from "../shared/ipc/index.js";

// Create the API object that will be exposed to the renderer
export const electronAPI = {
  // App methods
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke("app:get-info"),
  getSystemTheme: (): Promise<ThemeAppearance> => ipcRenderer.invoke("app:get-system-theme"),
  setThemeMode: (mode: ThemeMode): Promise<void> => ipcRenderer.invoke("app:set-theme-mode", mode),
  openAppDevTools: (): Promise<void> => ipcRenderer.invoke("app:open-devtools"),
  getPanelPreloadPath: (): Promise<string> => ipcRenderer.invoke("app:get-panel-preload-path"),

  // Panel methods
  getPanelTree: (): Promise<Panel[]> => ipcRenderer.invoke("panel:get-tree"),
  notifyPanelFocused: (panelId: string): Promise<void> =>
    ipcRenderer.invoke("panel:notify-focus", panelId),
  updatePanelTheme: (theme: ThemeAppearance): Promise<void> =>
    ipcRenderer.invoke("panel:update-theme", theme),
  openPanelDevTools: (panelId: string): Promise<void> =>
    ipcRenderer.invoke("panel:open-devtools", panelId),

  // Event listeners (one-way events from main)
  onSystemThemeChanged: (callback: (theme: ThemeAppearance) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, theme: ThemeAppearance) => {
      callback(theme);
    };
    ipcRenderer.on("system-theme-changed", listener);
    return () => {
      ipcRenderer.removeListener("system-theme-changed", listener);
    };
  },

  onPanelTreeUpdated: (callback: (rootPanels: Panel[]) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, rootPanels: Panel[]) => {
      callback(rootPanels);
    };
    ipcRenderer.on("panel:tree-updated", listener);
    return () => {
      ipcRenderer.removeListener("panel:tree-updated", listener);
    };
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);

declare global {
  interface Window {
    electronAPI: typeof electronAPI;
  }
}
