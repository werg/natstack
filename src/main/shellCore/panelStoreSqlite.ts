import type { PanelPersistence } from "@natstack/shared/db/panelPersistence";
import type { PanelStore, PanelStoreCreateInput, PanelStoreUpdateInput } from "@natstack/shared/shell/panelStore";

export class PanelStoreSqlite implements PanelStore {
  constructor(private readonly persistence: PanelPersistence) {}

  createPanel(input: PanelStoreCreateInput): void {
    this.persistence.createPanel(input);
  }

  getPanel(panelId: string) {
    return this.persistence.getPanel(panelId);
  }

  getParentId(panelId: string) {
    return this.persistence.getParentId(panelId);
  }

  getChildren(parentId: string) {
    return this.persistence.getChildren(parentId);
  }

  updatePanel(panelId: string, input: PanelStoreUpdateInput): void {
    this.persistence.updatePanel(panelId, input);
  }

  setSelectedChild(panelId: string, childId: string | null): void {
    this.persistence.setSelectedChild(panelId, childId);
  }

  updateSelectedPath(focusedPanelId: string): void {
    this.persistence.updateSelectedPath(focusedPanelId);
  }

  setTitle(panelId: string, title: string): void {
    this.persistence.setTitle(panelId, title);
  }

  movePanel(panelId: string, newParentId: string | null, targetPosition: number): void {
    this.persistence.movePanel(panelId, newParentId, targetPosition);
  }

  getFullTree() {
    return this.persistence.getFullTree();
  }

  getCollapsedIds() {
    return this.persistence.getCollapsedIds();
  }

  setCollapsed(panelId: string, collapsed: boolean): void {
    this.persistence.setCollapsed(panelId, collapsed);
  }

  setCollapsedBatch(panelIds: string[], collapsed: boolean): void {
    this.persistence.setCollapsedBatch(panelIds, collapsed);
  }

  archivePanel(panelId: string): void {
    this.persistence.archivePanel(panelId);
  }

  isArchived(panelId: string): boolean {
    return this.persistence.isArchived(panelId);
  }

  close(): void {
    this.persistence.close();
  }
}
