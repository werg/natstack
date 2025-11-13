/**
 * Layout Engine - calculates which panels should be visible and how they should be displayed
 */

import type {
  PanelId,
  LayoutState,
  PanelState,
  TabEntry,
} from '../types/panel.types';
import type { PanelTreeManager } from '../state/PanelTree';

export class LayoutEngine {
  /**
   * Calculate the layout state based on current panel state
   */
  calculateLayout(
    state: PanelState,
    treeManager: PanelTreeManager
  ): LayoutState {
    const { activePath, maxVisiblePanels, collapsedPanels, focusedPanel } =
      state;

    if (activePath.length === 0) {
      return {
        visiblePanels: [],
        expandedPanels: [],
        tabEntries: [],
        panelWidths: new Map(),
      };
    }

    // Determine which panels in the active path should be visible (expanded or collapsed)
    const visiblePanels: PanelId[] = [];

    // Calculate how many panels we can show expanded
    const expandedPanels: PanelId[] = [];

    // First, determine which panels should be expanded vs collapsed
    // Strategy: Respect manual collapses, then auto-collapse around focused panel

    // Add all panels to visible list
    visiblePanels.push(...activePath);

    const autoCollapsed = this.determineAutoCollapse(
      activePath,
      focusedPanel,
      maxVisiblePanels,
      collapsedPanels
    );

    const collapsedSet = new Set<PanelId>(collapsedPanels);
    autoCollapsed.forEach((panelId) => collapsedSet.add(panelId));

    let expandablePanels = activePath.filter((id) => !collapsedSet.has(id));

    if (expandablePanels.length === 0 && activePath.length > 0) {
      // Ensure at least the leaf is visible
      const last = activePath[activePath.length - 1]!;
      collapsedSet.delete(last);
      expandablePanels = [last];
    }

    if (expandablePanels.length > maxVisiblePanels) {
      const overflow = expandablePanels.length - maxVisiblePanels;
      const trimmed = expandablePanels.slice(0, overflow);
      trimmed.forEach((id) => collapsedSet.add(id));
      expandablePanels = expandablePanels.slice(overflow);
    }

    expandedPanels.push(...expandablePanels);

    const tabEntries = this.buildTabEntries(
      state,
      treeManager,
      collapsedSet
    );

    // Calculate panel widths
    const panelWidths = this.calculateWidths(visiblePanels, expandedPanels);

    return {
      visiblePanels,
      expandedPanels,
      tabEntries,
      panelWidths,
    };
  }

  /**
   * Calculate width percentages for visible panels
   * Note: Collapsed panels will override this with fixed pixel width via CSS
   */
  private calculateWidths(
    visiblePanels: PanelId[],
    expandedPanels: PanelId[]
  ): Map<PanelId, number> {
    const widths = new Map<PanelId, number>();

    // Count collapsed panels
    const collapsedCount = visiblePanels.filter(
      (id) => !expandedPanels.includes(id)
    ).length;

    // Count expanded panels
    const expandedCount = visiblePanels.length - collapsedCount;

    if (expandedCount === 0) {
      // All panels collapsed - they'll use fixed CSS width
      visiblePanels.forEach((id) => widths.set(id, 0));
      return widths;
    }

    // Each expanded panel gets equal share of 100%
    // (Collapsed panels use fixed CSS width, so we ignore them in calculation)
    const expandedWidth = 100 / expandedCount;

    visiblePanels.forEach((id) => {
      if (expandedPanels.includes(id)) {
        widths.set(id, expandedWidth);
      } else {
        // Collapsed - will be overridden by CSS fixed width
        widths.set(id, 0);
      }
    });

    return widths;
  }

  /**
   * Determine which panels should be auto-collapsed based on focus
   * Returns panel IDs that should be auto-collapsed to maintain maxVisiblePanels
   */
  determineAutoCollapse(
    activePath: PanelId[],
    focusedPanel: PanelId | null,
    maxVisiblePanels: number,
    manuallyCollapsed: Set<PanelId>
  ): PanelId[] {
    const toAutoCollapse: PanelId[] = [];

    // Filter out manually collapsed panels
    const expandablePanels = activePath.filter(
      (id) => !manuallyCollapsed.has(id)
    );

    if (expandablePanels.length <= maxVisiblePanels) {
      // No need to auto-collapse
      return toAutoCollapse;
    }

    // Find focused panel index
    const focusedIndex = focusedPanel
      ? expandablePanels.indexOf(focusedPanel)
      : expandablePanels.length - 1;

    if (focusedIndex === -1) {
      // Focus not in expandable panels, collapse from the beginning
      const excess = expandablePanels.length - maxVisiblePanels;
      return expandablePanels.slice(0, excess);
    }

    // Calculate how many panels we can show on each side of focused
    const totalExpanded = maxVisiblePanels;
    let leftCount = Math.floor((totalExpanded - 1) / 2);
    let rightCount = totalExpanded - 1 - leftCount;

    // Adjust if we're near boundaries
    if (focusedIndex < leftCount) {
      // Near start, show more on right
      leftCount = focusedIndex;
      rightCount = totalExpanded - 1 - leftCount;
    } else if (focusedIndex + rightCount >= expandablePanels.length) {
      // Near end, show more on left
      rightCount = expandablePanels.length - focusedIndex - 1;
      leftCount = totalExpanded - 1 - rightCount;
    }

    const startVisible = focusedIndex - leftCount;
    const endVisible = focusedIndex + rightCount;

    // Collapse panels outside the visible range
    for (let i = 0; i < expandablePanels.length; i++) {
      if (i < startVisible || i > endVisible) {
        const panelId = expandablePanels[i];
        if (panelId) {
          toAutoCollapse.push(panelId);
        }
      }
    }

    return toAutoCollapse;
  }

  /**
   * Build unified tab entries for breadcrumbs (collapsed path) and sibling tabs
   */
  private buildTabEntries(
    state: PanelState,
    treeManager: PanelTreeManager,
    collapsedSet: Set<PanelId>
  ): TabEntry[] {
    const entries: TabEntry[] = [];

    state.activePath.forEach((panelId) => {
      if (collapsedSet.has(panelId)) {
        const node = treeManager.getNode(panelId);
        entries.push({
          id: panelId,
          kind: 'path',
          parentId: node?.parentId ?? null,
        });
      }
    });

    const siblingEntries = this.buildSiblingEntries(state, treeManager);
    siblingEntries.forEach((entry) => {
      if (!entries.some((existing) => existing.id === entry.id)) {
        entries.push(entry);
      }
    });

    return entries;
  }

  /**
   * Build sibling tab entries for the currently focused branch
   */
  private buildSiblingEntries(
    state: PanelState,
    treeManager: PanelTreeManager
  ): TabEntry[] {
    const anchorId = this.getSiblingAnchorPanel(state);
    if (!anchorId) {
      return [];
    }

    const node = treeManager.getNode(anchorId);
    if (!node || !node.parentId) {
      return [];
    }

    const parent = treeManager.getNode(node.parentId);
    if (!parent) {
      return [];
    }

    return parent.children
      .filter((childId) => childId !== anchorId)
      .map((childId) => ({
        id: childId,
        kind: 'sibling' as const,
        parentId: parent.id,
      }));
  }

  private getSiblingAnchorPanel(state: PanelState): PanelId | null {
    if (state.focusedPanel && state.activePath.includes(state.focusedPanel)) {
      return state.focusedPanel;
    }
    return state.activePath[state.activePath.length - 1] ?? null;
  }

  /**
   * Calculate smooth transition for panel width changes
   */
  calculateTransitionDuration(widthChange: number): number {
    // Base duration on amount of change
    const baseDuration = 300; // ms
    const maxDuration = 600; // ms

    const duration = Math.min(
      baseDuration + Math.abs(widthChange) * 2,
      maxDuration
    );

    return duration;
  }

  /**
   * Determine if a panel should show its tab strip
   */
  shouldShowTabStrip(
    panelId: PanelId,
    treeManager: PanelTreeManager,
    state: PanelState
  ): boolean {
    const node = treeManager.getNode(panelId);

    if (!node || node.children.length === 0) {
      return false;
    }

    // Show tab strip if panel has multiple children
    // or if the single child is collapsed
    if (node.children.length > 1) {
      return true;
    }

    const [singleChild] = node.children;
    if (!singleChild) {
      return false;
    }
    return state.collapsedPanels.has(singleChild);
  }
}
