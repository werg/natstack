import type { Panel, PanelSnapshot, PanelSummary } from "./types.js";

export type { PanelSummary };

export interface PanelContext {
  panel: Panel;
  ancestors: PanelSummary[];
  siblings: PanelSummary[];
  children: PanelSummary[];
}

export interface CreatePanelInput {
  id: string;
  title: string;
  parentId: string | null;
  snapshot: PanelSnapshot;
}

export interface UpdatePanelInput {
  selectedChildId?: string | null;
  snapshot?: PanelSnapshot;
  parentId?: string | null;
}

export interface PanelSearchResult {
  id: string;
  title: string;
  relevance: number;
  accessCount: number;
  matchContext?: string;
}

export interface IndexablePanel {
  id: string;
  title: string;
  path?: string;
  manifestDescription?: string;
  manifestDependencies?: string[];
  tags?: string[];
  keywords?: string[];
}

export interface PanelPersistence {
  createPanel(input: CreatePanelInput): void | Promise<void>;
  getPanel(panelId: string): Panel | null | Promise<Panel | null>;
  getRootPanels(): PanelSummary[] | Promise<PanelSummary[]>;
  getChildren(parentId: string): PanelSummary[] | Promise<PanelSummary[]>;
  getSiblings(panelId: string): PanelSummary[] | Promise<PanelSummary[]>;
  getAncestors(panelId: string): PanelSummary[] | Promise<PanelSummary[]>;
  getPanelContext(panelId: string): PanelContext | null | Promise<PanelContext | null>;
  panelExists(panelId: string): boolean | Promise<boolean>;
  getPanelCount(): number | Promise<number>;
  updatePanel(panelId: string, input: UpdatePanelInput): void | Promise<void>;
  setSelectedChild(panelId: string, childId: string | null): void | Promise<void>;
  updateSelectedPath(focusedPanelId: string): void | Promise<void>;
  setTitle(panelId: string, title: string): void | Promise<void>;
  movePanel(panelId: string, newParentId: string | null, targetPosition: number): void | Promise<void>;
  getChildrenPaginated(parentId: string, offset: number, limit: number): { children: PanelSummary[]; total: number; hasMore: boolean } | Promise<{ children: PanelSummary[]; total: number; hasMore: boolean }>;
  getRootPanelsPaginated(offset: number, limit: number): { panels: PanelSummary[]; total: number; hasMore: boolean } | Promise<{ panels: PanelSummary[]; total: number; hasMore: boolean }>;
  getFullTree(): Panel[] | Promise<Panel[]>;
  getParentId(panelId: string): string | null | Promise<string | null>;
  getCollapsedIds(): string[] | Promise<string[]>;
  setCollapsed(panelId: string, collapsed: boolean): void | Promise<void>;
  setCollapsedBatch(panelIds: string[], collapsed: boolean): void | Promise<void>;
  archivePanel(panelId: string): void | Promise<void>;
  unarchivePanel(panelId: string): void | Promise<void>;
  isArchived(panelId: string): boolean | Promise<boolean>;
  close?(): void | Promise<void>;
}

export interface PanelSearchIndex {
  indexPanel(panel: IndexablePanel): void | Promise<void>;
  search(query: string, limit?: number): PanelSearchResult[] | Promise<PanelSearchResult[]>;
  incrementAccessCount(panelId: string): void | Promise<void>;
  updateTitle(panelId: string, title: string): void | Promise<void>;
  rebuildIndex(): void | Promise<void>;
}

