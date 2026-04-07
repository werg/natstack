import type { Panel, PanelSnapshot, PanelSummary } from "../types.js";

export interface PanelStoreCreateInput {
  id: string;
  title: string;
  parentId: string | null;
  snapshot: PanelSnapshot;
}

export interface PanelStoreUpdateInput {
  selectedChildId?: string | null;
  snapshot?: PanelSnapshot;
  parentId?: string | null;
}

export interface PanelStore {
  createPanel(input: PanelStoreCreateInput): Promise<void> | void;
  getPanel(panelId: string): Promise<Panel | null> | Panel | null;
  getParentId(panelId: string): Promise<string | null> | string | null;
  getChildren(parentId: string): Promise<PanelSummary[]> | PanelSummary[];
  updatePanel(panelId: string, input: PanelStoreUpdateInput): Promise<void> | void;
  setSelectedChild(panelId: string, childId: string | null): Promise<void> | void;
  updateSelectedPath(focusedPanelId: string): Promise<void> | void;
  setTitle(panelId: string, title: string): Promise<void> | void;
  movePanel(panelId: string, newParentId: string | null, targetPosition: number): Promise<void> | void;
  getFullTree(): Promise<Panel[]> | Panel[];
  getCollapsedIds(): Promise<string[]> | string[];
  setCollapsed(panelId: string, collapsed: boolean): Promise<void> | void;
  setCollapsedBatch(panelIds: string[], collapsed: boolean): Promise<void> | void;
  archivePanel(panelId: string): Promise<void> | void;
  isArchived(panelId: string): Promise<boolean> | boolean;
  close?(): Promise<void> | void;
}
