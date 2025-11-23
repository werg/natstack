// Shared types for typed IPC communication

export type ThemeMode = "light" | "dark" | "system";
export type ThemeAppearance = "light" | "dark";

export interface AppInfo {
  version: string;
}

export interface PanelInfo {
  panelId: string;
  partition: string;
}

// Panel-related types (shared between main and renderer)
export interface PanelArtifacts {
  htmlPath?: string;
  bundlePath?: string;
  error?: string;
}

export interface Panel {
  id: string;
  title: string;
  path: string;
  children: Panel[];
  selectedChildId: string | null;
  injectHostThemeVariables: boolean;
  artifacts: PanelArtifacts;
  env?: Record<string, string>;
}

// =============================================================================
// IPC Channel Definitions
// =============================================================================

// App-related IPC channels (renderer <-> main)
export interface AppIpcApi {
  "app:get-info": () => AppInfo;
  "app:get-system-theme": () => ThemeAppearance;
  "app:set-theme-mode": (mode: ThemeMode) => void;
  "app:open-devtools": () => void;
  "app:get-panel-preload-path": () => string;
}

// Panel-related IPC channels (renderer <-> main)
export interface PanelIpcApi {
  "panel:get-tree": () => Panel[];
  "panel:notify-focus": (panelId: string) => void;
  "panel:update-theme": (theme: ThemeAppearance) => void;
  "panel:open-devtools": (panelId: string) => void;
}

// Panel bridge IPC channels (panel webview <-> main)
export interface PanelBridgeIpcApi {
  "panel-bridge:create-child": (
    parentId: string,
    panelPath: string,
    env?: Record<string, string>,
    requestedPanelId?: string
  ) => string;
  "panel-bridge:remove-child": (parentId: string, childId: string) => void;
  "panel-bridge:set-title": (panelId: string, title: string) => void;
  "panel-bridge:close": (panelId: string) => void;
  "panel-bridge:register": (panelId: string, authToken: string) => void;
  "panel-bridge:get-env": (panelId: string) => Record<string, string>;
  "panel-bridge:get-info": (panelId: string) => PanelInfo;

  // Panel-to-panel RPC
  // Request a direct MessagePort connection to another panel
  "panel-rpc:connect": (fromPanelId: string, toPanelId: string) => void;
}

// Combined API for type utilities
export type AllIpcApi = AppIpcApi & PanelIpcApi & PanelBridgeIpcApi;

// =============================================================================
// Type utilities for extracting channel info
// =============================================================================

export type IpcChannel = keyof AllIpcApi;

export type IpcHandler<C extends IpcChannel> = AllIpcApi[C];

export type IpcParams<C extends IpcChannel> = Parameters<AllIpcApi[C]>;

export type IpcReturn<C extends IpcChannel> = ReturnType<AllIpcApi[C]>;
