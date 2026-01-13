import type { PanelSummary, PanelAncestor, DescendantSiblingGroup } from "../../shared/ipc/types.js";

export type NavigationMode = "stack" | "tree";

// Re-export for convenience
export type { PanelSummary, PanelAncestor, DescendantSiblingGroup };

/**
 * Lazy title navigation data using PanelSummary.
 * Used for breadcrumbs and sibling tabs.
 */
export interface LazyTitleNavigationData {
  ancestors: PanelAncestor[];
  currentSiblings: PanelSummary[];
  currentId: string;
  currentTitle: string;
}

/**
 * Lazy status navigation data using descendant sibling groups.
 * Used for breadcrumb bar showing selected descendants with siblings.
 */
export interface LazyStatusNavigationData {
  descendantGroups: DescendantSiblingGroup[];
  visiblePanelId: string;
}
