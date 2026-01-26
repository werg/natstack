/**
 * PanelDndContext - Drag-and-drop context for the panel tree.
 *
 * Uses @dnd-kit/sortable for accessible drag-and-drop with:
 * - Horizontal offset to determine depth (drag right = nest deeper)
 * - Flattened tree for sortable operations
 * - Visual projection indicator showing where item will land
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
  type ReactNode,
} from "react";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragMoveEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { Box, Text } from "@radix-ui/themes";
import { panel as panelService } from "../client.js";
import {
  usePanelTree,
  flattenTree,
  getProjection,
  removeChildrenOf,
  findParentAtDepth,
  type FlattenedPanel,
} from "./PanelTreeContext.js";

// ============================================================================
// Constants
// ============================================================================

/** Indentation width per depth level in pixels */
export const INDENTATION_WIDTH = 8;

/** Special ID for the end-of-list drop zone */
export const END_DROP_ZONE_ID = "__end_drop_zone__";

// ============================================================================
// Types
// ============================================================================

interface PanelDndContextValue {
  /** ID of the panel currently being dragged */
  activeId: string | null;
  /** ID of the panel being hovered over during drag */
  overId: string | null;
  /** Projected depth for the dragged item */
  projectedDepth: number | null;
  /** ID of the item that should render the drop indicator */
  indicatorItemId: string | null;
  /** Whether indicator should show below target (moving down or nesting) */
  showIndicatorBelow: boolean;
  /** Flattened panel items for rendering */
  flattenedItems: FlattenedPanel[];
  /** Set of collapsed panel IDs */
  collapsedIds: Set<string>;
  /** Toggle collapse state of a panel */
  toggleCollapse: (panelId: string) => void;
  /** Expand multiple panels at once (for batch operations) */
  expandIds: (ids: string[]) => void;
  /** Indent panel (make it child of previous sibling) */
  indentPanel: (panelId: string) => void;
  /** Unindent panel (make it sibling of parent) - only works for last sibling */
  unindentPanel: (panelId: string) => void;
}

const PanelDndContextInner = createContext<PanelDndContextValue | null>(null);

/**
 * Hook to access drag-and-drop state in tree nodes.
 */
export function usePanelDnd(): PanelDndContextValue {
  const context = useContext(PanelDndContextInner);
  if (!context) {
    throw new Error("usePanelDnd must be used within a PanelDndProvider");
  }
  return context;
}

// ============================================================================
// Dragged Panel Preview (shown in DragOverlay)
// ============================================================================

function DraggedPanelPreview({
  title,
  childCount,
}: {
  title: string;
  childCount: number;
}) {
  return (
    <Box
      style={{
        padding: "2px 8px",
        backgroundColor: "var(--gray-a2)",
        border: "1px dashed var(--accent-8)",
        borderRadius: "var(--radius-2)",
        opacity: 0.9,
        maxWidth: "150px",
      }}
    >
      <Text
        size="1"
        style={{
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          color: "var(--gray-11)",
        }}
      >
        {title}
        {childCount > 1 && ` (+${childCount - 1})`}
      </Text>
    </Box>
  );
}

// ============================================================================
// Provider
// ============================================================================

interface PanelDndProviderProps {
  children: ReactNode;
}

export function PanelDndProvider({ children }: PanelDndProviderProps) {
  const { tree, panelMap } = usePanelTree();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [offsetLeft, setOffsetLeft] = useState(0);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  // Ref to track drag start X position
  const dragStartXRef = useRef(0);

  // Load initial collapsed state from DB
  useEffect(() => {
    panelService.getCollapsedIds().then((ids) => {
      setCollapsedIds(new Set(ids));
    });
  }, []);

  // Flatten tree for sortable context
  const flattenedItems = useMemo(
    () => flattenTree(tree, collapsedIds),
    [tree, collapsedIds]
  );

  // Get sortable IDs (excluding children of the dragged item) + end drop zone
  const sortableIds = useMemo(() => {
    const ids = activeId
      ? removeChildrenOf(flattenedItems, [activeId]).map((item) => item.id)
      : flattenedItems.map((item) => item.id);
    // Add end drop zone for dragging items to the end of the tree
    return [...ids, END_DROP_ZONE_ID];
  }, [flattenedItems, activeId]);

  // Calculate end zone projection based on horizontal offset
  const endZoneProjection = useMemo(() => {
    if (!activeId || overId !== END_DROP_ZONE_ID) {
      return null;
    }
    // Calculate depth from horizontal offset
    const dragDepth = Math.round(offsetLeft / INDENTATION_WIDTH);
    const lastItem = flattenedItems[flattenedItems.length - 1];

    // Max depth = last item's depth + 1 (can become child of last item)
    // Min depth = 0 (can become root sibling)
    const maxDepth = lastItem ? lastItem.depth + 1 : 0;
    const depth = Math.max(0, Math.min(maxDepth, dragDepth));

    // Calculate parent based on depth using shared utility
    let parentId: string | null = null;
    if (depth > 0 && lastItem) {
      if (depth === lastItem.depth + 1) {
        // Becoming child of last item
        parentId = lastItem.id;
      } else {
        // Find ancestor at this depth
        parentId = findParentAtDepth(flattenedItems, flattenedItems.length, depth);
      }
    }

    return { depth, parentId };
  }, [activeId, overId, offsetLeft, flattenedItems]);

  // Calculate projection when dragging
  const projection = useMemo(() => {
    if (!activeId || !overId) {
      return null;
    }
    // Use end zone projection if hovering over end zone
    if (overId === END_DROP_ZONE_ID) {
      return endZoneProjection;
    }
    return getProjection(
      flattenedItems,
      activeId,
      overId,
      offsetLeft,
      INDENTATION_WIDTH
    );
  }, [flattenedItems, activeId, overId, offsetLeft, endZoneProjection]);

  // Calculate which item shows the indicator and whether it's at top or bottom
  const { indicatorItemId, showIndicatorBelow } = useMemo(() => {
    if (!activeId || !overId || overId === END_DROP_ZONE_ID) {
      return { indicatorItemId: null, showIndicatorBelow: false };
    }
    const activeIndex = flattenedItems.findIndex((item) => item.id === activeId);
    const overIndex = flattenedItems.findIndex((item) => item.id === overId);

    // In-place horizontal drag - show indicator below the previous item
    if (activeIndex === overIndex) {
      const prevItem = flattenedItems[activeIndex - 1];
      if (prevItem) {
        return { indicatorItemId: prevItem.id, showIndicatorBelow: true };
      }
      // No previous item - show at top of current item
      return { indicatorItemId: overId, showIndicatorBelow: false };
    }

    // Moving down - indicator at bottom of over item
    if (activeIndex < overIndex) {
      return { indicatorItemId: overId, showIndicatorBelow: true };
    }

    // Nesting under immediate preceding sibling - indicator at bottom
    // (we're becoming a child, so insert after/below the parent)
    if (activeIndex > overIndex && overIndex === activeIndex - 1 && projection) {
      const overItem = flattenedItems[overIndex];
      if (overItem && projection.depth > overItem.depth) {
        return { indicatorItemId: overId, showIndicatorBelow: true };
      }
    }

    // Moving up - indicator at top of over item
    return { indicatorItemId: overId, showIndicatorBelow: false };
  }, [activeId, overId, flattenedItems, projection]);

  // Get active panel details
  const activePanel = activeId ? panelMap.get(activeId) : null;
  const activeTitle = activePanel?.title ?? "Panel";
  const activeChildCount = activePanel?.children.length ?? 0;

  // Configure sensors - PointerSensor for mouse, TouchSensor for touch, KeyboardSensor for a11y
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5, // More responsive feel
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 200,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const toggleCollapse = useCallback((panelId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      const nowCollapsed = !next.has(panelId);
      if (nowCollapsed) {
        next.add(panelId);
      } else {
        next.delete(panelId);
      }
      // Fire-and-forget persist
      panelService.setCollapsed(panelId, nowCollapsed);
      return next;
    });
  }, []);

  const expandIds = useCallback((ids: string[]) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        next.delete(id);
      }
      // Fire-and-forget persist
      panelService.expandIds(ids);
      return next;
    });
  }, []);

  const indentPanel = useCallback(async (panelId: string) => {
    const index = flattenedItems.findIndex((i) => i.id === panelId);
    if (index <= 0) return;

    const item = flattenedItems[index];
    const prevItem = flattenedItems[index - 1];

    // Can only indent if previous item exists and is at same or shallower depth
    if (!item || !prevItem || prevItem.depth < item.depth) return;

    const newParent = panelMap.get(prevItem.id);
    const targetPosition = newParent ? newParent.children.length : 0;

    await panelService.movePanel({
      panelId,
      newParentId: prevItem.id,
      targetPosition,
    });
  }, [flattenedItems, panelMap]);

  const unindentPanel = useCallback(async (panelId: string) => {
    const index = flattenedItems.findIndex((i) => i.id === panelId);
    if (index === -1) return;

    const item = flattenedItems[index];
    if (!item || !item.parentId) return; // Not found or already root

    // Check if last sibling (only last sibling can unindent)
    const nextItem = flattenedItems[index + 1];
    if (nextItem && nextItem.parentId === item.parentId) return;

    // Find grandparent
    const parentItem = flattenedItems.find((i) => i.id === item.parentId);
    if (!parentItem) return;

    const grandparentId = parentItem.parentId;
    const currentParentId = item.parentId;

    // Find parent's position among its siblings to place after it
    const siblings = flattenedItems.filter(
      (i) => i.parentId === grandparentId && i.id !== panelId
    );
    const parentIndex = siblings.findIndex((s) => s.id === currentParentId);
    const targetPosition = parentIndex >= 0 ? parentIndex + 1 : siblings.length;

    await panelService.movePanel({
      panelId,
      newParentId: grandparentId,
      targetPosition,
    });
  }, [flattenedItems]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = event.active.id as string;
    setActiveId(id);
    setOverId(id);
    setOffsetLeft(0);

    // Store initial X position - handle different event types
    const activatorEvent = event.activatorEvent;
    if (activatorEvent instanceof MouseEvent || activatorEvent instanceof PointerEvent) {
      dragStartXRef.current = activatorEvent.clientX;
    } else if (activatorEvent instanceof TouchEvent && activatorEvent.touches[0]) {
      dragStartXRef.current = activatorEvent.touches[0].clientX;
    } else {
      // Keyboard or unknown - use 0 (no horizontal offset for keyboard navigation)
      dragStartXRef.current = 0;
    }
  }, []);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    // Calculate horizontal offset from drag start
    // For keyboard navigation, delta.x provides the offset directly
    const activatorEvent = event.activatorEvent;
    let baseX = 0;

    if (activatorEvent instanceof MouseEvent || activatorEvent instanceof PointerEvent) {
      baseX = activatorEvent.clientX;
    } else if (activatorEvent instanceof TouchEvent && activatorEvent.touches[0]) {
      baseX = activatorEvent.touches[0].clientX;
    }
    // For keyboard, baseX stays 0 and delta.x provides the full offset

    const currentX = baseX + event.delta.x;
    setOffsetLeft(currentX - dragStartXRef.current);
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;
    setOverId(over?.id as string | null);
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;

      // Capture projection before resetting state
      const currentProjection = projection;

      // Reset state
      setActiveId(null);
      setOverId(null);
      setOffsetLeft(0);

      if (!over || !currentProjection) {
        return;
      }

      const draggedId = active.id as string;
      const targetId = over.id as string;

      // Build lookup maps once for O(1) access instead of repeated O(N) filter+findIndex
      const indexMap = new Map<string, number>();
      const siblingsByParent = new Map<string | null, FlattenedPanel[]>();

      for (let i = 0; i < flattenedItems.length; i++) {
        const item = flattenedItems[i]!;
        indexMap.set(item.id, i);

        const parentKey = item.parentId;
        let siblings = siblingsByParent.get(parentKey);
        if (!siblings) {
          siblings = [];
          siblingsByParent.set(parentKey, siblings);
        }
        siblings.push(item);
      }

      // Helper functions using the prebuilt maps
      const getIndex = (id: string) => indexMap.get(id) ?? -1;
      const getSiblings = (parentId: string | null, excludeId?: string) => {
        const siblings = siblingsByParent.get(parentId) ?? [];
        return excludeId ? siblings.filter((s) => s.id !== excludeId) : siblings;
      };

      // Find the target's position in its new sibling group
      const { parentId: newParentId, depth: newDepth } = currentProjection;

      // Get current parent of dragged item
      const draggedIndex = getIndex(draggedId);
      const draggedItem = draggedIndex >= 0 ? flattenedItems[draggedIndex] : undefined;
      const currentParentId = draggedItem?.parentId ?? null;

      // Check if this is a "depth change in place" (same position, different parent)
      const isDepthChangeInPlace = active.id === over.id;

      // If nothing changed, skip the move
      if (isDepthChangeInPlace && newParentId === currentParentId) {
        return;
      }

      try {
        // Handle end drop zone - position at end of sibling group
        if (targetId === END_DROP_ZONE_ID) {
          const siblings = getSiblings(newParentId, draggedId);
          await panelService.movePanel({
            panelId: draggedId,
            newParentId,
            targetPosition: siblings.length,
          });
          return;
        }

        // Find where in the new parent's children we should insert
        const overIndex = getIndex(targetId);
        const activeIndex = draggedIndex;

        // Calculate target position among siblings
        let targetPosition = 0;

        if (isDepthChangeInPlace) {
          // Depth change in place - calculate position based on new parent
          if (newParentId) {
            const newParent = panelMap.get(newParentId);
            if (newParent) {
              if (newParentId === currentParentId) {
                // Same parent, no change needed
                return;
              }
              // Check if we're becoming a child of our previous sibling (indent)
              const prevItem = activeIndex > 0 ? flattenedItems[activeIndex - 1] : undefined;
              if (prevItem && prevItem.id === newParentId) {
                // Becoming child of previous sibling - go to end of its children
                targetPosition = newParent.children.filter((c) => c.id !== draggedId).length;
              } else {
                // Unindenting - find position after our former parent in new sibling group
                const siblings = getSiblings(newParentId, draggedId);
                // Find our former parent's position among new siblings
                const formerParentIndex = siblings.findIndex((s) => s.id === currentParentId);
                targetPosition = formerParentIndex >= 0 ? formerParentIndex + 1 : siblings.length;
              }
            }
          } else {
            // Moving to root level
            const rootItems = getSiblings(null, draggedId);
            // Find our former parent's position among roots
            const formerParentIndex = rootItems.findIndex((s) => s.id === currentParentId);
            targetPosition = formerParentIndex >= 0 ? formerParentIndex + 1 : rootItems.length;
          }
        } else if (newParentId) {
          const parent = panelMap.get(newParentId);
          if (parent) {
            // Find position among siblings with the same parent
            const siblings = getSiblings(newParentId, draggedId);
            const siblingIndex = siblings.findIndex((item) => item.id === targetId);

            if (siblingIndex >= 0) {
              targetPosition = overIndex > activeIndex ? siblingIndex + 1 : siblingIndex;
            } else if (newDepth > 0) {
              // Becoming first child of parent
              targetPosition = 0;
            }
          }
        } else {
          // Moving to root level
          const rootItems = getSiblings(null, draggedId);
          const rootIndex = rootItems.findIndex((item) => item.id === targetId);

          if (rootIndex >= 0) {
            targetPosition = overIndex > activeIndex ? rootIndex + 1 : rootIndex;
          }
        }

        await panelService.movePanel({
          panelId: draggedId,
          newParentId,
          targetPosition: Math.max(0, targetPosition),
        });
      } catch (error) {
        console.error("[PanelDndContext] Failed to move panel", {
          error,
          draggedId,
          targetId,
          projection: currentProjection,
        });
      }
    },
    [flattenedItems, panelMap, projection]
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setOverId(null);
    setOffsetLeft(0);
  }, []);

  const contextValue = useMemo<PanelDndContextValue>(
    () => ({
      activeId,
      overId,
      projectedDepth: projection?.depth ?? null,
      indicatorItemId,
      showIndicatorBelow,
      flattenedItems,
      collapsedIds,
      toggleCollapse,
      expandIds,
      indentPanel,
      unindentPanel,
    }),
    [activeId, overId, projection, indicatorItemId, showIndicatorBelow, flattenedItems, collapsedIds, toggleCollapse, expandIds, indentPanel, unindentPanel]
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      measuring={{
        droppable: {
          strategy: MeasuringStrategy.Always,
        },
      }}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        <PanelDndContextInner.Provider value={contextValue}>
          {children}
          <DragOverlay dropAnimation={null}>
            {activeId && (
              <DraggedPanelPreview
                title={activeTitle}
                childCount={activeChildCount + 1}
              />
            )}
          </DragOverlay>
        </PanelDndContextInner.Provider>
      </SortableContext>
    </DndContext>
  );
}
