import { atom } from 'jotai';

import type {
  PanelColumnLayout,
  PanelId,
  PanelLayoutDescription,
  PanelNode,
  PanelTabKind,
  PanelTabModel,
  PanelTree,
  PanelVisibilityRecord,
} from '../types/panel.types';
import {
  createInitialPanelTree,
  getPathToPanel,
  insertChildNode,
  removePanelSubtree,
} from './PanelTree';
import {
  DEFAULT_COLUMN_COUNT,
  MIN_COLUMN_COUNT,
  MAX_COLUMN_COUNT,
} from '../constants/panel';
import { clamp } from '../../main/utils';

const initialTree = createInitialPanelTree();

/**
 * Initial visibility state - explicitly mark the root panel as visible.
 * This is more explicit than relying on reconcileVisibilityState for initialization.
 */
const initialVisibility = new Map<PanelId, PanelVisibilityRecord>([
  [
    initialTree.root,
    {
      panelId: initialTree.root,
      visible: true,
      hiddenBecause: null,
    },
  ],
]);

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

export const panelTreeAtom = atom<PanelTree>(initialTree);
export const rootPanelIdAtom = atom((get) => get(panelTreeAtom).root);
export const targetPanelAtom = atom<PanelId>(initialTree.root);
export const panelColumnCountAtom = atom(DEFAULT_COLUMN_COUNT);
export const panelIdCounterAtom = atom(1);

export const activePathAtom = atom<PanelId[]>((get) => {
  const tree = get(panelTreeAtom);
  const target = get(targetPanelAtom);
  return getPathToPanel(tree, target);
});

export const panelVisibilityStateAtom = atom<Map<PanelId, PanelVisibilityRecord>>(
  initialVisibility
);

export const panelLayoutAtom = atom<PanelLayoutDescription>((get) => {
  const tree = get(panelTreeAtom);
  const activePath = get(activePathAtom);
  const visibility = get(panelVisibilityStateAtom);
  const targetPanelId = get(targetPanelAtom);

  const visibleIds = activePath.filter((id) => visibility.get(id)?.visible);
  const effectiveVisibleIds =
    visibleIds.length > 0 ? visibleIds : [tree.root];
  const visibleSet = new Set(effectiveVisibleIds);
  // Width is evenly distributed across visible panels
  const widthPercent = 100 / effectiveVisibleIds.length;

  const columns: PanelColumnLayout[] = effectiveVisibleIds
    .map((panelId) => {
      const node = tree.nodes.get(panelId);
      if (!node) {
        return null;
      }

      return {
        id: panelId,
        node,
        widthPercent,
        isTarget: panelId === targetPanelId,
        depth: activePath.indexOf(panelId),
        breadcrumbTabs: buildBreadcrumbTabs(
          panelId,
          activePath,
          visibleSet,
          tree
        ),
        siblingTabs: buildSiblingTabs(node, tree),
        childTabs: buildChildTabs(node, activePath, visibleSet, tree),
      };
    })
    .filter((column): column is PanelColumnLayout => Boolean(column));

  const hiddenIds = activePath.filter((id) => !visibleSet.has(id));

  return {
    columns,
    visiblePanelIds: effectiveVisibleIds,
    hiddenPanels: {
      ids: hiddenIds,
      overflowCount: hiddenIds.length,
    },
  };
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
 * Build breadcrumb tabs for hidden ancestors.
 * These appear above a panel when its ancestors have been hidden due to column overflow.
 * The last breadcrumb is marked as active to indicate it's the immediate parent.
 */
const buildBreadcrumbTabs = (
  panelId: PanelId,
  activePath: PanelId[],
  visibleSet: Set<PanelId>,
  tree: PanelTree
): PanelTabModel[] => {
  const index = activePath.indexOf(panelId);
  if (index <= 0) {
    return [];
  }

  const ancestors = activePath.slice(0, index);
  const hiddenAncestors = ancestors.filter((id) => !visibleSet.has(id));

  return hiddenAncestors.map((ancestorId, idx) => {
    const node = tree.nodes.get(ancestorId);
    // Mark the last breadcrumb (immediate hidden parent) as active
    const isActive = idx === hiddenAncestors.length - 1;
    return createTabModel(
      ancestorId,
      'breadcrumb',
      node?.parentId ?? null,
      tree,
      isActive
    );
  });
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

/**
 * Build child tabs (sliver) for a panel's hidden children.
 * Only shown when:
 * - The panel has children, AND
 * - NONE of those children are currently visible
 *
 * This creates a "sliver" at the bottom of the panel to keep hidden children accessible.
 * If ANY child is visible, we don't show this sliver (the visible child shows sibling tabs instead).
 */

const buildChildTabs = (
  node: PanelNode,
  activePath: PanelId[],
  visibleSet: Set<PanelId>,
  tree: PanelTree
): PanelTabModel[] => {
  if (node.children.length === 0) {
    return [];
  }

  const hasVisibleChild = node.children.some((childId) =>
    visibleSet.has(childId)
  );

  if (hasVisibleChild) {
    return [];
  }

  return node.children.map((childId) => {
    const isActive = activePath.includes(childId);
    return createTabModel(childId, 'child', node.id, tree, isActive);
  });
};

export const adjustColumnCountAtom = atom(
  null,
  (get, set, delta: number): void => {
    const next = clamp(
      get(panelColumnCountAtom) + delta,
      MIN_COLUMN_COUNT,
      MAX_COLUMN_COUNT
    );
    set(panelColumnCountAtom, next);
  }
);

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
  }
);
