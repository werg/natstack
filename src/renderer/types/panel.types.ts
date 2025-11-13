/**
 * Core types for the stackable panel system
 */

export type PanelId = string;

export interface PanelNode {
  id: PanelId;
  title: string;
  parentId: PanelId | null;
  children: PanelId[];
  content?: PanelContentData;
  metadata?: Record<string, unknown>;
}

export interface PanelContentData {
  type: 'prototype' | 'webview' | 'iframe';
  data?: unknown;
}

export interface PanelTree {
  root: PanelId;
  nodes: Map<PanelId, PanelNode>;
}

export interface PanelState {
  tree: PanelTree;
  // The current visible path from root to active panel
  activePath: PanelId[];
  // Which child is selected at each branching point
  activeChildMap: Map<PanelId, PanelId>;
  // Collapsed panels
  collapsedPanels: Set<PanelId>;
  // Focus state
  focusedPanel: PanelId | null;
  // User-controlled visible panel limit
  maxVisiblePanels: number;
}

export type TabKind = 'path' | 'sibling';

export interface TabEntry {
  id: PanelId;
  kind: TabKind;
  parentId: PanelId | null;
}

export interface LayoutState {
  // Panels in current view (left to right)
  visiblePanels: PanelId[];
  // Panels that should be shown expanded (not collapsed)
  expandedPanels: PanelId[];
  // Unified tab list (breadcrumbs + sibling tabs)
  tabEntries: TabEntry[];
  // Panel widths (calculated)
  panelWidths: Map<PanelId, number>;
}

export type PanelVisibility = 'expanded' | 'collapsing' | 'collapsed' | 'hidden';

export interface PanelUIState {
  id: PanelId;
  visibility: PanelVisibility;
  width: number; // percentage or pixels
  isActive: boolean;
  isFocused: boolean;
}

// Events
export interface PanelEvent {
  type: PanelEventType;
  panelId: PanelId;
  data?: unknown;
}

export type PanelEventType =
  | 'launch-child'
  | 'close-panel'
  | 'focus-panel'
  | 'select-tab'
  | 'collapse-panel'
  | 'expand-panel'
  | 'resize-panel';

export interface LaunchChildEvent {
  parentId: PanelId;
  title: string;
  asTab?: boolean; // if false, launches nested within parent
}

export interface SelectTabEvent {
  parentId: PanelId;
  childId: PanelId;
}
