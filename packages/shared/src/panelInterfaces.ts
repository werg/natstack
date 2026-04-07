/**
 * Shared cross-boundary interfaces.
 *
 * BridgePanelManager: minimal surface used by bridge handlers (implemented by
 * PanelOrchestrator on Electron and other shell-owned implementations).
 *
 * PanelRelationshipProvider: panel tree relationship queries used by RpcServer
 * for panel-to-panel authorization (implemented by PanelRegistry).
 *
 * ServerInfoLike, PanelViewLike, PanelHttpServerLike: narrow dependency
 * abstractions for cross-process wiring.
 */

/**
 * Shared Electron session partition for all browser panels.
 * All browser panels share one cookie jar / session, like tabs in a normal browser.
 * Panel-to-panel origin isolation is handled by Chromium's same-origin policy.
 */
export const BROWSER_SESSION_PARTITION = "persist:browser";

/**
 * Minimal panel lifecycle interface — the subset that common bridge handlers need.
 */
export interface BridgePanelManager {
  closePanel(panelId: string): void | Promise<void>;
  getInfo(panelId: string): unknown;
  handleSetStateArgs(panelId: string, updates: Record<string, unknown>): Promise<unknown> | void;
  focusPanel?(panelId: string): void;
  getBootstrapConfig?(callerId: string): Promise<unknown> | unknown;
  createBrowserPanel?(callerId: string, url: string, options?: { name?: string; focus?: boolean }): Promise<{ id: string; title: string }>;
  closeChild?(callerId: string, childId: string): Promise<void>;
}

/**
 * Panel tree relationship queries — used by RpcServer for panel-to-panel
 * authorization (determining if one panel is an ancestor/descendant of another).
 */
export interface PanelRelationshipProvider {
  getPanel(panelId: string): unknown | undefined;
  findParentId(panelId: string): string | null;
  isDescendantOf(panelId: string, ancestorId: string): boolean;
}

// =============================================================================
// Narrow dependency abstractions
// =============================================================================

/**
 * Server interaction abstraction — works for both Electron (ServerInfo over
 * IPC) and headless (in-process token maps).
 */
export interface ServerInfoLike {
  /** Protocol for panel-facing URLs */
  protocol: "http" | "https";
  rpcPort: number;
  rpcWsUrl: string;
  pubsubUrl: string;
  gitBaseUrl: string;
  workerdPort: number;
  /** External hostname for panel URLs (e.g., "localhost" or "my-server.example.com") */
  externalHost: string;
  /** Gateway port that multiplexes all services */
  gatewayPort: number;
  createPanelToken(panelId: string, kind: string): Promise<string> | string;
  ensurePanelToken(panelId: string, kind: string): Promise<string> | string;
  revokePanelToken(panelId: string): Promise<void> | void;
  getPanelToken(panelId: string): Promise<string | null> | string | null;
  getGitTokenForPanel(panelId: string): Promise<string> | string;
  revokeGitToken(panelId: string): Promise<void> | void;
  call(service: string, method: string, args: unknown[]): Promise<unknown>;
}

/**
 * View management abstraction — Electron ViewManager behind a narrow interface.
 * Absent in headless mode.
 */
export interface PanelViewLike {
  createViewForPanel(panelId: string, url: string, contextId?: string): Promise<void>;
  createViewForBrowser?(panelId: string, url: string, contextId: string): Promise<void>;
  hasView(panelId: string): boolean;
  destroyView(panelId: string): void;
  reloadView(panelId: string): boolean;
  navigateView(panelId: string, url: string): Promise<void>;
  getWebContents(panelId: string): unknown | null;
  findViewIdByWebContentsId(senderId: number): string | null;
  setProtectedViews(lineage: Set<string>): void;
}

/**
 * HTTP panel server abstraction — optional in both modes.
 * ensureSubdomainSession is async to support remote server calls.
 */
export interface PanelHttpServerLike {
  ensureSubdomainSession(subdomain: string): Promise<string> | string;
  clearSubdomainSessions(subdomain: string): void;
  hasBuild(source: string): boolean;
  invalidateBuild(source: string): void;
  getPort(): number;
}

/**
 * Options for creating a new panel.
 */
export type PanelCreateOptions = {
  name?: string;
  env?: Record<string, string>;
  /**
   * Explicit context ID for storage partition sharing.
   * If provided, the panel will use this context ID instead of generating one.
   */
  contextId?: string;
  /** If true, immediately focus the new panel after creation */
  focus?: boolean;
}
