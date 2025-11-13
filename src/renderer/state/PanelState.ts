/**
 * Panel State Manager - manages the global state of the panel system
 */

import type { PanelId, PanelState } from '../types/panel.types';
import { PanelTreeManager } from './PanelTree';

type StateChangeListener = (state: PanelState) => void;

export class PanelStateManager {
  private treeManager: PanelTreeManager;
  private state: PanelState;
  private listeners: Set<StateChangeListener> = new Set();

  constructor(maxVisiblePanels = 3) {
    this.treeManager = new PanelTreeManager();

    const rootId = this.treeManager.getRootId();

    this.state = {
      tree: this.treeManager.getTree(),
      activePath: [rootId],
      activeChildMap: new Map(),
      collapsedPanels: new Set(),
      focusedPanel: rootId,
      maxVisiblePanels,
    };
  }

  /**
   * Get the current state
   */
  getState(): Readonly<PanelState> {
    return this.state;
  }

  /**
   * Get the tree manager
   */
  getTreeManager(): PanelTreeManager {
    return this.treeManager;
  }

  /**
   * Subscribe to state changes
   */
  subscribe(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Notify all listeners of state change
   */
  private notifyListeners(): void {
    this.listeners.forEach((listener) => listener(this.state));
  }

  /**
   * Launch a child panel
   */
  launchChild(parentId: PanelId, title: string): PanelId | null {
    const childId = this.treeManager.addChild(parentId, title);

    if (!childId) {
      return null;
    }

    // Update active path to include the new child
    const parentPath = this.treeManager.getPathToPanel(parentId);
    this.state.activePath = [...parentPath, childId];

    // Mark this child as the active child of its parent
    this.state.activeChildMap.set(parentId, childId);

    // Focus the new panel
    this.state.focusedPanel = childId;

    this.notifyListeners();
    return childId;
  }

  /**
   * Select a tab (switch to a different child of a parent)
   */
  selectTab(parentId: PanelId, childId: PanelId): boolean {
    const parent = this.treeManager.getNode(parentId);
    if (!parent || !parent.children.includes(childId)) {
      return false;
    }

    // Update active child mapping
    this.state.activeChildMap.set(parentId, childId);

    // Rebuild active path
    const parentPath = this.treeManager.getPathToPanel(parentId);
    const childPath = this.buildActivePathFrom(childId);
    this.state.activePath = [...parentPath, ...childPath];

    // Focus the selected panel
    this.state.focusedPanel = childId;

    // If the panel was collapsed, expand it
    this.state.collapsedPanels.delete(childId);

    this.notifyListeners();
    return true;
  }

  /**
   * Build the active path starting from a given panel
   * (follows activeChildMap to extend the path)
   */
  private buildActivePathFrom(startId: PanelId): PanelId[] {
    const path: PanelId[] = [startId];
    let currentId = startId;

    while (this.state.activeChildMap.has(currentId)) {
      const nextId = this.state.activeChildMap.get(currentId)!;
      path.push(nextId);
      currentId = nextId;
    }

    return path;
  }

  /**
   * Collapse a panel
   */
  collapsePanel(id: PanelId): void {
    this.state.collapsedPanels.add(id);
    this.notifyListeners();
  }

  /**
   * Expand a panel
   */
  expandPanel(id: PanelId): void {
    this.state.collapsedPanels.delete(id);
    this.notifyListeners();
  }

  /**
   * Toggle panel collapse state
   */
  toggleCollapse(id: PanelId): void {
    if (this.state.collapsedPanels.has(id)) {
      this.expandPanel(id);
    } else {
      this.collapsePanel(id);
    }
  }

  /**
   * Focus a panel
   */
  focusPanel(id: PanelId): void {
    if (!this.treeManager.getNode(id)) {
      return;
    }

    this.state.focusedPanel = id;

    // If focusing a collapsed panel, expand it and update active path
    if (this.state.collapsedPanels.has(id)) {
      this.state.collapsedPanels.delete(id);

      // Update active path to include this panel
      const path = this.treeManager.getPathToPanel(id);
      const extendedPath = this.buildActivePathFrom(id);
      this.state.activePath = [...path, ...extendedPath.slice(1)];
    }

    this.notifyListeners();
  }

  /**
   * Close a panel and all its descendants
   */
  closePanel(id: PanelId): boolean {
    if (id === this.treeManager.getRootId()) {
      console.error('Cannot close root panel');
      return false;
    }

    const node = this.treeManager.getNode(id);
    if (!node || !node.parentId) {
      return false;
    }

    const parentId = node.parentId;
    const removedIds = new Set<PanelId>([id, ...this.treeManager.getDescendants(id)]);

    // Remove from tree
    if (!this.treeManager.removePanel(id)) {
      return false;
    }

    // Clean up state
    removedIds.forEach((removedId) => {
      this.state.collapsedPanels.delete(removedId);
    });
    this.cleanupActiveChildMap(removedIds);

    // If this was the active child, select another sibling or clear
    if (this.state.activeChildMap.get(parentId) === id) {
      const parent = this.treeManager.getNode(parentId);
      if (parent && parent.children.length > 0) {
        // Select first remaining child
        const nextChild = parent.children[0];
        if (nextChild) {
          this.state.activeChildMap.set(parentId, nextChild);
        } else {
          this.state.activeChildMap.delete(parentId);
        }
      } else {
        // No more children
        this.state.activeChildMap.delete(parentId);
      }
    }

    // Rebuild active path
    const rootId = this.treeManager.getRootId();
    if (this.state.focusedPanel && this.treeManager.getNode(this.state.focusedPanel)) {
      const focusedPath = this.treeManager.getPathToPanel(this.state.focusedPanel);
      this.state.activePath = focusedPath;
    } else {
      // Focus parent if focused panel was removed
      this.state.focusedPanel = parentId;
      this.state.activePath = this.treeManager.getPathToPanel(parentId);
    }

    this.notifyListeners();
    return true;
  }

  /**
   * Set maximum visible panels
   */
  setMaxVisiblePanels(max: number): void {
    this.state.maxVisiblePanels = Math.max(1, max);
    this.notifyListeners();
  }

  /**
   * Get the active path (current visible branch)
   */
  getActivePath(): PanelId[] {
    return [...this.state.activePath];
  }

  /**
   * Check if a panel is in the active path
   */
  isInActivePath(id: PanelId): boolean {
    return this.state.activePath.includes(id);
  }

  /**
   * Check if a panel is collapsed
   */
  isCollapsed(id: PanelId): boolean {
    return this.state.collapsedPanels.has(id);
  }

  /**
   * Check if a panel is focused
   */
  isFocused(id: PanelId): boolean {
    return this.state.focusedPanel === id;
  }

  /**
   * Navigate back to a panel in the active path
   * This truncates the active path at the specified panel,
   * effectively hiding all its descendants
   */
  navigateToPanel(panelId: PanelId): boolean {
    if (!this.treeManager.getNode(panelId)) {
      return false;
    }

    const previousPath = [...this.state.activePath];

    // Check if panel is in current active path
    if (!this.state.activePath.includes(panelId)) {
      return false;
    }

    // Get path to this panel
    const pathToPanel = this.treeManager.getPathToPanel(panelId);

    // Update active path to end at this panel
    this.state.activePath = pathToPanel;

    // Focus this panel
    this.state.focusedPanel = panelId;

    // Expand it if it was collapsed
    this.state.collapsedPanels.delete(panelId);

    this.pruneChildSelectionsAfterNavigation(previousPath, panelId);

    this.notifyListeners();
    return true;
  }

  /**
   * Remove child selections that belong to a trimmed branch
   */
  private pruneChildSelectionsAfterNavigation(
    previousPath: PanelId[],
    targetId: PanelId
  ): void {
    const targetIndex = previousPath.indexOf(targetId);
    if (targetIndex === -1) {
      return;
    }

    const truncatedIds = new Set(previousPath.slice(targetIndex + 1));
    this.state.activeChildMap.forEach((childId, parentId) => {
      if (truncatedIds.has(parentId) || truncatedIds.has(childId)) {
        this.state.activeChildMap.delete(parentId);
      }
    });

    // Ensure the active child map only reflects the new active path
    const newPath = this.state.activePath;
    for (let i = 0; i < newPath.length - 1; i++) {
      const parentId = newPath[i];
      const childId = newPath[i + 1];
      if (parentId && childId) {
        this.state.activeChildMap.set(parentId, childId);
      }
    }

    const lastId = newPath[newPath.length - 1];
    if (lastId) {
      this.state.activeChildMap.delete(lastId);
    }
  }

  /**
   * Remove any child selections that reference removed panels
   */
  private cleanupActiveChildMap(idsToRemove: Set<PanelId>): void {
    this.state.activeChildMap.forEach((childId, parentId) => {
      if (idsToRemove.has(parentId) || idsToRemove.has(childId)) {
        this.state.activeChildMap.delete(parentId);
      }
    });
  }
}
