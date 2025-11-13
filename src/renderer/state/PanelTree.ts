/**
 * Panel Tree - manages the hierarchical structure of panels
 */

import type {
  PanelId,
  PanelNode,
  PanelTree,
  PanelContentData,
} from '../types/panel.types';

export class PanelTreeManager {
  private tree: PanelTree;
  private idCounter = 0;

  constructor() {
    // Initialize with a root panel
    const rootId = this.generateId();
    const rootNode: PanelNode = {
      id: rootId,
      title: 'Root Panel',
      parentId: null,
      children: [],
      content: { type: 'prototype' },
    };

    this.tree = {
      root: rootId,
      nodes: new Map([[rootId, rootNode]]),
    };
  }

  /**
   * Generate a unique panel ID
   */
  private generateId(): PanelId {
    return `panel-${++this.idCounter}`;
  }

  /**
   * Get the entire tree
   */
  getTree(): PanelTree {
    return this.tree;
  }

  /**
   * Get a specific panel node
   */
  getNode(id: PanelId): PanelNode | undefined {
    return this.tree.nodes.get(id);
  }

  /**
   * Get root panel ID
   */
  getRootId(): PanelId {
    return this.tree.root;
  }

  /**
   * Add a child panel to a parent
   */
  addChild(
    parentId: PanelId,
    title: string,
    content?: PanelContentData
  ): PanelId | null {
    const parent = this.tree.nodes.get(parentId);
    if (!parent) {
      console.error(`Parent panel ${parentId} not found`);
      return null;
    }

    const childId = this.generateId();
    const childNode: PanelNode = {
      id: childId,
      title,
      parentId,
      children: [],
      content: content || { type: 'prototype' },
    };

    // Add child to tree
    this.tree.nodes.set(childId, childNode);

    // Update parent's children array
    parent.children.push(childId);

    return childId;
  }

  /**
   * Remove a panel and all its descendants
   */
  removePanel(id: PanelId): boolean {
    if (id === this.tree.root) {
      console.error('Cannot remove root panel');
      return false;
    }

    const node = this.tree.nodes.get(id);
    if (!node) {
      return false;
    }

    // Remove all descendants recursively
    const toRemove = [id];
    while (toRemove.length > 0) {
      const currentId = toRemove.pop()!;
      const currentNode = this.tree.nodes.get(currentId);

      if (currentNode) {
        // Add children to removal queue
        toRemove.push(...currentNode.children);
        // Remove from tree
        this.tree.nodes.delete(currentId);
      }
    }

    // Remove from parent's children array
    if (node.parentId) {
      const parent = this.tree.nodes.get(node.parentId);
      if (parent) {
        parent.children = parent.children.filter((childId) => childId !== id);
      }
    }

    return true;
  }

  /**
   * Get all ancestors of a panel (from root to parent)
   */
  getAncestors(id: PanelId): PanelId[] {
    const ancestors: PanelId[] = [];
    let currentId: PanelId | null = id;

    while (currentId !== null) {
      const node = this.tree.nodes.get(currentId);
      if (!node) break;

      if (node.parentId !== null) {
        ancestors.unshift(node.parentId);
      }
      currentId = node.parentId;
    }

    return ancestors;
  }

  /**
   * Get the path from root to a specific panel
   */
  getPathToPanel(id: PanelId): PanelId[] {
    const ancestors = this.getAncestors(id);
    return [...ancestors, id];
  }

  /**
   * Get all descendants of a panel
   */
  getDescendants(id: PanelId): PanelId[] {
    const descendants: PanelId[] = [];
    const node = this.tree.nodes.get(id);

    if (!node) return descendants;

    const queue = [...node.children];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      descendants.push(currentId);

      const currentNode = this.tree.nodes.get(currentId);
      if (currentNode) {
        queue.push(...currentNode.children);
      }
    }

    return descendants;
  }

  /**
   * Check if a panel is an ancestor of another
   */
  isAncestor(ancestorId: PanelId, descendantId: PanelId): boolean {
    const ancestors = this.getAncestors(descendantId);
    return ancestors.includes(ancestorId);
  }

  /**
   * Get siblings of a panel (other children of the same parent)
   */
  getSiblings(id: PanelId): PanelId[] {
    const node = this.tree.nodes.get(id);
    if (!node || !node.parentId) return [];

    const parent = this.tree.nodes.get(node.parentId);
    if (!parent) return [];

    return parent.children.filter((childId) => childId !== id);
  }

  /**
   * Update panel title
   */
  updateTitle(id: PanelId, title: string): boolean {
    const node = this.tree.nodes.get(id);
    if (!node) return false;

    node.title = title;
    return true;
  }

  /**
   * Update panel content
   */
  updateContent(id: PanelId, content: PanelContentData): boolean {
    const node = this.tree.nodes.get(id);
    if (!node) return false;

    node.content = content;
    return true;
  }

  /**
   * Get depth of a panel (distance from root)
   */
  getDepth(id: PanelId): number {
    return this.getAncestors(id).length;
  }

  /**
   * Get all leaf panels (panels with no children)
   */
  getLeafPanels(): PanelId[] {
    const leaves: PanelId[] = [];

    for (const [id, node] of this.tree.nodes) {
      if (node.children.length === 0) {
        leaves.push(id);
      }
    }

    return leaves;
  }
}
