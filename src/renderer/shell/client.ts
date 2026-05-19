/**
 * Shell Client - Typed wrappers for shell service calls via RPC.
 *
 * This module provides a typed API for shell to call main process services.
 * Uses a direct @workspace/rpc bridge from the shell transport global.
 */
import { createRpcBridge, type RpcBridge, type RpcTransport, type RpcMessage } from "@natstack/rpc";
import { RPC_METHODS } from "@natstack/shared/approvalContract";
// Type for the shell transport bridge injected by the preload script
type ShellTransportBridge = {
  send: (targetId: string, message: unknown) => Promise<void>;
  onMessage: (handler: (fromId: string, message: unknown) => void) => () => void;
};
const g = globalThis as unknown as {
  __natstackTransport?: ShellTransportBridge;
};
if (!g.__natstackTransport) throw new Error("Shell transport not available");
const transport: RpcTransport = {
  send: g.__natstackTransport.send,
  onMessage: (_sourceId, handler) =>
    assertPresent(g.__natstackTransport).onMessage((fromId, msg) => {
      if (fromId === "main") handler(msg as RpcMessage);
    }),
  onAnyMessage: (handler) =>
    assertPresent(g.__natstackTransport).onMessage((fromId, msg) =>
      handler(fromId, msg as RpcMessage)
    ),
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
import type {
  BrowserAddressOptions,
  PanelAddressOptions,
  PanelChromeState,
} from "@natstack/shared/panelChrome";
import type { PanelRuntimeLease } from "@natstack/shared/panel/panelLease";
// =============================================================================
// App Service
// =============================================================================
export const app = {
  getInfo: () => rpc.call<AppInfo>("main", "app.getInfo", []),
  getSystemTheme: () => rpc.call<ThemeAppearance>("main", "app.getSystemTheme", []),
  setThemeMode: (mode: ThemeMode) => rpc.call<undefined>("main", "app.setThemeMode", [mode]),
  openDevTools: () => rpc.call<undefined>("main", "app.openDevTools", []),
  openExternal: (url: string) => rpc.call<undefined>("main", "app.openExternal", [url]),
  clearBuildCache: () => rpc.call<undefined>("main", "app.clearBuildCache", []),
};
// =============================================================================
// Panel Service
// =============================================================================
export const panel = {
  getTree: () => rpc.call<Panel[]>("main", "panel.getTree", []),
  notifyFocused: (panelId: string) => rpc.call<undefined>("main", "panel.notifyFocused", [panelId]),
  updateTheme: (theme: ThemeAppearance) =>
    rpc.call<undefined>("main", "panel.updateTheme", [theme]),
  openDevTools: (panelId: string) => rpc.call<undefined>("main", "panel.openDevTools", [panelId]),
  getChromeState: (panelId: string) =>
    rpc.call<PanelChromeState>("main", "panel.getChromeState", [panelId]),
  getRuntimeLease: (panelId: string) =>
    rpc.call<PanelRuntimeLease | null>("main", "panel.getRuntimeLease", [panelId]),
  takeOver: (panelId: string) => rpc.call<undefined>("main", "panel.takeOver", [panelId]),
  getAddressOptions: (source: string, ref?: string) =>
    rpc.call<PanelAddressOptions>("main", "panel.getAddressOptions", [source, ref]),
  getBrowserAddressOptions: (query: string) =>
    rpc.call<BrowserAddressOptions>("main", "panel.getBrowserAddressOptions", [query]),
  markBrowserNavigationIntent: (
    panelId: string,
    intent: {
      transition?: string;
      typed?: boolean;
    }
  ) => rpc.call<undefined>("main", "panel.markBrowserNavigationIntent", [panelId, intent]),
  reload: (panelId: string) => rpc.call<undefined>("main", "panel.reload", [panelId]),
  reloadView: (panelId: string) => rpc.call<undefined>("main", "panel.reloadView", [panelId]),
  forceReloadView: (panelId: string) =>
    rpc.call<undefined>("main", "panel.forceReloadView", [panelId]),
  rebuildPanel: (panelId: string) => rpc.call<undefined>("main", "panel.rebuildPanel", [panelId]),
  goBack: (panelId: string) => rpc.call<undefined>("main", "panel.goBack", [panelId]),
  goForward: (panelId: string) => rpc.call<undefined>("main", "panel.goForward", [panelId]),
  unload: (panelId: string) => rpc.call<undefined>("main", "panel.unload", [panelId]),
  archive: (panelId: string) => rpc.call<undefined>("main", "panel.archive", [panelId]),
  retryDirtyBuild: (panelId: string) =>
    rpc.call<undefined>("main", "panel.retryDirtyBuild", [panelId]),
  initGitRepo: (panelId: string) => rpc.call<undefined>("main", "panel.initGitRepo", [panelId]),
  updatePanelState: (
    panelId: string,
    state: {
      url?: string;
      pageTitle?: string;
      isLoading?: boolean;
      canGoBack?: boolean;
      canGoForward?: boolean;
    }
  ) => rpc.call<undefined>("main", "panel.updatePanelState", [panelId, state]),
  createAboutPanel: (page: string) =>
    rpc.call<{
      id: string;
      title: string;
    }>("main", "panel.createAboutPanel", [page]),
  /** Create a panel from any source path (not prefixed with "about/"). */
  navigate: (
    panelId: string,
    source: string,
    options?: {
      ref?: string;
      contextId?: string;
      stateArgs?: Record<string, unknown>;
    }
  ) =>
    rpc.call<{
      id: string;
      title: string;
    }>("main", "panel.navigate", [panelId, source, options]),
  createPanel: (
    source: string,
    options?: {
      name?: string;
      isRoot?: boolean;
      ref?: string;
    }
  ) =>
    rpc.call<{
      id: string;
      title: string;
    }>("main", "panel.create", [source, options]),
  createChild: (
    parentId: string,
    source: string,
    options?: {
      name?: string;
      focus?: boolean;
      ref?: string;
    }
  ) =>
    rpc.call<{
      id: string;
      title: string;
    }>("main", "panel.createChild", [parentId, source, options]),
  createBrowser: (
    url: string,
    options?: {
      name?: string;
      focus?: boolean;
    }
  ) =>
    rpc.call<{
      id: string;
      title: string;
    }>("main", "panel.createBrowser", [url, options]),
  createBrowserChild: (
    parentId: string,
    url: string,
    options?: {
      name?: string;
      focus?: boolean;
    }
  ) =>
    rpc.call<{
      id: string;
      title: string;
    }>("main", "panel.createBrowserChild", [parentId, url, options]),
  movePanel: (request: MovePanelRequest) =>
    rpc.call<undefined>("main", "panel.movePanel", [request]),
  getChildrenPaginated: (request: GetChildrenPaginatedRequest) =>
    rpc.call<PaginatedChildren>("main", "panel.getChildrenPaginated", [request]),
  getRootPanelsPaginated: (offset: number, limit: number) =>
    rpc.call<PaginatedRootPanels>("main", "panel.getRootPanelsPaginated", [{ offset, limit }]),
  getCollapsedIds: () => rpc.call<string[]>("main", "panel.getCollapsedIds", []),
  setCollapsed: (panelId: string, collapsed: boolean) =>
    rpc.call<undefined>("main", "panel.setCollapsed", [panelId, collapsed]),
  expandIds: (panelIds: string[]) => rpc.call<undefined>("main", "panel.expandIds", [panelIds]),
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
export interface NativeShellOverlayOptions {
  id: string;
  html: string;
  bounds: Bounds;
  focus?: boolean;
}
export interface NativeShellOverlayEvent {
  overlayId: string;
  type: string;
  payload?: unknown;
}
type NativeShellOverlayBridge = {
  onEvent: (handler: (event: NativeShellOverlayEvent) => void) => () => void;
};
export const view = {
  setVisible: (viewId: string, visible: boolean) =>
    rpc.call<undefined>("main", "view.setVisible", [viewId, visible]),
  setThemeCss: (css: string) => rpc.call<undefined>("main", "view.setThemeCss", [css]),
  updateLayout: (layout: {
    titleBarHeight?: number;
    sidebarVisible?: boolean;
    sidebarWidth?: number;
    saveBarHeight?: number;
    notificationBarHeight?: number;
    consentBarHeight?: number;
  }) => rpc.call<undefined>("main", "view.updateLayout", [layout]),
  setShellOverlay: (active: boolean) =>
    rpc.call<undefined>("main", "view.setShellOverlay", [active]),
  showNativeShellOverlay: (options: NativeShellOverlayOptions) =>
    rpc.call<undefined>("main", "view.showNativeShellOverlay", [options]),
  updateNativeShellOverlay: (
    options: Partial<NativeShellOverlayOptions> & {
      id?: string;
    }
  ) => rpc.call<undefined>("main", "view.updateNativeShellOverlay", [options]),
  hideNativeShellOverlay: (id?: string) =>
    rpc.call<undefined>("main", "view.hideNativeShellOverlay", [id]),
  browserNavigate: (browserId: string, url: string) =>
    rpc.call<undefined>("main", "view.browserNavigate", [browserId, url]),
  browserGoBack: (browserId: string) =>
    rpc.call<undefined>("main", "view.browserGoBack", [browserId]),
  browserGoForward: (browserId: string) =>
    rpc.call<undefined>("main", "view.browserGoForward", [browserId]),
  browserReload: (browserId: string) =>
    rpc.call<undefined>("main", "view.browserReload", [browserId]),
  browserForceReload: (browserId: string) =>
    rpc.call<undefined>("main", "view.browserForceReload", [browserId]),
  browserStop: (browserId: string) => rpc.call<undefined>("main", "view.browserStop", [browserId]),
};
export const nativeShellOverlay = {
  onEvent: (handler: (event: NativeShellOverlayEvent) => void) => {
    const bridge = (
      globalThis as unknown as {
        __natstackShellOverlay?: NativeShellOverlayBridge;
      }
    ).__natstackShellOverlay;
    if (!bridge) return () => {};
    return bridge.onEvent(handler);
  },
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
    rpc.call<undefined>("main", "menu.showHamburger", [position]),
  showContext: (items: MenuItem[], position: Position) =>
    rpc.call<string | null>("main", "menu.showContext", [items, position]),
  showPanelContext: (panelId: string, position: Position) =>
    rpc.call<PanelContextMenuAction | null>("main", "menu.showPanelContext", [panelId, position]),
};
// =============================================================================
// Workspace Service
// =============================================================================
export const workspace = {
  list: () => rpc.call<WorkspaceEntry[]>("main", "workspace.list", []),
  create: (
    name: string,
    opts?: {
      forkFrom?: string;
    }
  ) => rpc.call<WorkspaceEntry>("main", "workspace.create", [name, opts]),
  select: (name: string) => rpc.call<undefined>("main", "workspace.select", [name]),
  delete: (name: string) => rpc.call<undefined>("main", "workspace.delete", [name]),
  getActive: () => rpc.call<string>("main", "workspace.getActive", []),
};
// =============================================================================
// Settings Service
// =============================================================================
export const settings = {
  getData: () => rpc.call<SettingsData>("main", "settings.getData", []),
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
  getCurrent: () => rpc.call<RemoteCredCurrent>("main", "remoteCred.getCurrent", []),
  save: (args: RemoteCredSaveArgs) =>
    rpc.call<{
      ok: boolean;
    }>("main", "remoteCred.save", [args]),
  testConnection: (args: RemoteCredSaveArgs) =>
    rpc.call<TestConnectionResult>("main", "remoteCred.testConnection", [args]),
  fetchPeerFingerprint: (url: string) =>
    rpc.call<string>("main", "remoteCred.fetchPeerFingerprint", [url]),
  pickCaFile: () => rpc.call<string | null>("main", "remoteCred.pickCaFile", []),
  clear: () =>
    rpc.call<{
      ok: boolean;
    }>("main", "remoteCred.clear", []),
  relaunch: () =>
    rpc.call<{
      ok: boolean;
    }>("main", "remoteCred.relaunch", []),
};
// =============================================================================
// Token rotation
// =============================================================================
export const tokens = {
  rotateAdmin: () => rpc.call<string>("main", "tokens.rotateAdmin", []),
};
// =============================================================================
// Autofill Service
// =============================================================================
export const autofill = {
  confirmSave: (panelId: string, action: "save" | "never" | "dismiss") =>
    rpc.call<undefined>("main", "autofill.confirmSave", [panelId, action]),
};
// =============================================================================
// Events Service
// =============================================================================
// Re-export event types from shared module
export type { EventName, EventPayloads } from "@natstack/shared/events";
import type { EventName } from "@natstack/shared/events";
export const events = {
  subscribe: (event: EventName) => rpc.call<undefined>("main", "events.subscribe", [event]),
  unsubscribe: (event: EventName) => rpc.call<undefined>("main", "events.unsubscribe", [event]),
  unsubscribeAll: () => rpc.call<undefined>("main", "events.unsubscribeAll", []),
};
// =============================================================================
// Notification Service
// =============================================================================
import type { NotificationPayload } from "@natstack/shared/events";
export const notification = {
  show: (
    opts: Omit<NotificationPayload, "id"> & {
      id?: string;
    }
  ) => rpc.call<string>("main", "notification.show", [opts]),
  reportAction: (id: string, actionId: string) =>
    rpc.call<undefined>("main", "notification.reportAction", [id, actionId]),
  dismiss: (id: string) => rpc.call<undefined>("main", "notification.dismiss", [id]),
};
// =============================================================================
// Shell Approval Service (consent approval queue)
// =============================================================================
import type { ApprovalDecision, PendingApproval } from "@natstack/shared/approvals";
import { assertPresent } from "../../lintHelpers";
export const shellApproval = {
  resolve: (approvalId: string, decision: ApprovalDecision) =>
    rpc.call<undefined>("main", "shellApproval.resolve", [approvalId, decision]),
  resolveUserland: (approvalId: string, choice: string | "dismiss") =>
    rpc.call<undefined>("main", "shellApproval.resolveUserland", [approvalId, choice]),
  submitClientConfig: (approvalId: string, values: Record<string, string>) =>
    rpc.call("main", "shellApproval.submitClientConfig", [approvalId, values]) as Promise<void>,
  submitCredentialInput: (approvalId: string, values: Record<string, string>) =>
    rpc.call("main", "shellApproval.submitCredentialInput", [approvalId, values]) as Promise<void>,
  listPending: () => rpc.call<PendingApproval[]>("main", "shellApproval.listPending", []),
};
// =============================================================================
// Shell Presence Service
// =============================================================================
export const shellPresence = {
  heartbeat: () => rpc.call<undefined>("main", RPC_METHODS.shellPresence.heartbeat, []),
};
// =============================================================================
// RPC Event Listener (for useShellEvent hook)
// =============================================================================
/**
 * Register a listener for RPC events.
 * Used by the useShellEvent hook.
 */
export const onRpcEvent = rpc.onEvent.bind(rpc);
