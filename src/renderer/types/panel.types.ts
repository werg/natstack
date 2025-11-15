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

/**
 * User-controlled visibility state for each panel.
 * True = minimized (collapsed), False = expanded
 */
export type PanelVisibilityMap = Map<PanelId, boolean>;

export type PanelTabKind = 'breadcrumb' | 'sibling';

export interface PanelTabModel {
  id: PanelId;
  label: string;
  kind: PanelTabKind;
  parentId: PanelId | null;
  isActive: boolean;
}

export interface PanelColumnLayout {
  id: PanelId;
  node: PanelNode;
  widthFraction: number;
  minimized: boolean;
  topTabs: PanelTabModel[];
  bottomTabs: PanelTabModel[];
  siblingTabs: PanelTabModel[];
}

export interface PanelLayoutDescription {
  columns: PanelColumnLayout[];
}
