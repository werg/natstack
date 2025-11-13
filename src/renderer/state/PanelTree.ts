import type { PanelId, PanelNode, PanelTree } from '../types/panel.types';

export function createInitialPanelTree(): PanelTree {
  const rootId: PanelId = 'panel-1';
  const rootNode: PanelNode = {
    id: rootId,
    title: 'Root Panel',
    parentId: null,
    children: [],
    content: { type: 'prototype' },
  };

  return {
    root: rootId,
    nodes: new Map([[rootId, rootNode]]),
  };
}

export function insertChildNode(
  tree: PanelTree,
  parentId: PanelId,
  child: PanelNode
): PanelTree {
  const parent = tree.nodes.get(parentId);
  if (!parent) {
    return tree;
  }

  const nodes = new Map(tree.nodes);
  nodes.set(child.id, child);
  nodes.set(parentId, {
    ...parent,
    children: [...parent.children, child.id],
  });

  return { ...tree, nodes };
}

export function removePanelSubtree(
  tree: PanelTree,
  panelId: PanelId
): { tree: PanelTree; removedIds: PanelId[] } {
  if (panelId === tree.root) {
    console.warn('Cannot remove the root panel');
    return { tree, removedIds: [] };
  }

  if (!tree.nodes.has(panelId)) {
    return { tree, removedIds: [] };
  }

  const nodes = new Map(tree.nodes);
  const removedIds = collectDescendants(nodes, panelId);
  removedIds.forEach((id) => nodes.delete(id));

  const parentId = tree.nodes.get(panelId)?.parentId ?? null;
  if (parentId) {
    const parent = nodes.get(parentId);
    if (parent) {
      nodes.set(parentId, {
        ...parent,
        children: parent.children.filter((childId) => childId !== panelId),
      });
    }
  }

  return {
    tree: { ...tree, nodes },
    removedIds,
  };
}

function collectDescendants(
  nodes: Map<PanelId, PanelNode>,
  startId: PanelId
): PanelId[] {
  const toRemove: PanelId[] = [];
  const queue: PanelId[] = [startId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const currentNode = nodes.get(currentId);
    if (!currentNode) {
      continue;
    }

    toRemove.push(currentId);
    queue.push(...currentNode.children);
  }

  return toRemove;
}

export function getPathToPanel(tree: PanelTree, panelId: PanelId): PanelId[] {
  const node = tree.nodes.get(panelId);
  if (!node) {
    return [tree.root];
  }

  const path: PanelId[] = [];
  let current: PanelId | null = panelId;

  while (current !== null) {
    const currentNode = tree.nodes.get(current);
    if (!currentNode) {
      break;
    }
    path.unshift(currentNode.id);
    current = currentNode.parentId;
  }

  return path;
}

export function getAncestors(tree: PanelTree, panelId: PanelId): PanelId[] {
  const ancestors: PanelId[] = [];
  let current: PanelId | null = tree.nodes.get(panelId)?.parentId ?? null;

  while (current !== null) {
    ancestors.unshift(current);
    current = tree.nodes.get(current)?.parentId ?? null;
  }

  return ancestors;
}

export function getDescendants(tree: PanelTree, panelId: PanelId): PanelId[] {
  const descendants: PanelId[] = [];
  const startNode = tree.nodes.get(panelId);
  if (!startNode) {
    return descendants;
  }

  const queue = [...startNode.children];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    descendants.push(currentId);
    const currentNode = tree.nodes.get(currentId);
    if (currentNode) {
      queue.push(...currentNode.children);
    }
  }

  return descendants;
}

export function getSiblings(tree: PanelTree, panelId: PanelId): PanelId[] {
  const node = tree.nodes.get(panelId);
  if (!node || !node.parentId) {
    return [];
  }

  const parent = tree.nodes.get(node.parentId);
  if (!parent) {
    return [];
  }

  return parent.children.filter((childId) => childId !== panelId);
}
