import { atom } from 'jotai';

import type {
  PanelColumnLayout,
  PanelId,
  PanelLayoutDescription,
  PanelNode,
  PanelTabKind,
  PanelTabModel,
  PanelTree,
  PanelVisibilityMap,
} from '../types/panel.types';
import {
  createInitialPanelTree,
  getPathToPanel,
  insertChildNode,
  removePanelSubtree,
} from './PanelTree';

const initialTree = createInitialPanelTree();

const createPanelNode = (
  id: PanelId,
  title: string,
  parentId: PanelId
): PanelNode => ({
  id,
  title,
  parentId,
  children: [],
  content: { type: 'prototype' },
});

// ========================================
// Core State Atoms
// ========================================

export const panelTreeAtom = atom<PanelTree>(initialTree);
export const targetPanelAtom = atom<PanelId>(initialTree.root);
export const panelIdCounterAtom = atom(1);

/**
 * Panel widths in pixels. Maps panelId -> width.
 * If a panel is not in this map, it gets equal width distribution.
 */
export const panelWidthsAtom = atom<Map<PanelId, number>>(new Map());

/**
 * Visibility map: true = minimized, false/undefined = expanded
 */
export const panelVisibilityAtom = atom<PanelVisibilityMap>(new Map());

/**
 * Active path from root to target panel
 */
export const activePathAtom = atom<PanelId[]>((get) => {
  const tree = get(panelTreeAtom);
  const target = get(targetPanelAtom);
  return getPathToPanel(tree, target);
});

// ========================================
// Layout Computation
// ========================================

/**
 * Main layout atom - computes the visible panel layout based on active path
 * and user-controlled minimize states.
 *
 * Minimized panels are NOT rendered - they only appear as breadcrumb tabs.
 */
export const panelLayoutAtom = atom<PanelLayoutDescription>((get) => {
  const tree = get(panelTreeAtom);
  const activePath = get(activePathAtom);
  const visibility = get(panelVisibilityAtom);
  const widths = get(panelWidthsAtom);

  if (activePath.length === 0) {
    return { columns: [] };
  }

  // Filter out minimized panels - they won't be rendered
  const visiblePanels = activePath.filter((id) => !visibility.get(id));

  if (visiblePanels.length === 0) {
    return { columns: [] };
  }

  const totalPanels = visiblePanels.length;
  const defaultWidthFraction = 1 / totalPanels;

  const columns: PanelColumnLayout[] = visiblePanels
    .map((panelId, visibleIndex) => {
      const node = tree.nodes.get(panelId);
      if (!node) {
        return null;
      }

      const isFirstVisiblePanel = visibleIndex === 0;

      // Build tabs
      const topTabs = buildTopTabs(
        panelId,
        activePath,
        visibility,
        tree,
        isFirstVisiblePanel
      );
      const bottomTabs = buildBottomTabs(
        panelId,
        activePath,
        visibility,
        tree,
        isFirstVisiblePanel
      );
      const siblingTabs = buildSiblingTabs(node, tree);

      // Width calculation
      const widthFraction = widths.has(panelId)
        ? widths.get(panelId)! / window.innerWidth
        : defaultWidthFraction;

      return {
        id: panelId,
        node,
        widthFraction,
        minimized: false, // This panel is visible, so not minimized
        topTabs,
        bottomTabs,
        siblingTabs,
      };
    })
    .filter((column): column is PanelColumnLayout => Boolean(column));

  return { columns };
});

/**
 * Helper to create a tab model with consistent structure.
 */
const createTabModel = (
  id: PanelId,
  kind: PanelTabKind,
  parentId: PanelId | null,
  tree: PanelTree,
  isActive: boolean
): PanelTabModel => {
  const node = tree.nodes.get(id);
  return {
    id,
    label: node?.title ?? id,
    kind,
    parentId,
    isActive,
  };
};

/**
 * Build top tabs:
 * - For the leftmost VISIBLE panel: show ALL minimized ancestors (breadcrumbs)
 */
const buildTopTabs = (
  panelId: PanelId,
  activePath: PanelId[],
  visibility: PanelVisibilityMap,
  tree: PanelTree,
  isFirstVisiblePanel: boolean
): PanelTabModel[] => {
  if (!isFirstVisiblePanel) {
    return [];
  }

  const index = activePath.indexOf(panelId);
  if (index <= 0) {
    return [];
  }

  // For leftmost visible panel, show ALL minimized ancestors at top
  const minimizedAncestors: PanelTabModel[] = [];
  for (let i = 0; i < index; i++) {
    const ancestorId = activePath[i];
    if (!ancestorId) continue;
    if (visibility.get(ancestorId)) {
      const isActive = i === index - 1; // Immediate parent is active
      minimizedAncestors.push(
        createTabModel(
          ancestorId,
          'breadcrumb',
          tree.nodes.get(ancestorId)?.parentId ?? null,
          tree,
          isActive
        )
      );
    }
  }
  return minimizedAncestors;
};

/**
 * Build bottom tabs: minimized ancestors (breadcrumbs) for non-leftmost visible panels
 */
const buildBottomTabs = (
  panelId: PanelId,
  activePath: PanelId[],
  visibility: PanelVisibilityMap,
  tree: PanelTree,
  isFirstVisiblePanel: boolean
): PanelTabModel[] => {
  if (isFirstVisiblePanel) {
    return []; // First visible panel shows breadcrumbs at top, not bottom
  }

  const index = activePath.indexOf(panelId);
  if (index <= 0) {
    return [];
  }

  // Show ALL minimized ancestors at bottom for non-leftmost visible panels
  const minimizedAncestors: PanelTabModel[] = [];
  for (let i = 0; i < index; i++) {
    const ancestorId = activePath[i];
    if (!ancestorId) continue;
    if (visibility.get(ancestorId)) {
      const isActive = i === index - 1; // Immediate parent is active
      minimizedAncestors.push(
        createTabModel(
          ancestorId,
          'breadcrumb',
          tree.nodes.get(ancestorId)?.parentId ?? null,
          tree,
          isActive
        )
      );
    }
  }

  return minimizedAncestors;
};

/**
 * Build sibling tabs for panels that share the same parent.
 * Only shown when a panel has siblings (alternatives).
 * The current panel is marked as active.
 */
const buildSiblingTabs = (node: PanelNode, tree: PanelTree): PanelTabModel[] => {
  if (!node.parentId) {
    return [];
  }

  const parent = tree.nodes.get(node.parentId);
  if (!parent || parent.children.length <= 1) {
    return [];
  }

  return parent.children.map((childId) => {
    const isActive = childId === node.id;
    return createTabModel(childId, 'sibling', parent.id, tree, isActive);
  });
};

// ========================================
// Action Atoms
// ========================================

interface LaunchChildPayload {
  parentId: PanelId;
  title?: string;
}

export const launchChildAtom = atom(
  null,
  (get, set, payload: LaunchChildPayload): void => {
    const tree = get(panelTreeAtom);
    const parent = tree.nodes.get(payload.parentId);
    if (!parent) {
      return;
    }

    const nextIdNumber = get(panelIdCounterAtom) + 1;
    const childId: PanelId = `panel-${nextIdNumber}`;
    const title =
      payload.title ?? `${parent.title} > Child ${parent.children.length + 1}`;

    const updatedTree = insertChildNode(
      tree,
      parent.id,
      createPanelNode(childId, title, parent.id)
    );

    set(panelTreeAtom, updatedTree);
    set(panelIdCounterAtom, nextIdNumber);
    set(targetPanelAtom, childId);
  }
);

export const navigateToAtom = atom(
  null,
  (get, set, panelId: PanelId): void => {
    const tree = get(panelTreeAtom);
    if (!tree.nodes.has(panelId)) {
      return;
    }

    // When navigating to a panel, restore it (un-minimize) if it's minimized
    const visibility = get(panelVisibilityAtom);
    if (visibility.get(panelId)) {
      const newVisibility = new Map(visibility);
      newVisibility.set(panelId, false);
      set(panelVisibilityAtom, newVisibility);
    }

    set(targetPanelAtom, panelId);
  }
);

export const selectSiblingAtom = atom(
  null,
  (get, set, payload: { parentId: PanelId; childId: PanelId }): void => {
    if (!payload.parentId || !payload.childId) {
      console.warn('selectSibling: Missing parentId or childId', payload);
      return;
    }

    const tree = get(panelTreeAtom);
    const parent = tree.nodes.get(payload.parentId);
    if (!parent) {
      console.warn(
        'selectSibling: Parent panel not found:',
        payload.parentId
      );
      return;
    }

    if (!parent.children.includes(payload.childId)) {
      console.warn(
        'selectSibling: Child is not a sibling of parent:',
        payload
      );
      return;
    }

    set(targetPanelAtom, payload.childId);
  }
);

export const closePanelAtom = atom(
  null,
  (get, set, panelId: PanelId): void => {
    const tree = get(panelTreeAtom);
    if (panelId === tree.root) {
      return;
    }

    const closingNode = tree.nodes.get(panelId);
    if (!closingNode) {
      return;
    }

    const { tree: nextTree, removedIds } = removePanelSubtree(tree, panelId);
    if (removedIds.length === 0) {
      return;
    }

    set(panelTreeAtom, nextTree);

    const currentTarget = get(targetPanelAtom);
    if (!currentTarget || removedIds.includes(currentTarget)) {
      set(targetPanelAtom, closingNode.parentId ?? nextTree.root);
    }

    // Clean up visibility and width state for removed panels
    const visibility = get(panelVisibilityAtom);
    const widths = get(panelWidthsAtom);
    const newVisibility = new Map(visibility);
    const newWidths = new Map(widths);
    removedIds.forEach((id) => {
      newVisibility.delete(id);
      newWidths.delete(id);
    });
    set(panelVisibilityAtom, newVisibility);
    set(panelWidthsAtom, newWidths);
  }
);

/**
 * Toggle minimize state for a panel
 */
export const toggleMinimizeAtom = atom(
  null,
  (get, set, panelId: PanelId): void => {
    const visibility = get(panelVisibilityAtom);
    const newVisibility = new Map(visibility);
    const currentState = newVisibility.get(panelId) ?? false;
    newVisibility.set(panelId, !currentState);
    set(panelVisibilityAtom, newVisibility);
  }
);

/**
 * Set custom width for a panel in pixels
 */
export const setPanelWidthAtom = atom(
  null,
  (get, set, payload: { panelId: PanelId; width: number }): void => {
    const widths = get(panelWidthsAtom);
    const newWidths = new Map(widths);
    newWidths.set(payload.panelId, payload.width);
    set(panelWidthsAtom, newWidths);
  }
);
