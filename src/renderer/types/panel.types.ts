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

export type PanelHiddenReason = 'overflow' | null;

export interface PanelVisibilityRecord {
  panelId: PanelId;
  visible: boolean;
  hiddenBecause: PanelHiddenReason;
}

export type PanelTabKind = 'breadcrumb' | 'sibling' | 'child';

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
  widthPercent: number;
  isTarget: boolean;
  depth: number;
  breadcrumbTabs: PanelTabModel[];
  siblingTabs: PanelTabModel[];
  childTabs: PanelTabModel[];
}

export interface PanelLayoutDescription {
  columns: PanelColumnLayout[];
  visiblePanelIds: PanelId[];
  hiddenPanels: {
    ids: PanelId[];
    overflowCount: number;
  };
}
