import { contextBridge, ipcRenderer } from "electron";

interface AppInfo {
  version: string;
}

type ThemeMode = 'light' | 'dark' | 'system';

interface ElectronAPI {
  getAppInfo(): Promise<AppInfo>;
  getSystemTheme(): Promise<'light' | 'dark'>;
  setThemeMode(mode: ThemeMode): Promise<void>;
  onSystemThemeChanged(callback: (theme: 'light' | 'dark') => void): () => void;
}

const electronAPI: ElectronAPI = {
  getAppInfo: async (): Promise<AppInfo> => {
    return ipcRenderer.invoke("get-app-info") as Promise<AppInfo>;
  },
  getSystemTheme: async (): Promise<'light' | 'dark'> => {
    return ipcRenderer.invoke("get-system-theme") as Promise<'light' | 'dark'>;
  },
  setThemeMode: async (mode: ThemeMode): Promise<void> => {
    return ipcRenderer.invoke("set-theme-mode", mode) as Promise<void>;
  },
  onSystemThemeChanged: (callback: (theme: 'light' | 'dark') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, theme: 'light' | 'dark') => {
      callback(theme);
    };
    ipcRenderer.on('system-theme-changed', listener);
    // Return cleanup function
    return () => {
      ipcRenderer.removeListener('system-theme-changed', listener);
    };
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
