/**
 * Shared cross-boundary interfaces.
 *
 * BridgePanelManager: minimal surface used by bridge handlers (implemented by
 * PanelLifecycle).
 *
 * PanelRelationshipProvider: panel tree relationship queries used by RpcServer
 * for panel-to-panel authorization (implemented by PanelRegistry).
 *
 * RpcServerLike: minimal RPC server surface used by main/ entry point
 * (implemented by RpcServer in server/).
 */

/**
 * Minimal panel lifecycle interface — the subset that common bridge handlers need.
 */
export interface BridgePanelManager {
  closePanel(panelId: string): void;
  getInfo(panelId: string): unknown;
  handleSetStateArgs(panelId: string, updates: Record<string, unknown>): Promise<unknown> | void;
  focusPanel?(panelId: string): void;
  getBootstrapConfig?(callerId: string): Promise<unknown> | unknown;
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

/**
 * Minimal RPC server interface — the subset that main/ needs for wiring.
 * Implemented by RpcServer in server/.
 */
export interface RpcServerLike {
  start(): Promise<number>;
  stop(): Promise<void>;
  getPort(): number | null;
  sendToClient(callerId: string, msg: unknown): void;
}
