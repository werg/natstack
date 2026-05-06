import type { PanelStore, PanelStoreCreateInput, PanelStoreUpdateInput } from "@natstack/shared/shell/panelStore";
import type { Panel, PanelSummary } from "@natstack/shared/types";
import type { ServerClient } from "../serverClient.js";

export class PanelStoreRpc implements PanelStore {
  constructor(private readonly serverClient: ServerClient) {}

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    return this.serverClient.call("panel-persistence", method, args, {
      callerId: "electron-shell",
      callerKind: "shell",
    }) as Promise<T>;
  }

  createPanel(input: PanelStoreCreateInput): Promise<void> {
    return this.call("createPanel", input);
  }

  getPanel(panelId: string): Promise<Panel | null> {
    return this.call("getPanel", panelId);
  }

  getParentId(panelId: string): Promise<string | null> {
    return this.call("getParentId", panelId);
  }

  getChildren(parentId: string): Promise<PanelSummary[]> {
    return this.call("getChildren", parentId);
  }

  updatePanel(panelId: string, input: PanelStoreUpdateInput): Promise<void> {
    return this.call("updatePanel", panelId, input);
  }

  setSelectedChild(panelId: string, childId: string | null): Promise<void> {
    return this.call("setSelectedChild", panelId, childId);
  }

  updateSelectedPath(focusedPanelId: string): Promise<void> {
    return this.call("updateSelectedPath", focusedPanelId);
  }

  setTitle(panelId: string, title: string): Promise<void> {
    return this.call("setTitle", panelId, title);
  }

  movePanel(panelId: string, newParentId: string | null, targetPosition: number): Promise<void> {
    return this.call("movePanel", panelId, newParentId, targetPosition);
  }

  getFullTree(): Promise<Panel[]> {
    return this.call("getFullTree");
  }

  getCollapsedIds(): Promise<string[]> {
    return this.call("getCollapsedIds");
  }

  setCollapsed(panelId: string, collapsed: boolean): Promise<void> {
    return this.call("setCollapsed", panelId, collapsed);
  }

  setCollapsedBatch(panelIds: string[], collapsed: boolean): Promise<void> {
    return this.call("setCollapsedBatch", panelIds, collapsed);
  }

  archivePanel(panelId: string): Promise<void> {
    return this.call("archivePanel", panelId);
  }

  isArchived(panelId: string): Promise<boolean> {
    return this.call("isArchived", panelId);
  }

  close(): void {}
}
