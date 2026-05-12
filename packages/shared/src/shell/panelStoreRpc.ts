import type { Panel, PanelSnapshot, PanelSummary } from "../types.js";
import type { PanelStore, PanelStoreCreateInput, PanelStoreUpdateInput } from "./panelStore.js";

/**
 * Caller signature shared by every transport that can reach the server's
 * `panel-persistence` service. The caller already has the service binding
 * applied — implementations pass only the method name and positional args.
 * Return type is `unknown` so concrete transports (which often have their
 * own `Promise<unknown>` return) compose without generic-binding gymnastics
 * at the construction site; PanelStoreRpc casts internally to the
 * service method's declared shape.
 */
export type PanelPersistenceCaller = (
  method: string,
  args: unknown[],
) => Promise<unknown>;

/**
 * Server-backed PanelStore implementation. The single source of truth lives
 * in the server's `PanelStoreDO`; this class is a thin proxy over the
 * `panel-persistence` RPC service. Used by both the Electron and mobile
 * shells so panel tree, snapshots, and stateArgs persist consistently for
 * a workspace regardless of which client is viewing it.
 */
export class PanelStoreRpc implements PanelStore {
  constructor(private readonly rpc: PanelPersistenceCaller) {}

  private call<T>(method: string, args: unknown[]): Promise<T> {
    return this.rpc(method, args) as Promise<T>;
  }

  createPanel(input: PanelStoreCreateInput): Promise<void> {
    return this.call("createPanel", [input]);
  }

  getPanel(panelId: string): Promise<Panel | null> {
    return this.call("getPanel", [panelId]);
  }

  getParentId(panelId: string): Promise<string | null> {
    return this.call("getParentId", [panelId]);
  }

  getChildren(parentId: string): Promise<PanelSummary[]> {
    return this.call("getChildren", [parentId]);
  }

  updatePanel(panelId: string, input: PanelStoreUpdateInput): Promise<void> {
    return this.call("updatePanel", [panelId, input]);
  }

  pushHistorySnapshot(panelId: string, snapshot: PanelSnapshot): Promise<void> {
    return this.call("pushHistorySnapshot", [panelId, snapshot]);
  }

  navigateHistory(panelId: string, delta: -1 | 1): Promise<Panel | null> {
    return this.call("navigateHistory", [panelId, delta]);
  }

  setSelectedChild(panelId: string, childId: string | null): Promise<void> {
    return this.call("setSelectedChild", [panelId, childId]);
  }

  updateSelectedPath(focusedPanelId: string): Promise<void> {
    return this.call("updateSelectedPath", [focusedPanelId]);
  }

  setTitle(panelId: string, title: string): Promise<void> {
    return this.call("setTitle", [panelId, title]);
  }

  movePanel(panelId: string, newParentId: string | null, targetPosition: number): Promise<void> {
    return this.call("movePanel", [panelId, newParentId, targetPosition]);
  }

  getFullTree(): Promise<Panel[]> {
    return this.call("getFullTree", []);
  }

  getCollapsedIds(): Promise<string[]> {
    return this.call("getCollapsedIds", []);
  }

  setCollapsed(panelId: string, collapsed: boolean): Promise<void> {
    return this.call("setCollapsed", [panelId, collapsed]);
  }

  setCollapsedBatch(panelIds: string[], collapsed: boolean): Promise<void> {
    return this.call("setCollapsedBatch", [panelIds, collapsed]);
  }

  archivePanel(panelId: string): Promise<void> {
    return this.call("archivePanel", [panelId]);
  }

  isArchived(panelId: string): Promise<boolean> {
    return this.call("isArchived", [panelId]);
  }

  close(): void {}
}
