/**
 * Shell Client - Typed wrappers for shell service calls via RPC.
 *
 * This module provides a typed API for shell to call main process services.
 * Uses a direct @workspace/rpc bridge from the shell transport global.
 */

import { createRpcBridge, type RpcBridge, type RpcTransport, type RpcMessage } from "@natstack/rpc";

// Type for the shell transport bridge injected by the preload script
type ShellTransportBridge = {
  send: (targetId: string, message: unknown) => Promise<void>;
  onMessage: (handler: (fromId: string, message: unknown) => void) => () => void;
};

const g = globalThis as unknown as { __natstackTransport?: ShellTransportBridge };
if (!g.__natstackTransport) throw new Error("Shell transport not available");

const transport: RpcTransport = {
  send: g.__natstackTransport.send,
  onMessage: (_sourceId, handler) =>
    g.__natstackTransport!.onMessage((fromId, msg) => {
      if (fromId === "main") handler(msg as RpcMessage);
    }),
  onAnyMessage: (handler) =>
    g.__natstackTransport!.onMessage((fromId, msg) => handler(fromId, msg as RpcMessage)),
};

const rpc: RpcBridge = createRpcBridge({
  selfId: "shell",
  transport,
});

import type {
  AppInfo,
  ThemeMode,
  ThemeAppearance,
  Panel,
  PanelContextMenuAction,
  WorkspaceEntry,
  SettingsData,
  MovePanelRequest,
  GetChildrenPaginatedRequest,
  PaginatedChildren,
  PaginatedRootPanels,
} from "@natstack/shared/types";

// =============================================================================
// App Service
// =============================================================================

export const app = {
  getInfo: () => rpc.call<AppInfo>("main", "app.getInfo"),
  getSystemTheme: () => rpc.call<ThemeAppearance>("main", "app.getSystemTheme"),
  setThemeMode: (mode: ThemeMode) => rpc.call<void>("main", "app.setThemeMode", mode),
  openDevTools: () => rpc.call<void>("main", "app.openDevTools"),
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
  updatePanelState: (panelId: string, state: { url?: string; pageTitle?: string; isLoading?: boolean; canGoBack?: boolean; canGoForward?: boolean }) =>
    rpc.call<void>("main", "panel.updatePanelState", panelId, state),
  createAboutPanel: (page: string) =>
    rpc.call<{ id: string; title: string }>("main", "panel.createAboutPanel", page),
  /** Create a panel from any source path (not prefixed with "about/"). */
  createPanel: (source: string, options?: { name?: string; isRoot?: boolean }) =>
    rpc.call<{ id: string; title: string }>("main", "panel.create", source, options),
  movePanel: (request: MovePanelRequest) =>
    rpc.call<void>("main", "panel.movePanel", request),
  getChildrenPaginated: (request: GetChildrenPaginatedRequest) =>
    rpc.call<PaginatedChildren>("main", "panel.getChildrenPaginated", request),
  getRootPanelsPaginated: (offset: number, limit: number) =>
    rpc.call<PaginatedRootPanels>("main", "panel.getRootPanelsPaginated", { offset, limit }),
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
  updateLayout: (layout: { titleBarHeight?: number; sidebarVisible?: boolean; sidebarWidth?: number; saveBarHeight?: number; notificationBarHeight?: number; consentBarHeight?: number }) =>
    rpc.call<void>("main", "view.updateLayout", layout),
  setShellOverlay: (active: boolean) =>
    rpc.call<void>("main", "view.setShellOverlay", active),
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
  showPanelContext: (panelId: string, position: Position) =>
    rpc.call<PanelContextMenuAction | null>("main", "menu.showPanelContext", panelId, position),
};

// =============================================================================
// Workspace Service
// =============================================================================

export const workspace = {
  list: () => rpc.call<WorkspaceEntry[]>("main", "workspace.list"),
  create: (name: string, opts?: { forkFrom?: string }) =>
    rpc.call<WorkspaceEntry>("main", "workspace.create", name, opts),
  select: (name: string) => rpc.call<void>("main", "workspace.select", name),
  delete: (name: string) => rpc.call<void>("main", "workspace.delete", name),
  getActive: () => rpc.call<string>("main", "workspace.getActive"),
};

// =============================================================================
// Settings Service
// =============================================================================

export const settings = {
  getData: () => rpc.call<SettingsData>("main", "settings.getData"),
};

// =============================================================================
// Remote credential store
// =============================================================================

export interface RemoteCredCurrent {
  configured: boolean;
  isActive: boolean;
  url?: string;
  caPath?: string;
  fingerprint?: string;
  tokenPreview?: string;
}

export interface RemoteCredSaveArgs {
  url: string;
  token: string;
  caPath?: string;
  fingerprint?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  error?: "invalid-url" | "unreachable" | "tls-mismatch" | "unauthorized" | "unknown";
  message?: string;
  observedFingerprint?: string;
  serverVersion?: string;
}

export const remoteCred = {
  getCurrent: () => rpc.call<RemoteCredCurrent>("main", "remoteCred.getCurrent"),
  save: (args: RemoteCredSaveArgs) =>
    rpc.call<{ ok: boolean }>("main", "remoteCred.save", args),
  testConnection: (args: RemoteCredSaveArgs) =>
    rpc.call<TestConnectionResult>("main", "remoteCred.testConnection", args),
  fetchPeerFingerprint: (url: string) =>
    rpc.call<string>("main", "remoteCred.fetchPeerFingerprint", url),
  pickCaFile: () =>
    rpc.call<string | null>("main", "remoteCred.pickCaFile"),
  clear: () => rpc.call<{ ok: boolean }>("main", "remoteCred.clear"),
  relaunch: () => rpc.call<{ ok: boolean }>("main", "remoteCred.relaunch"),
};

// =============================================================================
// Token rotation
// =============================================================================

export const tokens = {
  rotateAdmin: () => rpc.call<string>("main", "tokens.rotateAdmin"),
};

// =============================================================================
// Autofill Service
// =============================================================================

export const autofill = {
  confirmSave: (panelId: string, action: "save" | "never" | "dismiss") =>
    rpc.call<void>("main", "autofill.confirmSave", panelId, action),
};

// =============================================================================
// Events Service
// =============================================================================

// Re-export event types from shared module
export type { EventName, EventPayloads } from "@natstack/shared/events";
import type { EventName } from "@natstack/shared/events";

export const events = {
  subscribe: (event: EventName) => rpc.call<void>("main", "events.subscribe", event),
  unsubscribe: (event: EventName) => rpc.call<void>("main", "events.unsubscribe", event),
  unsubscribeAll: () => rpc.call<void>("main", "events.unsubscribeAll"),
};

// =============================================================================
// Notification Service
// =============================================================================

import type { NotificationPayload } from "@natstack/shared/events";

export const notification = {
  show: (opts: Omit<NotificationPayload, "id"> & { id?: string }) =>
    rpc.call<string>("main", "notification.show", opts),
  reportAction: (id: string, actionId: string) =>
    rpc.call<void>("main", "notification.reportAction", id, actionId),
  dismiss: (id: string) =>
    rpc.call<void>("main", "notification.dismiss", id),
};

// =============================================================================
// Shell Approval Service (consent approval queue)
// =============================================================================

import type { ApprovalDecision, PendingApproval } from "@natstack/shared/approvals";

export const shellApproval = {
  resolve: (approvalId: string, decision: ApprovalDecision) =>
    rpc.call<void>("main", "shellApproval.resolve", approvalId, decision),
  submitOAuthClientConfig: (approvalId: string, values: Record<string, string>) =>
    rpc.call("main", "shellApproval.submitOAuthClientConfig", approvalId, values) as Promise<void>,
  listPending: () => rpc.call<PendingApproval[]>("main", "shellApproval.listPending"),
};

// =============================================================================
// RPC Event Listener (for useShellEvent hook)
// =============================================================================

/**
 * Register a listener for RPC events.
 * Used by the useShellEvent hook.
 */
export const onRpcEvent = rpc.onEvent.bind(rpc);
