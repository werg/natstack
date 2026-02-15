/**
 * LazyPanelTreeSidebar - Sortable panel tree sidebar with drag-and-drop.
 *
 * Features:
 * - Horizontal offset determines nesting depth (drag right = nest deeper)
 * - Flattened tree rendered as sortable list
 * - Projected depth indicator shows where item will land
 * - Context menu for panel actions
 */

import { useState, useCallback, useEffect, useMemo, useRef, memo, type CSSProperties } from "react";
import {
  CaretRightIcon,
  Cross2Icon,
  PlusIcon,
} from "@radix-ui/react-icons";
import {
  Badge,
  Box,
  Flex,
  IconButton,
  Text,
} from "@radix-ui/themes";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useVirtualizer } from "@tanstack/react-virtual";

import {
  usePanelDndTree,
  usePanelDndDrag,
  INDENTATION_WIDTH,
  END_DROP_ZONE_ID,
  type FlattenedPanel,
} from "../shell/hooks/index.js";
import type { PanelContextMenuAction } from "../../shared/types.js";
import { menu, panel } from "../shell/client.js";

// ============================================================================
// Style Constants
// ============================================================================

const EXPAND_BUTTON_SIZE = 12;
const BUILD_INDICATOR_SIZE = 6;

/** Delay before auto-expanding collapsed item during drag hover (ms) */
const AUTO_EXPAND_DELAY_MS = 600;

const COLORS = {
  selected: "var(--gray-a4)",
  selectedHover: "var(--gray-a5)",
  hover: "var(--gray-a3)",
  dropIndicator: "var(--accent-9)",
  connector: "var(--gray-a5)",
} as const;

// ============================================================================
// Style Helpers
// ============================================================================

function getDropIndicatorStyle(depth: number, top: number | string): CSSProperties {
  return {
    position: "absolute",
    left: depth * INDENTATION_WIDTH + 4,
    right: 4,
    height: 2,
    backgroundColor: COLORS.dropIndicator,
    borderRadius: 1,
    top,
    zIndex: 1,
  };
}

function getRowBackground(
  isSelected: boolean,
  isHovered: boolean
): string | undefined {
  if (isSelected) return isHovered ? COLORS.selectedHover : COLORS.selected;
  if (isHovered) return COLORS.hover;
  return undefined;
}

// ============================================================================
// Sortable Tree Item Component
// ============================================================================

interface SortableTreeItemProps {
  item: FlattenedPanel;
  isSelected: boolean;
  showIndicator: boolean;
  projectedDepth: number | null;
  isDraggingAny: boolean;
  showIndicatorBelow: boolean;
  onSelect: (panelId: string) => void;
  onToggleCollapse: (panelId: string) => void;
  onPanelAction?: (panelId: string, action: PanelContextMenuAction) => void;
  onArchive?: (panelId: string) => void;
  onIndent: (panelId: string) => void;
  onUnindent: (panelId: string) => void;
}

const SortableTreeItem = memo(function SortableTreeItem({
  item,
  isSelected,
  showIndicator,
  projectedDepth,
  isDraggingAny,
  showIndicatorBelow,
  onSelect,
  onToggleCollapse,
  onPanelAction,
  onArchive,
  onIndent,
  onUnindent,
}: SortableTreeItemProps) {
  const { panel, depth, collapsed } = item;
  const [isHovered, setIsHovered] = useState(false);
  const expandTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear expand timeout on unmount
  useEffect(() => {
    return () => {
      if (expandTimeoutRef.current) {
        clearTimeout(expandTimeoutRef.current);
      }
    };
  }, []);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: panel.id });

  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.2 : 1,
  };

  const hasChildren = panel.childCount > 0;

  // Build state indicator color
  const buildStateColor = useMemo(() => {
    switch (panel.buildState) {
      case "building":
      case "cloning":
        return "var(--amber-9)";
      case "error":
        return "var(--red-9)";
      case "pending":
        return "var(--gray-8)";
      default:
        return undefined;
    }
  }, [panel.buildState]);

  const handleContextMenu = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const { screenX, screenY } = e;
      const action = await menu.showPanelContext(panel.id, panel.type, {
        x: Math.round(screenX),
        y: Math.round(screenY),
      });
      if (action) {
        onPanelAction?.(panel.id, action);
      }
    },
    [panel.id, panel.type, onPanelAction]
  );

  const handleToggleExpand = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleCollapse(panel.id);
    },
    [panel.id, onToggleCollapse]
  );

  const handleSelect = useCallback(() => {
    onSelect(panel.id);
  }, [onSelect, panel.id]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Tab") {
        e.preventDefault();
        if (e.shiftKey) {
          onUnindent(panel.id);
        } else {
          onIndent(panel.id);
        }
      }
    },
    [panel.id, onIndent, onUnindent]
  );

  const handleArchive = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onArchive?.(panel.id);
    },
    [panel.id, onArchive]
  );

  // Connector line for visual hierarchy (only for non-root nodes)
  const connectorStyle: CSSProperties = depth > 0 ? {
    borderLeft: `1px solid ${COLORS.connector}`,
    marginLeft: depth * INDENTATION_WIDTH - 1,
    paddingLeft: 4,
  } : {
    marginLeft: depth * INDENTATION_WIDTH,
  };

  const rowStyle: CSSProperties = {
    cursor: "pointer",
    backgroundColor: getRowBackground(isSelected, isHovered),
    borderRadius: "var(--radius-2)",
    transition: "background-color 100ms ease-out",
  };

  // Show drop indicator when this item is designated to show it
  const showDropIndicator = showIndicator && projectedDepth !== null;

  return (
    <Box
      ref={setNodeRef}
      style={{
        position: "relative",
        ...style,
        ...connectorStyle,
      }}
    >
      {showDropIndicator && (
        <Box style={getDropIndicatorStyle(projectedDepth, showIndicatorBelow ? "100%" : -1)} />
      )}

      <Flex
        {...attributes}
        {...listeners}
        tabIndex={isSelected ? 0 : -1}
        onKeyDown={handleKeyDown}
        align="center"
        gap="1"
        px="1"
        py="1"
        style={rowStyle}
        data-active={isSelected ? "true" : "false"}
        onClick={handleSelect}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => {
          if (!isDraggingAny) {
            setIsHovered(true);
          } else if (collapsed && hasChildren) {
            // Auto-expand after delay during drag hover
            expandTimeoutRef.current = setTimeout(() => {
              onToggleCollapse(panel.id);
            }, AUTO_EXPAND_DELAY_MS);
          }
        }}
        onMouseLeave={() => {
          setIsHovered(false);
          if (expandTimeoutRef.current) {
            clearTimeout(expandTimeoutRef.current);
            expandTimeoutRef.current = null;
          }
        }}
      >
        {/* Expand/collapse button */}
        {hasChildren ? (
          <IconButton
            size="1"
            variant="ghost"
            color="gray"
            aria-label={collapsed ? "Expand" : "Collapse"}
            onClick={handleToggleExpand}
            style={{
              width: EXPAND_BUTTON_SIZE,
              height: EXPAND_BUTTON_SIZE,
              transition: "transform 150ms ease",
              transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
            }}
          >
            <CaretRightIcon />
          </IconButton>
        ) : (
          <Box style={{ width: EXPAND_BUTTON_SIZE, height: EXPAND_BUTTON_SIZE, flexShrink: 0 }} />
        )}

        {/* Title */}
        <Text
          size="2"
          weight={isSelected ? "medium" : "regular"}
          style={{
            flex: 1,
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            color: isSelected ? "var(--gray-12)" : "var(--gray-11)",
          }}
        >
          {panel.title}
        </Text>

        {/* Child count badge */}
        {hasChildren && (
          <Badge
            size="1"
            variant="soft"
            color="gray"
            radius="full"
            style={{ fontSize: "10px", flexShrink: 0 }}
          >
            {panel.childCount}
          </Badge>
        )}

        {/* Build state indicator */}
        {buildStateColor && (
          <Box
            style={{
              width: BUILD_INDICATOR_SIZE,
              height: BUILD_INDICATOR_SIZE,
              borderRadius: "50%",
              backgroundColor: buildStateColor,
              flexShrink: 0,
            }}
          />
        )}

        {/* Archive (X) button - shown on hover, hidden during drag */}
        {isHovered && !isDraggingAny && (
          <IconButton
            size="1"
            variant="ghost"
            color="gray"
            aria-label="Archive panel"
            onClick={handleArchive}
            style={{
              width: 16,
              height: 16,
              flexShrink: 0,
              opacity: 0.7,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = "1";
              e.currentTarget.style.backgroundColor = "var(--red-a4)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = "0.7";
              e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <Cross2Icon width={10} height={10} />
          </IconButton>
        )}
      </Flex>
    </Box>
  );
}, (prev, next) => {
  // Custom comparator: compare specific fields that affect rendering,
  // since flattenTree() creates fresh FlattenedPanel objects every call.
  return (
    prev.item.id === next.item.id &&
    prev.item.depth === next.item.depth &&
    prev.item.collapsed === next.item.collapsed &&
    prev.item.parentId === next.item.parentId &&
    prev.item.panel.title === next.item.panel.title &&
    prev.item.panel.type === next.item.panel.type &&
    prev.item.panel.childCount === next.item.panel.childCount &&
    prev.item.panel.buildState === next.item.panel.buildState &&
    prev.isSelected === next.isSelected &&
    prev.showIndicator === next.showIndicator &&
    prev.projectedDepth === next.projectedDepth &&
    prev.isDraggingAny === next.isDraggingAny &&
    prev.showIndicatorBelow === next.showIndicatorBelow &&
    prev.onSelect === next.onSelect &&
    prev.onToggleCollapse === next.onToggleCollapse &&
    prev.onPanelAction === next.onPanelAction &&
    prev.onArchive === next.onArchive &&
    prev.onIndent === next.onIndent &&
    prev.onUnindent === next.onUnindent
  );
});

// ============================================================================
// End Drop Zone Component
// ============================================================================

interface EndDropZoneProps {
  isOver: boolean;
  projectedDepth: number | null;
  isDragging: boolean;
}

function EndDropZone({ isOver, projectedDepth, isDragging }: EndDropZoneProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
  } = useSortable({ id: END_DROP_ZONE_ID });

  const showIndicator = isOver && projectedDepth !== null;

  return (
    <Box
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{
        position: "relative",
        minHeight: isDragging ? 32 : 16,
        marginTop: 4,
        borderTop: isDragging && !showIndicator ? "1px dashed var(--gray-a6)" : undefined,
        transition: "min-height 150ms ease",
      }}
    >
      {showIndicator && <Box style={getDropIndicatorStyle(projectedDepth, 0)} />}
    </Box>
  );
}

// ============================================================================
// Sidebar Component
// ============================================================================

interface LazyPanelTreeSidebarProps {
  selectedId: string | null;
  ancestorIds: string[];
  onSelect: (panelId: string) => void;
  onPanelAction?: (panelId: string, action: PanelContextMenuAction) => void;
  onArchive?: (panelId: string) => void;
}

export function LazyPanelTreeSidebar({
  selectedId,
  ancestorIds,
  onSelect,
  onPanelAction,
  onArchive,
}: LazyPanelTreeSidebarProps) {
  const {
    flattenedItems,
    collapsedIds,
    toggleCollapse,
    expandIds,
    indentPanel,
    unindentPanel,
  } = usePanelDndTree();

  const {
    activeId,
    overId,
    projectedDepth,
    indicatorItemId,
    showIndicatorBelow,
  } = usePanelDndDrag();

  // Auto-expand ancestors of selected panel (batched for performance)
  useEffect(() => {
    if (ancestorIds.length > 0) {
      const toExpand = ancestorIds.filter((id) => collapsedIds.has(id));
      if (toExpand.length > 0) {
        expandIds(toExpand);
      }
    }
  }, [ancestorIds, collapsedIds, expandIds]);

  const handleNewPanel = useCallback(async () => {
    const result = await panel.createShellPanel("new");
    window.dispatchEvent(new CustomEvent("shell-panel-created", {
      detail: { panelId: result.id }
    }));
  }, []);

  // Scroll container ref for the virtualizer.
  // Uses a plain div with overflow:auto instead of Radix ScrollArea,
  // because the virtualizer needs the scroll element to have a measurable
  // client height from CSS layout (not from content).
  const scrollRef = useRef<HTMLDivElement>(null);

  // Virtual list — only mount items in/near the viewport.
  // +1 for the EndDropZone at the bottom.
  const virtualizer = useVirtualizer({
    count: flattenedItems.length + 1,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 32,
    overscan: 10,
  });

  // Scroll selected item into view via virtualizer
  useEffect(() => {
    if (selectedId) {
      const index = flattenedItems.findIndex((item) => item.id === selectedId);
      if (index >= 0) {
        virtualizer.scrollToIndex(index, { align: "auto", behavior: "smooth" });
      }
    }
  }, [selectedId, flattenedItems, virtualizer]);

  if (flattenedItems.length === 0) {
    return (
      <Flex direction="column" height="100%">
        <Flex style={{ flex: 1 }} align="center" justify="center">
          <Text color="gray">No panels yet</Text>
        </Flex>
        <Box p="2" style={{ borderTop: "1px solid var(--gray-6)" }}>
          <IconButton
            variant="ghost"
            size="1"
            onClick={handleNewPanel}
            aria-label="New panel"
            style={{ width: "100%" }}
          >
            <PlusIcon />
            <Text size="1" ml="1">New Panel</Text>
          </IconButton>
        </Box>
      </Flex>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <Flex direction="column" style={{ flex: 1, minHeight: 0 }}>
      <div
        ref={scrollRef}
        style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
      >
        <Box
          p="1"
          style={{
            position: "relative",
            height: virtualizer.getTotalSize(),
          }}
        >
          {virtualItems.map((virtualRow) => {
            // Last virtual item is the EndDropZone
            if (virtualRow.index === flattenedItems.length) {
              return (
                <Box
                  key="__end_drop_zone__"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <EndDropZone
                    isOver={overId === END_DROP_ZONE_ID && activeId !== null}
                    projectedDepth={overId === END_DROP_ZONE_ID ? projectedDepth : null}
                    isDragging={activeId !== null}
                  />
                </Box>
              );
            }

            const item = flattenedItems[virtualRow.index]!;
            return (
              <Box
                key={item.id}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <SortableTreeItem
                  item={item}
                  isSelected={item.id === selectedId}
                  showIndicator={item.id === indicatorItemId}
                  projectedDepth={item.id === indicatorItemId ? projectedDepth : null}
                  isDraggingAny={activeId !== null}
                  showIndicatorBelow={showIndicatorBelow}
                  onSelect={onSelect}
                  onToggleCollapse={toggleCollapse}
                  onPanelAction={onPanelAction}
                  onArchive={onArchive}
                  onIndent={indentPanel}
                  onUnindent={unindentPanel}
                />
              </Box>
            );
          })}
        </Box>
      </div>
      <Box p="2" style={{ borderTop: "1px solid var(--gray-6)" }}>
        <IconButton
          variant="ghost"
          size="1"
          onClick={handleNewPanel}
          aria-label="New panel"
          style={{ width: "100%" }}
        >
          <PlusIcon />
          <Text size="1" ml="1">New Panel</Text>
        </IconButton>
      </Box>
    </Flex>
  );
}
