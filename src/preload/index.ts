import { contextBridge, ipcRenderer } from "electron";
import type * as Panel from "../shared/ipc/types.js";

// Create the API object that will be exposed to the renderer
export const electronAPI = {
  // App methods
  getInfo: (): Promise<Panel.AppInfo> => ipcRenderer.invoke("app:get-info"),
  getSystemTheme: (): Promise<Panel.ThemeMode> => ipcRenderer.invoke("app:get-system-theme"),
  setThemeMode: (mode: Panel.ThemeMode): Promise<void> =>
    ipcRenderer.invoke("app:set-theme-mode", mode),
  openAppDevTools: (): Promise<void> => ipcRenderer.invoke("app:open-devtools"),
  getPanelPreloadPath: (): Promise<string> => ipcRenderer.invoke("app:get-panel-preload-path"),
  clearBuildCache: (): Promise<void> => ipcRenderer.invoke("app:clear-build-cache"),

  // Panel methods
  getPanelTree: (): Promise<Panel.Panel[]> => ipcRenderer.invoke("panel:get-tree"),
  notifyPanelFocused: (panelId: string): Promise<void> =>
    ipcRenderer.invoke("panel:notify-focus", panelId),
  updatePanelTheme: (theme: Panel.ThemeAppearance): Promise<void> =>
    ipcRenderer.invoke("panel:update-theme", theme),
  openPanelDevTools: (panelId: string): Promise<void> =>
    ipcRenderer.invoke("panel:open-devtools", panelId),

  // Event listeners (one-way events from main)
  onSystemThemeChanged: (callback: (theme: Panel.ThemeMode) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, theme: Panel.ThemeMode) => {
      callback(theme);
    };
    ipcRenderer.on("system-theme-changed", listener);
    return () => {
      ipcRenderer.removeListener("system-theme-changed", listener);
    };
  },

  onPanelTreeUpdated: (callback: (rootPanels: Panel.Panel[]) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, rootPanels: Panel.Panel[]) => {
      callback(rootPanels);
    };
    ipcRenderer.on("panel:tree-updated", listener);
    return () => {
      ipcRenderer.removeListener("panel:tree-updated", listener);
    };
  },

  // =============================================================================
  // Workspace Chooser Methods
  // =============================================================================

  // App mode
  getAppMode: (): Promise<Panel.AppMode> => ipcRenderer.invoke("app:get-mode"),

  // Recent workspaces
  getRecentWorkspaces: (): Promise<Panel.RecentWorkspace[]> =>
    ipcRenderer.invoke("central:get-recent-workspaces"),
  removeRecentWorkspace: (path: string): Promise<void> =>
    ipcRenderer.invoke("central:remove-recent-workspace", path),

  // Workspace management
  validateWorkspacePath: (path: string): Promise<Panel.WorkspaceValidation> =>
    ipcRenderer.invoke("workspace:validate-path", path),
  openFolderDialog: (): Promise<string | null> =>
    ipcRenderer.invoke("workspace:open-folder-dialog"),
  createWorkspace: (path: string, name: string): Promise<Panel.WorkspaceValidation> =>
    ipcRenderer.invoke("workspace:create", path, name),
  selectWorkspace: (path: string): Promise<void> => ipcRenderer.invoke("workspace:select", path),

  // =============================================================================
  // Settings Methods
  // =============================================================================

  getSettingsData: (): Promise<Panel.SettingsData> => ipcRenderer.invoke("settings:get-data"),
  setApiKey: (providerId: string, apiKey: string): Promise<void> =>
    ipcRenderer.invoke("settings:set-api-key", providerId, apiKey),
  removeApiKey: (providerId: string): Promise<void> =>
    ipcRenderer.invoke("settings:remove-api-key", providerId),
  setModelRole: (role: string, modelSpec: string): Promise<void> =>
    ipcRenderer.invoke("settings:set-model-role", role, modelSpec),
  enableProvider: (providerId: string): Promise<void> =>
    ipcRenderer.invoke("settings:enable-provider", providerId),
  disableProvider: (providerId: string): Promise<void> =>
    ipcRenderer.invoke("settings:disable-provider", providerId),

  // Settings menu event
  onOpenSettings: (callback: () => void): (() => void) => {
    const listener = () => {
      callback();
    };
    ipcRenderer.on("open-settings", listener);
    return () => {
      ipcRenderer.removeListener("open-settings", listener);
    };
  },

  // Workspace chooser menu event
  onOpenWorkspaceChooser: (callback: () => void): (() => void) => {
    const listener = () => {
      callback();
    };
    ipcRenderer.on("open-workspace-chooser", listener);
    return () => {
      ipcRenderer.removeListener("open-workspace-chooser", listener);
    };
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);

declare global {
  interface Window {
    electronAPI: typeof electronAPI;
  }
}
