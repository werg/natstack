import type { Panel, PanelSummary } from "./types.js";

export type { PanelSummary };

export interface PanelContext {
  panel: Panel;
  ancestors: PanelSummary[];
  siblings: PanelSummary[];
  children: PanelSummary[];
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

export interface PanelSearchIndex {
  indexPanel(panel: IndexablePanel): void | Promise<void>;
  search(query: string, limit?: number): PanelSearchResult[] | Promise<PanelSearchResult[]>;
  incrementAccessCount(panelId: string): void | Promise<void>;
  updateTitle(panelId: string, title: string): void | Promise<void>;
  rebuildIndex(): void | Promise<void>;
}
