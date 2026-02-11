/**
 * Shell Client - Typed wrappers for shell service calls via RPC.
 *
 * This module provides a typed API for shell to call main process services.
 * Uses the RPC bridge from @natstack/runtime which auto-initializes for shell.
 */

import { rpc } from "@natstack/runtime";
import type {
  AppInfo,
  ThemeMode,
  ThemeAppearance,
  Panel,
  PanelType,
  PanelContextMenuAction,
  BrowserState,
  RecentWorkspace,
  WorkspaceValidation,
  SettingsData,
  AppMode,
  ShellPage,
  MovePanelRequest,
  GetChildrenPaginatedRequest,
  PaginatedChildren,
  PaginatedRootPanels,
} from "../../shared/types.js";

// =============================================================================
// App Service
// =============================================================================

export const app = {
  getInfo: () => rpc.call<AppInfo>("main", "app.getInfo"),
  getSystemTheme: () => rpc.call<ThemeAppearance>("main", "app.getSystemTheme"),
  setThemeMode: (mode: ThemeMode) => rpc.call<void>("main", "app.setThemeMode", mode),
  openDevTools: () => rpc.call<void>("main", "app.openDevTools"),
  getMode: () => rpc.call<AppMode>("main", "app.getMode"),
  clearBuildCache: () => rpc.call<void>("main", "app.clearBuildCache"),
};

// =============================================================================
// Panel Service
// =============================================================================

export const panel = {
  getTree: () => rpc.call<Panel[]>("main", "panel.getTree"),
  notifyFocused: (panelId: string) => rpc.call<void>("main", "panel.notifyFocused", panelId),
  updateTheme: (theme: ThemeAppearance) => rpc.call<void>("main", "panel.updateTheme", theme),
  openDevTools: (panelId: string) => rpc.call<void>("main", "panel.openDevTools", panelId),
  reload: (panelId: string) => rpc.call<void>("main", "panel.reload", panelId),
  unload: (panelId: string) => rpc.call<void>("main", "panel.unload", panelId),
  archive: (panelId: string) => rpc.call<void>("main", "panel.archive", panelId),
  retryDirtyBuild: (panelId: string) => rpc.call<void>("main", "panel.retryDirtyBuild", panelId),
  initGitRepo: (panelId: string) => rpc.call<void>("main", "panel.initGitRepo", panelId),
  updateBrowserState: (browserId: string, state: Partial<BrowserState> & { url?: string }) =>
    rpc.call<void>("main", "panel.updateBrowserState", browserId, state),
  createShellPanel: (page: ShellPage) =>
    rpc.call<{ id: string; type: PanelType; title: string }>("main", "panel.createShellPanel", page),
  // Drag-and-drop and tree management
  movePanel: (request: MovePanelRequest) =>
    rpc.call<void>("main", "panel.movePanel", request),
  getChildrenPaginated: (request: GetChildrenPaginatedRequest) =>
    rpc.call<PaginatedChildren>("main", "panel.getChildrenPaginated", request),
  getRootPanelsPaginated: (offset: number, limit: number) =>
    rpc.call<PaginatedRootPanels>("main", "panel.getRootPanelsPaginated", { offset, limit }),
  // Collapse state persistence
  getCollapsedIds: () =>
    rpc.call<string[]>("main", "panel.getCollapsedIds"),
  setCollapsed: (panelId: string, collapsed: boolean) =>
    rpc.call<void>("main", "panel.setCollapsed", panelId, collapsed),
  expandIds: (panelIds: string[]) =>
    rpc.call<void>("main", "panel.expandIds", panelIds),
};

// =============================================================================
// View Service
// =============================================================================

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const view = {
  setVisible: (viewId: string, visible: boolean) =>
    rpc.call<void>("main", "view.setVisible", viewId, visible),
  setThemeCss: (css: string) => rpc.call<void>("main", "view.setThemeCss", css),
  updateLayout: (layout: { titleBarHeight?: number; sidebarVisible?: boolean; sidebarWidth?: number }) =>
    rpc.call<void>("main", "view.updateLayout", layout),
  browserNavigate: (browserId: string, url: string) =>
    rpc.call<void>("main", "view.browserNavigate", browserId, url),
  browserGoBack: (browserId: string) => rpc.call<void>("main", "view.browserGoBack", browserId),
  browserGoForward: (browserId: string) =>
    rpc.call<void>("main", "view.browserGoForward", browserId),
  browserReload: (browserId: string) => rpc.call<void>("main", "view.browserReload", browserId),
  browserStop: (browserId: string) => rpc.call<void>("main", "view.browserStop", browserId),
};

// =============================================================================
// Menu Service
// =============================================================================

interface Position {
  x: number;
  y: number;
}

interface MenuItem {
  id: string;
  label: string;
}

export const menu = {
  showHamburger: (position: Position) =>
    rpc.call<void>("main", "menu.showHamburger", position),
  showContext: (items: MenuItem[], position: Position) =>
    rpc.call<string | null>("main", "menu.showContext", items, position),
  showPanelContext: (panelId: string, panelType: PanelType, position: Position) =>
    rpc.call<PanelContextMenuAction | null>("main", "menu.showPanelContext", panelId, panelType, position),
};

// =============================================================================
// Workspace Service
// =============================================================================

export const workspace = {
  validatePath: (path: string) =>
    rpc.call<WorkspaceValidation>("main", "workspace.validatePath", path),
  openFolderDialog: () => rpc.call<string | null>("main", "workspace.openFolderDialog"),
  create: (path: string, name: string) =>
    rpc.call<WorkspaceValidation>("main", "workspace.create", path, name),
  select: (path: string) => rpc.call<void>("main", "workspace.select", path),
};

// =============================================================================
// Central Service (recent workspaces)
// =============================================================================

export const central = {
  getRecentWorkspaces: () => rpc.call<RecentWorkspace[]>("main", "central.getRecentWorkspaces"),
  addRecentWorkspace: (path: string) =>
    rpc.call<void>("main", "central.addRecentWorkspace", path),
  removeRecentWorkspace: (path: string) =>
    rpc.call<void>("main", "central.removeRecentWorkspace", path),
};

// =============================================================================
// Settings Service
// =============================================================================

export const settings = {
  getData: () => rpc.call<SettingsData>("main", "settings.getData"),
  setApiKey: (providerId: string, apiKey: string) =>
    rpc.call<void>("main", "settings.setApiKey", providerId, apiKey),
  removeApiKey: (providerId: string) =>
    rpc.call<void>("main", "settings.removeApiKey", providerId),
  setModelRole: (role: string, modelSpec: string) =>
    rpc.call<void>("main", "settings.setModelRole", role, modelSpec),
  enableProvider: (providerId: string) =>
    rpc.call<void>("main", "settings.enableProvider", providerId),
  disableProvider: (providerId: string) =>
    rpc.call<void>("main", "settings.disableProvider", providerId),
};

// =============================================================================
// Events Service
// =============================================================================

// Re-export event types from shared module
export type { EventName, EventPayloads } from "../../shared/events.js";
import type { EventName } from "../../shared/events.js";

export const events = {
  subscribe: (event: EventName) => rpc.call<void>("main", "events.subscribe", event),
  unsubscribe: (event: EventName) => rpc.call<void>("main", "events.unsubscribe", event),
  unsubscribeAll: () => rpc.call<void>("main", "events.unsubscribeAll"),
};

// =============================================================================
// RPC Event Listener (for useShellEvent hook)
// =============================================================================

/**
 * Register a listener for RPC events.
 * Used by the useShellEvent hook.
 */
export const onRpcEvent = rpc.onEvent.bind(rpc);
