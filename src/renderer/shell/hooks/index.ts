/**
 * Shell Hooks - React hooks for shell functionality.
 *
 * These hooks provide access to panel tree data and other shell features.
 */

// Panel tree hooks - synchronous, derived from event-based context
export {
  PanelTreeProvider,
  usePanelTree,
  useRootPanels,
  useSiblings,
  useAncestors,
  useFullPanel,
  useDescendantSiblingGroups,
  flattenTree,
  getProjection,
  removeChildrenOf,
  findParentAtDepth,
  type PanelSummary,
  type PanelAncestor,
  type DescendantSiblingGroup,
  type FullPanel,
  type FlattenedPanel,
} from "./PanelTreeContext.js";

// Drag-and-drop context for panel tree
export {
  PanelDndProvider,
  usePanelDnd,
  INDENTATION_WIDTH,
  END_DROP_ZONE_ID,
} from "./PanelDndContext.js";
