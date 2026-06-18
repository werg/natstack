/**
 * Shell Client - Typed wrappers for shell service calls via RPC.
 *
 * This module provides a typed API for shell to call main process services.
 * Uses a direct @workspace/rpc bridge from the shell transport global.
 */
import {
  createRpcClient,
  envelopeFromMessage,
  type EnvelopeRpcTransport,
  type RpcClient,
  type RpcEnvelope,
  type RpcEventContext,
} from "@natstack/rpc";
import { RPC_METHODS } from "@natstack/shared/approvalContract";
import { appMethods } from "@natstack/shared/serviceSchemas/app";
import { eventsMethods } from "@natstack/shared/serviceSchemas/events";
import { menuMethods } from "@natstack/shared/serviceSchemas/menu";
import { notificationMethods } from "@natstack/shared/serviceSchemas/notification";
import { panelMethods } from "@natstack/shared/serviceSchemas/panel";
import { remoteCredMethods } from "@natstack/shared/serviceSchemas/remoteCred";
import { settingsMethods } from "@natstack/shared/serviceSchemas/settings";
import { shellApprovalMethods } from "@natstack/shared/serviceSchemas/shellApproval";
import { autofillMethods } from "@natstack/shared/serviceSchemas/autofill";
import { tokensMethods } from "@natstack/shared/serviceSchemas/tokens";
import { viewMethods } from "@natstack/shared/serviceSchemas/view";
import { workspaceMethods } from "@natstack/shared/serviceSchemas/workspace";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
// Type for the shell transport bridge injected by the preload script
type ShellTransportBridge = {
  send: (targetId: string, message: unknown) => Promise<void>;
  onMessage: (handler: (fromId: string, message: unknown) => void) => () => void;
};
type IncomingPairLinkBridge = {
  getPending: () => Promise<{ url: string; code: string } | null>;
  onLink: (handler: (link: { url: string; code: string }) => void) => () => void;
};
const g = globalThis as unknown as {
  __natstackTransport?: ShellTransportBridge;
  __natstackIncomingPairLink?: IncomingPairLinkBridge;
};
if (!g.__natstackTransport) throw new Error("Shell transport not available");
const transport: EnvelopeRpcTransport = {
  send: (envelope) => assertPresent(g.__natstackTransport).send(envelope.target, envelope.message),
  onMessage: (handler) =>
    assertPresent(g.__natstackTransport).onMessage((fromId, message) => {
      handler(
        envelopeFromMessage({
          selfId: "shell",
          from: fromId,
          target: "shell",
          callerKind: fromId === "main" ? "server" : "unknown",
          message: message as RpcEnvelope["message"],
        })
      );
    }),
  status: () => "connected",
  ready: () => Promise.resolve(),
  onStatusChange: () => () => {},
};
const rpc: RpcClient = createRpcClient({
  selfId: "shell",
  callerKind: "shell",
  transport,
});
const shellApprovalClient = createTypedServiceClient(
  "shellApproval",
  shellApprovalMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const appClient = createTypedServiceClient("app", appMethods, (service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
const eventsClient = createTypedServiceClient("events", eventsMethods, (service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
const menuClient = createTypedServiceClient("menu", menuMethods, (service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
const panelClient = createTypedServiceClient("panel", panelMethods, (service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
const notificationClient = createTypedServiceClient(
  "notification",
  notificationMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const remoteCredClient = createTypedServiceClient(
  "remoteCred",
  remoteCredMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const autofillClient = createTypedServiceClient(
  "autofill",
  autofillMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const settingsClient = createTypedServiceClient(
  "settings",
  settingsMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
const tokensClient = createTypedServiceClient("tokens", tokensMethods, (service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
const viewClient = createTypedServiceClient("view", viewMethods, (service, method, args) =>
  rpc.call("main", `${service}.${method}`, args)
);
const workspaceClient = createTypedServiceClient(
  "workspace",
  workspaceMethods,
  (service, method, args) => rpc.call("main", `${service}.${method}`, args)
);
import type {
  AppInfo,
  ThemeMode,
  ThemeAppearance,
  Panel,
  PanelContextMenuAction,
  PanelFocusResult,
  PanelTreeSnapshot,
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
import type { BrowserNavigationIntent } from "@natstack/shared/panelCommands";
import type { PanelLifecycleResult } from "@natstack/shared/types";
import type {
  HostTarget,
  HostTargetCandidate,
  HostTargetSelection,
  HostTargetSelectionInput,
} from "@natstack/shared/hostTargets";
// =============================================================================
// App Service
// =============================================================================
export const app = {
  getInfo: () => appClient.getInfo(),
  getSystemTheme: () => appClient.getSystemTheme(),
  setThemeMode: (mode: ThemeMode) => appClient.setThemeMode(mode),
  openDevTools: () => appClient.openDevTools(),
  openExternal: (url: string) => appClient.openExternal(url),
  clearBuildCache: () => appClient.clearBuildCache(),
  applyUpdate: (appId: string) => appClient.applyUpdate(appId),
  listPendingUpdates: () => appClient.listPendingUpdates(),
};
// =============================================================================
// Panel Service
// =============================================================================
export const panel = {
  getTree: () => panelClient.getTree(),
  getTreeSnapshot: () => panelClient.getTreeSnapshot(),
  getFocusedPanelId: () => panelClient.getFocusedPanelId(),
  notifyFocused: (panelId: string) => panelClient.notifyFocused(panelId),
  updateTheme: (theme: ThemeAppearance) => panelClient.updateTheme(theme),
  openDevTools: (panelId: string) => panelClient.openDevTools(panelId),
  getChromeState: (panelId: string) => panelClient.getChromeState(panelId),
  getRuntimeLease: (panelId: string) => panelClient.getRuntimeLease(panelId),
  takeOver: (panelId: string) => panelClient.takeOver(panelId),
  getAddressOptions: (source: string, ref?: string) => panelClient.getAddressOptions(source, ref),
  getBrowserAddressOptions: (query: string) => panelClient.getBrowserAddressOptions(query),
  markBrowserNavigationIntent: (panelId: string, intent: BrowserNavigationIntent) =>
    panelClient.markBrowserNavigationIntent(panelId, intent),
  reload: (panelId: string) => panelClient.reload(panelId),
  reloadView: (panelId: string) => panelClient.reloadView(panelId),
  forceReloadView: (panelId: string) => panelClient.forceReloadView(panelId),
  rebuildPanel: (panelId: string) => panelClient.rebuildPanel(panelId),
  rebuildAndReload: (panelId: string) => panelClient.rebuildAndReload(panelId),
  goBack: (panelId: string) => panelClient.goBack(panelId),
  goForward: (panelId: string) => panelClient.goForward(panelId),
  unload: (panelId: string) => panelClient.unload(panelId),
  archive: (panelId: string) => panelClient.archive(panelId),
  updatePanelState: (
    panelId: string,
    state: {
      url?: string;
      pageTitle?: string;
      isLoading?: boolean;
      canGoBack?: boolean;
      canGoForward?: boolean;
    }
  ) => panelClient.updatePanelState(panelId, state),
  createAboutPanel: (page: string) => panelClient.createAboutPanel(page),
  /** Create a panel from any source path (not prefixed with "about/"). */
  navigate: (
    panelId: string,
    source: string,
    options?: {
      ref?: string;
      contextId?: string;
      stateArgs?: Record<string, unknown>;
    }
  ) => panelClient.navigate(panelId, source, options),
  createPanel: (
    source: string,
    options?: {
      name?: string;
      isRoot?: boolean;
      ref?: string;
    }
  ) => panelClient.create(source, options),
  createChild: (
    parentId: string,
    source: string,
    options?: {
      name?: string;
      focus?: boolean;
      ref?: string;
    }
  ) => panelClient.createChild(parentId, source, options),
  createBrowser: (
    url: string,
    options?: {
      name?: string;
      focus?: boolean;
    }
  ) => panelClient.createBrowser(url, options),
  createBrowserChild: (
    parentId: string,
    url: string,
    options?: {
      name?: string;
      focus?: boolean;
    }
  ) => panelClient.createBrowserChild(parentId, url, options),
  movePanel: (request: MovePanelRequest) => panelClient.movePanel(request),
  getChildrenPaginated: (request: GetChildrenPaginatedRequest) =>
    panelClient.getChildrenPaginated(request),
  getRootPanelsPaginated: (offset: number, limit: number) =>
    panelClient.getRootPanelsPaginated({ offset, limit }),
  getCollapsedIds: () => panelClient.getCollapsedIds(),
  setCollapsed: (panelId: string, collapsed: boolean) =>
    panelClient.setCollapsed(panelId, collapsed),
  expandIds: (panelIds: string[]) => panelClient.expandIds(panelIds),
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
export interface ShellOverlayRow {
  label: string;
  meta?: string;
  labelRanges?: Array<{ start: number; end: number }>;
  metaRanges?: Array<{ start: number; end: number }>;
  icon?: string;
  selected?: boolean;
  type: string;
  payload?: unknown;
}
export interface NativeShellOverlayOptions {
  id: string;
  rows: ShellOverlayRow[];
  empty: string;
  bounds: Bounds;
  focus?: boolean;
}
export interface NativeShellOverlayEvent {
  overlayId: string;
  type: string;
  payload?: unknown;
}
export interface NativePanelSlotBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type NativePanelSlotSyncResult =
  | { status: "bound" | "updated" }
  | { status: "missing"; reason: string };
type NativeShellOverlayBridge = {
  on: (handler: (event: NativeShellOverlayEvent) => void) => () => void;
};
export const view = {
  forwardMouseClick: (viewId: string, point: { x: number; y: number }) =>
    viewClient.forwardMouseClick(viewId, point),
  setThemeCss: (css: string) => viewClient.setThemeCss(css),
  bindNativePanelSlot: (request: {
    nativeSlotId: string;
    panelId: string;
    bounds: NativePanelSlotBounds;
    focused?: boolean;
  }) => viewClient.bindNativePanelSlot(request),
  updateNativePanelSlot: (request: {
    nativeSlotId: string;
    bounds?: NativePanelSlotBounds;
    focused?: boolean;
  }) => viewClient.updateNativePanelSlot(request),
  clearNativePanelSlot: (request: { nativeSlotId: string }) =>
    viewClient.clearNativePanelSlot(request),
  setHostedShellReady: (request: { ready: boolean }) => viewClient.setHostedShellReady(request),
  setShellOverlay: (active: boolean) => viewClient.setShellOverlay(active),
  showNativeShellOverlay: (options: NativeShellOverlayOptions) =>
    viewClient.showNativeShellOverlay(options),
  updateNativeShellOverlay: (
    options: Partial<NativeShellOverlayOptions> & {
      id?: string;
    }
  ) => viewClient.updateNativeShellOverlay(options),
  hideNativeShellOverlay: (id?: string) => viewClient.hideNativeShellOverlay(id),
  browserNavigate: (browserId: string, url: string) => viewClient.browserNavigate(browserId, url),
  browserGoBack: (browserId: string) => viewClient.browserGoBack(browserId),
  browserGoForward: (browserId: string) => viewClient.browserGoForward(browserId),
  browserReload: (browserId: string) => viewClient.browserReload(browserId),
  browserForceReload: (browserId: string) => viewClient.browserForceReload(browserId),
  browserStop: (browserId: string) => viewClient.browserStop(browserId),
};
export const nativeShellOverlay = {
  on: (handler: (event: NativeShellOverlayEvent) => void) => {
    const bridge = (
      globalThis as unknown as {
        __natstackShellOverlay?: NativeShellOverlayBridge;
      }
    ).__natstackShellOverlay;
    if (!bridge) return () => {};
    return bridge.on(handler);
  },
};
export const incomingPairLink = {
  getPending: () => g.__natstackIncomingPairLink?.getPending() ?? Promise.resolve(null),
  onLink: (handler: (link: { url: string; code: string }) => void) =>
    g.__natstackIncomingPairLink?.onLink(handler) ?? (() => {}),
};
// =============================================================================
// Menu Service
// =============================================================================
interface Position {
  x: number;
  y: number;
}
export const menu = {
  showHamburger: (position: Position) => menuClient.showHamburger(position),
  showContext: (items: Array<{ id: string; label: string }>, position: Position) =>
    menuClient.showContext(items, position),
  showPanelContext: (panelId: string, position: Position) =>
    menuClient.showPanelContext(panelId, position),
};
// =============================================================================
// Workspace Service
// =============================================================================
export const workspace = {
  list: () => workspaceClient.list(),
  create: (
    name: string,
    opts?: {
      forkFrom?: string;
    }
  ) => workspaceClient.create(name, opts),
  select: (name: string) => workspaceClient.select(name),
  delete: (name: string) => workspaceClient.delete(name),
  getActive: () => workspaceClient.getActive(),
  hostTargets: {
    list: (target: HostTarget) => workspaceClient.hostTargets.list(target),
    getSelection: (target: HostTarget) => workspaceClient.hostTargets.getSelection(target),
    setSelection: (target: HostTarget, input: HostTargetSelectionInput) =>
      workspaceClient.hostTargets.setSelection(target, input),
    clearSelection: (target: HostTarget) => workspaceClient.hostTargets.clearSelection(target),
    versions: (target: HostTarget, sourceOrName: string) =>
      workspaceClient.hostTargets.versions(target, sourceOrName),
    preparePinnedRef: (target: HostTarget, sourceOrName: string, ref: string) =>
      workspaceClient.hostTargets.preparePinnedRef(target, sourceOrName, ref),
    launch: (target: HostTarget) => workspaceClient.hostTargets.launch(target),
  },
};
// =============================================================================
// Settings Service
// =============================================================================
export const settings = {
  getData: () => settingsClient.getData(),
};
// =============================================================================
// Remote credential store
// =============================================================================
export interface RemoteCredCurrent {
  configured: boolean;
  isActive: boolean;
  bootstrap: "device" | "admin-token" | "hybrid" | "none";
  url?: string;
  caPath?: string;
  fingerprint?: string;
  tokenPreview?: string;
  deviceId?: string;
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
export interface ExchangePairingCodeArgs {
  url: string;
  code: string;
  caPath?: string;
  fingerprint?: string;
  label?: string;
}
export interface DeviceRecord {
  deviceId: string;
  label: string;
  platform?: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
}
export interface PairingInvite {
  code: string;
  deepLink: string | null;
  connectUrl: string;
  serverUrl: string;
  publicUrl?: string | null;
  expiresAt: number;
  expiresInMs: number;
  serverId: string;
  serverBootId: string;
  workspaceId: string;
}
export interface DiscoveredServer {
  url: string;
  hostname: string;
  serverId?: string;
  workspaceId?: string;
  discoveryVersion: number;
}
export const remoteCred = {
  getCurrent: () => remoteCredClient.getCurrent(),
  save: (args: RemoteCredSaveArgs) => remoteCredClient.save(args),
  testConnection: (args: RemoteCredSaveArgs) => remoteCredClient.testConnection(args),
  exchangePairingCode: (args: ExchangePairingCodeArgs) =>
    remoteCredClient.exchangePairingCode(args),
  discoverServers: () => remoteCredClient.discoverServers(),
  createPairingInvite: (args?: { ttlMs?: number }) => remoteCredClient.createPairingInvite(args),
  listDevices: () => remoteCredClient.listDevices(),
  revokeDevice: (deviceId: string) => remoteCredClient.revokeDevice(deviceId),
  fetchPeerFingerprint: (url: string) => remoteCredClient.fetchPeerFingerprint(url),
  pickCaFile: () => remoteCredClient.pickCaFile(),
  clear: () => remoteCredClient.clear(),
  relaunch: () => remoteCredClient.relaunch(),
};
// =============================================================================
// Token rotation
// =============================================================================
export const tokens = {
  rotateAdmin: () => tokensClient.rotateAdmin(),
};
// =============================================================================
// Autofill Service
// =============================================================================
export const autofill = {
  confirmSave: (panelId: string, action: "save" | "never" | "dismiss") =>
    autofillClient.confirmSave(panelId, action),
};
// =============================================================================
// Events Service
// =============================================================================
// Re-export event types from shared module
export type { EventName, EventPayloads } from "@natstack/shared/events";
import type { EventName } from "@natstack/shared/events";
export const events = {
  subscribe: (event: EventName) => eventsClient.subscribe(event),
  unsubscribe: (event: EventName) => eventsClient.unsubscribe(event),
  unsubscribeAll: () => eventsClient.unsubscribeAll(),
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
  ) => notificationClient.show(opts),
  reportAction: (id: string, actionId: string) => notificationClient.reportAction(id, actionId),
  dismiss: (id: string) => notificationClient.dismiss(id),
};
// =============================================================================
// Workspace Unit Service
// =============================================================================
export const workspaceUnits = {
  list: () => workspaceClient.units.list(),
  versions: (name: string) => workspaceClient.units.versions(name),
  rollback: (name: string, opts?: { buildKey?: string }) =>
    workspaceClient.units.rollback(name, opts),
  restart: (name: string) => workspaceClient.units.restart(name),
  logs: (
    name: string,
    opts?: { since?: number; level?: "debug" | "info" | "warn" | "error"; limit?: number }
  ) => workspaceClient.units.logs(name, opts),
};
// =============================================================================
// Shell Approval Service (consent approval queue)
// =============================================================================
import type { ApprovalDecision } from "@natstack/shared/approvals";
import { assertPresent } from "../utils/assertPresent";
export const shellApproval = {
  resolve: (approvalId: string, decision: ApprovalDecision) =>
    shellApprovalClient.resolve(approvalId, decision),
  resolveBootstrap: (approvalId: string, decision: Extract<ApprovalDecision, "once" | "deny">) =>
    shellApprovalClient.resolveBootstrap(approvalId, decision),
  resolveUserland: (approvalId: string, choice: string | "dismiss") =>
    shellApprovalClient.resolveUserland(approvalId, choice),
  submitClientConfig: (approvalId: string, values: Record<string, string>) =>
    shellApprovalClient.submitClientConfig(approvalId, values),
  submitCredentialInput: (approvalId: string, values: Record<string, string>) =>
    shellApprovalClient.submitCredentialInput(approvalId, values),
  listPending: () => shellApprovalClient.listPending(),
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
export const onRpcEvent = (
  event: string,
  listener: (event: RpcEventContext) => void
): (() => void) => rpc.on(event, listener);
