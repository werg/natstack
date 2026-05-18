import type { Panel, PanelSnapshot, PanelSnapshotHistory, PanelSummary } from "./types.js";

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

export type SubmittedPanelOp =
  | {
      opId: string;
      type: "panel.create";
      panelId: string;
      parentId: string | null;
      positionId: string;
      snapshot: PanelSnapshot;
      title: string;
    }
  | { opId: string; type: "panel.archive"; panelId: string }
  | { opId: string; type: "panel.restore"; panelId: string }
  | { opId: string; type: "panel.move"; panelId: string; parentId: string | null; positionId: string }
  | { opId: string; type: "panel.setTitle"; panelId: string; title: string }
  | { opId: string; type: "panel.setSnapshot"; panelId: string; snapshot: PanelSnapshot; history?: PanelSnapshotHistory };

export type PersistedPanelOp = SubmittedPanelOp & {
  actorId: string;
  ts: number;
  revision: number;
};

export interface AppendPanelOpResult {
  revision: number;
  accepted: boolean;
  rejectedReason?: string;
  alreadyApplied?: boolean;
}

export interface AppendPanelOpsResult {
  acceptedOps: string[];
  rejectedOps: Array<{ opId: string; reason: string }>;
  revision: number;
}

export interface CompactPanelOpsResult {
  compactedThroughRevision: number;
  retainedOps: number;
  revision: number;
}

export type PanelOpsSinceResult =
  | { ops: PersistedPanelOp[]; revision: number; snapshotRequired?: false }
  | { ops: []; revision: number; snapshotRequired: true };

export interface PanelSnapshotResult {
  tree: Panel[];
  revision: number;
}

export interface PanelSearchIndex {
  indexPanel(panel: IndexablePanel): void | Promise<void>;
  search(query: string, limit?: number): PanelSearchResult[] | Promise<PanelSearchResult[]>;
  incrementAccessCount(panelId: string): void | Promise<void>;
  updateTitle(panelId: string, title: string): void | Promise<void>;
  rebuildIndex(): void | Promise<void>;
}
