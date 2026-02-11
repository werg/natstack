/**
 * PanelTreeContext - Stores panel tree from main process events.
 *
 * This context eliminates the race condition between main process DB writes
 * and renderer DB reads by using the event payload directly instead of querying
 * the database.
 *
 * The panel tree is sent with the `panel-tree-updated` event from the main process.
 * All navigation data (ancestors, siblings, descendants) is derived synchronously
 * from this in-memory tree.
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { useShellEvent } from "../useShellEvent.js";
import { panel as panelService } from "../client.js";
import type {
  Panel,
  PanelSummary,
  PanelAncestor,
  DescendantSiblingGroup,
} from "../../../shared/types.js";
import {
  getPanelType,
  getPanelContextId,
  getPanelSource,
  getPanelOptions,
  getCurrentSnapshot,
  getShellPage,
  getBrowserResolvedUrl,
} from "../../../shared/panel/accessors.js";

// Re-export types for consumers
export type { PanelSummary, PanelAncestor, DescendantSiblingGroup };

// ============================================================================
// Types
// ============================================================================

/**
 * Full panel data including type-specific fields.
 */
export interface FullPanel {
  id: string;
  type: "app" | "worker" | "browser" | "shell";
  title: string;
  contextId: string;
  parentId: string | null;
  position: number;
  selectedChildId: string | null;
  artifacts: {
    htmlPath?: string;
    bundlePath?: string;
    error?: string;
    buildState?: string;
    buildProgress?: string;
    buildLog?: string;
    dirtyRepoPath?: string;
    notGitRepoPath?: string;
  };
  // Type-specific fields
  path?: string;
  url?: string;
  browserState?: {
    pageTitle: string;
    isLoading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
  };
  page?: string;
  sourceRepo?: string;
  gitRef?: string;
  injectHostThemeVariables?: boolean;
  unsafe?: boolean | string;
  resolvedRepoArgs?: Record<string, unknown>;
  workerOptions?: { unsafe?: boolean | string };
}

// ============================================================================
// Tree Utilities
// ============================================================================

/**
 * Flattened panel item for sortable tree operations.
 * Contains the panel plus its tree position metadata.
 */
export interface FlattenedPanel {
  id: string;
  parentId: string | null;
  depth: number;
  index: number;
  panel: PanelSummary;
  collapsed: boolean;
}

/**
 * Flatten the tree into a sorted list for sortable operations.
 * Collapsed nodes have their children excluded.
 * Uses mutation for O(n) performance instead of O(n²) spread operations.
 */
export function flattenTree(
  panels: Panel[],
  collapsedIds: Set<string>,
  parentId: string | null = null,
  depth = 0,
  result: FlattenedPanel[] = []
): FlattenedPanel[] {
  for (let index = 0; index < panels.length; index++) {
    const panel = panels[index]!;
    const isCollapsed = collapsedIds.has(panel.id);

    result.push({
      id: panel.id,
      parentId,
      depth,
      index,
      panel: {
        id: panel.id,
        type: getPanelType(panel),
        title: panel.title,
        childCount: panel.children.length,
        buildState: panel.artifacts?.buildState,
        position: index,
      },
      collapsed: isCollapsed,
    });

    if (!isCollapsed && panel.children.length > 0) {
      flattenTree(panel.children, collapsedIds, panel.id, depth + 1, result);
    }
  }
  return result;
}

/**
 * Calculate the projected depth and parent for a drag operation.
 * Based on horizontal offset from drag start position.
 */
export function getProjection(
  items: FlattenedPanel[],
  activeId: string,
  overId: string,
  dragOffset: number,
  indentationWidth: number
): { depth: number; parentId: string | null } {
  const overItemIndex = items.findIndex((item) => item.id === overId);
  const activeItemIndex = items.findIndex((item) => item.id === activeId);

  if (overItemIndex === -1 || activeItemIndex === -1) {
    return { depth: 0, parentId: null };
  }

  const activeItem = items[activeItemIndex]!;
  const overItem = items[overItemIndex]!;

  // Check if dragging up to immediate preceding sibling
  // In this case, we want to allow nesting under the over item
  const isDraggingUpToImmediatePreceding =
    activeItemIndex > overItemIndex && overItemIndex === activeItemIndex - 1;

  // Calculate what would be previous/next WITHOUT array copy
  // This avoids O(n) allocation on every drag move (~60fps)
  let previousItem: FlattenedPanel | undefined;
  let nextItem: FlattenedPanel | undefined;

  if (activeItemIndex < overItemIndex) {
    // Item moves down: after removal, indices shift down by 1
    previousItem = items[overItemIndex];
    nextItem = items[overItemIndex + 1];
  } else if (activeItemIndex > overItemIndex) {
    // Item moves up: removal doesn't affect indices before overItemIndex
    previousItem = items[overItemIndex - 1];
    nextItem = items[overItemIndex];
  } else {
    // Same position (shouldn't happen but handle gracefully)
    previousItem = items[overItemIndex - 1];
    nextItem = items[overItemIndex + 1];
  }

  // Calculate drag depth from horizontal offset
  const dragDepth = Math.round(dragOffset / indentationWidth);
  const projectedDepth = activeItem.depth + dragDepth;

  // Max depth = previous item's depth + 1 (can become child of previous)
  // Special case: when dragging up to immediate preceding sibling with rightward offset,
  // allow nesting under that sibling (overItem becomes potential parent)
  let maxDepth = previousItem ? previousItem.depth + 1 : 0;
  if (isDraggingUpToImmediatePreceding && dragOffset > 0) {
    // When dragging right while hovering over immediate preceding sibling,
    // allow becoming a child of that sibling
    maxDepth = Math.max(maxDepth, overItem.depth + 1);
  }

  // Min depth = next item's depth (can't be shallower than next sibling)
  // But if we're becoming a child of the over item, we don't have this constraint
  let minDepth = nextItem ? nextItem.depth : 0;
  if (isDraggingUpToImmediatePreceding && projectedDepth > overItem.depth) {
    // When nesting under the over item, we're inserting as its child,
    // not between it and its existing children
    minDepth = 0;
  }

  // For in-place depth changes, only allow unindenting if we're the last sibling.
  // Unindenting a middle sibling would leave subsequent siblings orphaned.
  if (activeItemIndex === overItemIndex) {
    if (nextItem && nextItem.parentId === activeItem.parentId) {
      // There's a sibling after us - can't unindent past current depth
      minDepth = Math.max(minDepth, activeItem.depth);
    }
  }

  // Clamp projected depth
  let depth = projectedDepth;
  if (projectedDepth >= maxDepth) {
    depth = maxDepth;
  } else if (projectedDepth < minDepth) {
    depth = minDepth;
  }

  // Calculate parent ID based on final depth
  const parentId = getParentId();

  return { depth, parentId };

  function getParentId(): string | null {
    if (depth === 0 || !previousItem) {
      // Special case: nesting under immediate preceding sibling
      if (isDraggingUpToImmediatePreceding && depth > overItem.depth) {
        return overItem.id;
      }
      return null;
    }

    if (depth === previousItem.depth) {
      // Same level as previous - share parent
      return previousItem.parentId;
    }

    if (depth > previousItem.depth) {
      // Deeper than previous - previous is the parent
      // But check if we should nest under overItem instead
      if (isDraggingUpToImmediatePreceding && depth === overItem.depth + 1) {
        return overItem.id;
      }
      return previousItem.id;
    }

    // Shallower than previous - find ancestor at this depth using backward scan
    // When moving down, we need to include overItemIndex in the scan and skip activeItemIndex
    // When moving up, scan from overItemIndex - 1 (activeItemIndex is above scan range)
    const scanStart = activeItemIndex < overItemIndex ? overItemIndex : overItemIndex - 1;
    for (let i = scanStart; i >= 0; i--) {
      if (i === activeItemIndex) continue; // Skip the item being dragged
      const item = items[i];
      if (!item) continue;
      if (item.depth === depth) {
        return item.parentId;
      }
    }

    return null;
  }
}

/**
 * Remove children of specified items from the flattened list.
 * Used to exclude descendants of dragged items.
 */
export function removeChildrenOf(
  items: FlattenedPanel[],
  ids: string[]
): FlattenedPanel[] {
  const excludeParentIds = new Set(ids);

  return items.filter((item) => {
    if (item.parentId && excludeParentIds.has(item.parentId)) {
      excludeParentIds.add(item.id);
      return false;
    }
    return true;
  });
}

/**
 * Build flat maps for O(1) lookup of panels and their parent IDs.
 */
function buildPanelMaps(panels: Panel[]): {
  panelMap: Map<string, Panel>;
  parentMap: Map<string, string | null>;
} {
  const panelMap = new Map<string, Panel>();
  const parentMap = new Map<string, string | null>();

  function traverse(panel: Panel, parentId: string | null): void {
    panelMap.set(panel.id, panel);
    parentMap.set(panel.id, parentId);
    for (const child of panel.children) {
      traverse(child, panel.id);
    }
  }

  for (const root of panels) {
    traverse(root, null);
  }

  return { panelMap, parentMap };
}

/**
 * Find parent ID for a given depth by walking backwards through items.
 * Used by both getProjection and endZoneProjection.
 */
export function findParentAtDepth(
  items: FlattenedPanel[],
  fromIndex: number,
  targetDepth: number
): string | null {
  if (targetDepth === 0) return null;

  for (let i = fromIndex - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;
    if (item.depth === targetDepth - 1) {
      return item.id;
    }
    if (item.depth < targetDepth - 1) {
      return item.parentId;
    }
  }

  return null;
}

/**
 * Convert Panel to PanelSummary.
 */
function panelToSummary(panel: Panel, position: number): PanelSummary {
  return {
    id: panel.id,
    type: getPanelType(panel),
    title: panel.title,
    childCount: panel.children.length,
    buildState: panel.artifacts?.buildState,
    position,
  };
}

/**
 * Convert Panel to FullPanel with resolved parent ID.
 */
function panelToFull(panel: Panel, parentId: string | null, position: number): FullPanel {
  const panelType = getPanelType(panel);
  const options = getPanelOptions(panel);
  const snapshot = getCurrentSnapshot(panel);

  const base: FullPanel = {
    id: panel.id,
    type: panelType,
    title: panel.title,
    contextId: getPanelContextId(panel),
    parentId,
    position,
    selectedChildId: panel.selectedChildId,
    artifacts: panel.artifacts ?? {},
  };

  // Add type-specific fields
  if (panelType === "app") {
    return {
      ...base,
      path: getPanelSource(panel),
      sourceRepo: getPanelSource(panel),
      gitRef: options.gitRef,
      injectHostThemeVariables: true, // Default for app panels
      unsafe: options.unsafe,
      resolvedRepoArgs: options.repoArgs,
    };
  }

  if (panelType === "worker") {
    return {
      ...base,
      path: getPanelSource(panel),
      sourceRepo: getPanelSource(panel),
      gitRef: options.gitRef,
      workerOptions: { unsafe: options.unsafe },
      resolvedRepoArgs: options.repoArgs,
    };
  }

  if (panelType === "browser") {
    return {
      ...base,
      url: getBrowserResolvedUrl(panel) ?? getPanelSource(panel),
      browserState: snapshot.browserState,
      injectHostThemeVariables: false,
    };
  }

  if (panelType === "shell") {
    return {
      ...base,
      page: getShellPage(panel),
      injectHostThemeVariables: true,
    };
  }

  return base;
}

// ============================================================================
// Context
// ============================================================================

interface PanelTreeContextValue {
  /** The full panel tree from the main process */
  tree: Panel[];
  /** Flat map of all panels for O(1) lookup */
  panelMap: Map<string, Panel>;
  /** Flat map of panel ID to parent ID for O(1) parent lookup */
  parentMap: Map<string, string | null>;
  /** Whether the tree has been initialized (received at least one event) */
  initialized: boolean;
}

const PanelTreeContext = createContext<PanelTreeContextValue | null>(null);

function usePanelTreeContext(): PanelTreeContextValue {
  const context = useContext(PanelTreeContext);
  if (!context) {
    throw new Error("usePanelTreeContext must be used within a PanelTreeProvider");
  }
  return context;
}

/**
 * Hook to access the raw panel tree and panel map.
 * Used by PanelDndContext for drag-and-drop operations.
 */
export function usePanelTree(): PanelTreeContextValue {
  return usePanelTreeContext();
}


// ============================================================================
// Provider
// ============================================================================

interface PanelTreeProviderProps {
  children: ReactNode;
}

export function PanelTreeProvider({ children }: PanelTreeProviderProps) {
  const [tree, setTree] = useState<Panel[]>([]);
  const [initialized, setInitialized] = useState(false);
  // Track if we've received a real-time event (always newer than getTree result)
  const receivedEventRef = useRef(false);

  // Handle panel tree updates from main process
  const handleTreeUpdate = useCallback((data: unknown) => {
    if (!Array.isArray(data)) {
      console.error("[PanelTreeContext] Invalid tree data received:", data);
      return;
    }
    receivedEventRef.current = true;
    setTree(data as Panel[]);
    setInitialized(true);
  }, []);

  // Subscribe to panel-tree-updated events
  useShellEvent("panel-tree-updated", handleTreeUpdate);

  // Fetch initial tree on mount to handle race condition where
  // the event may have been emitted before we subscribed.
  // Only use getTree result if we haven't received an event yet,
  // since events are always more recent.
  useEffect(() => {
    let mounted = true;

    panelService.getTree().then((initialTree) => {
      if (mounted && !receivedEventRef.current) {
        setTree(initialTree);
        setInitialized(true);
      }
    }).catch((error) => {
      console.error("[PanelTreeProvider] Failed to fetch initial tree:", error);
      // Still mark as initialized so we don't show infinite spinner
      if (mounted && !receivedEventRef.current) {
        setInitialized(true);
      }
    });

    return () => {
      mounted = false;
    };
  }, []);

  // Build panel maps for efficient lookups
  const { panelMap, parentMap } = useMemo(() => buildPanelMaps(tree), [tree]);

  const value = useMemo<PanelTreeContextValue>(
    () => ({ tree, panelMap, parentMap, initialized }),
    [tree, panelMap, parentMap, initialized]
  );

  return (
    <PanelTreeContext.Provider value={value}>
      {children}
    </PanelTreeContext.Provider>
  );
}

// ============================================================================
// Hooks - Synchronous navigation data derived from in-memory tree
// ============================================================================

/**
 * Get root panels.
 */
export function useRootPanels(): {
  panels: PanelSummary[];
  loading: boolean;
} {
  const { tree, initialized } = usePanelTreeContext();

  const panels = useMemo(
    () => tree.map((panel, index) => panelToSummary(panel, index)),
    [tree]
  );

  return { panels, loading: !initialized };
}

/**
 * Get a panel by ID with full details.
 */
export function useFullPanel(panelId: string | null): {
  panel: FullPanel | null;
  loading: boolean;
} {
  const { tree, panelMap, parentMap, initialized } = usePanelTreeContext();

  const panel = useMemo(() => {
    if (!panelId) return null;

    const found = panelMap.get(panelId);
    if (!found) return null;

    const parentId = parentMap.get(panelId) ?? null;

    // Find position among siblings
    let position = 0;
    if (parentId) {
      const parent = panelMap.get(parentId);
      if (parent) {
        position = parent.children.findIndex((c) => c.id === panelId);
      }
    } else {
      position = tree.findIndex((r) => r.id === panelId);
    }

    return panelToFull(found, parentId, position);
  }, [tree, panelMap, panelId]);

  return { panel, loading: !initialized };
}

/**
 * Get siblings of a panel (including the panel itself).
 */
export function useSiblings(panelId: string | null): {
  siblings: PanelSummary[];
  loading: boolean;
} {
  const { tree, panelMap, parentMap, initialized } = usePanelTreeContext();

  const siblings = useMemo(() => {
    if (!panelId) return [];

    const parentId = parentMap.get(panelId) ?? null;

    if (!parentId) {
      // Panel is a root - siblings are all roots
      return tree.map((panel, index) => panelToSummary(panel, index));
    }

    const parent = panelMap.get(parentId);
    if (!parent) return [];

    return parent.children.map((child, index) => panelToSummary(child, index));
  }, [tree, panelMap, panelId]);

  return { siblings, loading: !initialized };
}

/**
 * Get ancestors of a panel (for breadcrumb navigation).
 * Returns ancestors from root to immediate parent (root first).
 */
export function useAncestors(panelId: string | null): {
  ancestors: PanelAncestor[];
  loading: boolean;
} {
  const { panelMap, parentMap, initialized } = usePanelTreeContext();

  const ancestors = useMemo(() => {
    if (!panelId) return [];

    const result: PanelAncestor[] = [];
    let currentId: string | null = panelId;
    let depth = 0;

    // Walk up the tree to collect ancestors using O(1) parentMap lookups
    while (currentId) {
      const parentId: string | null = parentMap.get(currentId) ?? null;
      if (!parentId) break;

      const parent = panelMap.get(parentId);
      if (!parent) break;

      depth++;
      result.unshift({
        id: parent.id,
        title: parent.title,
        type: getPanelType(parent),
        depth,
      });

      currentId = parentId;
    }

    // Renumber depths from root (highest number = closest to root)
    const maxDepth = result.length;
    return result.map((a, index) => ({
      ...a,
      depth: maxDepth - index,
    }));
  }, [panelMap, parentMap, panelId]);

  return { ancestors, loading: !initialized };
}

/** Maximum depth to traverse when building descendant sibling groups for breadcrumbs */
export const DEFAULT_DESCENDANT_DEPTH = 3;

/**
 * Get sibling groups along the selected descendant path.
 * For each level, returns all siblings with the selected one marked.
 * This enables breadcrumb rendering where users can switch between siblings.
 */
export function useDescendantSiblingGroups(
  panelId: string | null,
  maxDepth: number = DEFAULT_DESCENDANT_DEPTH
): {
  groups: DescendantSiblingGroup[];
  loading: boolean;
} {
  const { panelMap, initialized } = usePanelTreeContext();

  const groups = useMemo(() => {
    if (!panelId) return [];

    const result: DescendantSiblingGroup[] = [];
    let currentPanel = panelMap.get(panelId);
    let depth = 0;

    // Walk down the selected path
    while (currentPanel && depth < maxDepth) {
      const selectedChildId = currentPanel.selectedChildId;
      if (!selectedChildId) break;

      // Check if selected child exists
      const selectedChild = panelMap.get(selectedChildId);
      if (!selectedChild) break;

      depth++;

      // Get all siblings (children of current panel)
      const siblings = currentPanel.children.map((child, index) =>
        panelToSummary(child, index)
      );

      result.push({
        depth,
        parentId: currentPanel.id,
        selectedId: selectedChildId,
        siblings,
      });

      // Move to the selected child
      currentPanel = selectedChild;
    }

    return result;
  }, [panelMap, panelId, maxDepth]);

  return { groups, loading: !initialized };
}

// ============================================================================
// Re-exports for compatibility
// ============================================================================

export type { Panel };
