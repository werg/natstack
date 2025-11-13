import { contextBridge, ipcRenderer } from "electron";

interface AppInfo {
  version: string;
}

interface ElectronAPI {
  getAppInfo(): Promise<AppInfo>;
}

const electronAPI: ElectronAPI = {
  getAppInfo: async (): Promise<AppInfo> => {
    return ipcRenderer.invoke("get-app-info") as Promise<AppInfo>;
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
