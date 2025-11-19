import { contextBridge, ipcRenderer } from "electron";

interface AppInfo {
  version: string;
}

type ThemeMode = "light" | "dark" | "system";

import type { Panel } from "../main/panelTypes.js";

export const electronAPI = {
  getAppInfo: async (): Promise<AppInfo> => {
    return ipcRenderer.invoke("get-app-info") as Promise<AppInfo>;
  },
  getSystemTheme: async (): Promise<"light" | "dark"> => {
    return ipcRenderer.invoke("get-system-theme") as Promise<"light" | "dark">;
  },
  setThemeMode: async (mode: ThemeMode): Promise<void> => {
    return ipcRenderer.invoke("set-theme-mode", mode) as Promise<void>;
  },
  onSystemThemeChanged: (callback: (theme: "light" | "dark") => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, theme: "light" | "dark") => {
      callback(theme);
    };
    ipcRenderer.on("system-theme-changed", listener);
    // Return cleanup function
    return () => {
      ipcRenderer.removeListener("system-theme-changed", listener);
    };
  },
  getPanelTree: async (): Promise<Panel[]> => {
    return ipcRenderer.invoke("panel:get-tree") as Promise<Panel[]>;
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
  getPanelPreloadPath: async (): Promise<string> => {
    return ipcRenderer.invoke("panel:get-preload-path") as Promise<string>;
  },
  notifyPanelFocused: async (panelId: string): Promise<void> => {
    return ipcRenderer.invoke("panel:notify-focus", panelId) as Promise<void>;
  },
  updatePanelTheme: async (theme: "light" | "dark"): Promise<void> => {
    return ipcRenderer.invoke("panel:update-theme", theme) as Promise<void>;
  },
  openPanelDevTools: async (panelId: string): Promise<void> => {
    return ipcRenderer.invoke("panel:open-devtools", panelId) as Promise<void>;
  },
  openAppDevTools: async (): Promise<void> => {
    return ipcRenderer.invoke("app:open-devtools") as Promise<void>;
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);

declare global {
  interface Window {
    electronAPI: typeof electronAPI;
  }
}
