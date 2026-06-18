/**
 * LazyPanelTreeSidebar - Sortable panel tree sidebar with drag-and-drop.
 *
 * Visual design:
 * - Clean rows: a caret gutter, the title, and (on demand) a count / status / actions.
 * - Hierarchy is shown by indentation alone — no leading icons, no guide lines.
 * - Selection is a restrained accent wash; the selected *title* is the signal.
 *
 * Behavior:
 * - Horizontal drag offset determines nesting depth (drag right = nest deeper)
 * - Flattened tree rendered as a virtualized sortable list
 * - Projected depth indicator shows where a dragged item will land
 * - Context menu for panel actions
 */

import { useState, useCallback, useEffect, useMemo, useRef, memo, type CSSProperties } from "react";
import { useTouchDevice } from "@workspace/react/responsive";
import { useAtomValue, useSetAtom } from "jotai";
import {
  CaretRightIcon,
  CaretSortIcon,
  Cross2Icon,
  CubeIcon,
  LayersIcon,
  PlusIcon,
} from "@radix-ui/react-icons";
import { Badge, Box, Button, Flex, IconButton, Text } from "@radix-ui/themes";
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
import type { PanelContextMenuAction } from "@natstack/shared/types";
import { menu, panel } from "../shell/client.js";
import { activeWorkspaceNameAtom, workspaceChooserDialogOpenAtom } from "../state/appModeAtoms.js";
import { assertPresent } from "../utils/assertPresent";

// ============================================================================
// Style Constants
// ============================================================================

const ROW_HEIGHT = 30;
/** Left padding before the caret gutter of a depth-0 row. */
const ROW_PADDING_LEFT = 8;
/** Fixed-width gutter that holds the expand caret so titles align by depth. */
const CARET_SLOT = 16;
const ACTION_BUTTON_SIZE = 18;

/** Delay before auto-expanding a collapsed item while dragging over it (ms) */
const AUTO_EXPAND_DELAY_MS = 600;

// Connector geometry: stems sit in the indent gutter and a rounded elbow turns
// into each child row. Encoded per-row as a `guides` string (see buildGuides).
/** Horizontal offset of a stem within its indent step. */
const GUIDE_OFFSET = 6;
/** Width of the elbow's horizontal run — ends exactly at the row's content. */
const ELBOW_WIDTH = INDENTATION_WIDTH - GUIDE_OFFSET;
const ELBOW_RADIUS = 6;
const GUIDE_COLOR = "var(--gray-a5)";
const GUIDE_COLOR_ACTIVE = "var(--accent-8)";

const COLORS = {
  selected: "var(--accent-a3)",
  selectedHover: "var(--accent-a4)",
  hover: "var(--gray-a3)",
  dropIndicator: "var(--accent-9)",
} as const;

function getWindowPositionFromMouseEvent(e: React.MouseEvent): { x: number; y: number } {
  if (Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
    return {
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
    };
  }

  const rect = e.currentTarget.getBoundingClientRect();
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.bottom),
  };
}

// ============================================================================
// Style Helpers
// ============================================================================

function getDropIndicatorStyle(depth: number, top: number | string): CSSProperties {
  return {
    position: "absolute",
    left: ROW_PADDING_LEFT + depth * INDENTATION_WIDTH,
    right: 8,
    height: 2,
    backgroundColor: COLORS.dropIndicator,
    borderRadius: 1,
    top,
    zIndex: 2,
  };
}

function getRowBackground(isSelected: boolean, isHovered: boolean): string | undefined {
  if (isSelected) return isHovered ? COLORS.selectedHover : COLORS.selected;
  if (isHovered) return COLORS.hover;
  return undefined;
}

/**
 * Compute a per-row connector descriptor from the flattened list.
 *
 * Each row's string has one char per ancestor depth:
 *  - ' ' blank   — ancestor at this level was a last child; no stem here
 *  - 'v' vertical — ancestor's branch continues below; draw a pass-through stem
 *  - 'L' / 'T'    — the elbow into this row: 'L' = last child (rounded corner,
 *                   terminate), 'T' = has a following sibling (corner + continue)
 */
function buildGuides(items: FlattenedPanel[]): Map<string, string> {
  const n = items.length;
  const indexById = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    indexById.set(assertPresent(items[i]).id, i);
  }

  // A node is the last child of its parent if, scanning forward, we pop above
  // its depth before meeting another node at the same depth.
  const isLast = new Array<boolean>(n).fill(true);
  for (let i = 0; i < n; i++) {
    const d = assertPresent(items[i]).depth;
    for (let j = i + 1; j < n; j++) {
      const dj = assertPresent(items[j]).depth;
      if (dj < d) break;
      if (dj === d) {
        isLast[i] = false;
        break;
      }
    }
  }

  const guides = new Map<string, string>();
  for (let i = 0; i < n; i++) {
    const item = assertPresent(items[i]);
    const { depth } = item;
    if (depth === 0) {
      guides.set(item.id, "");
      continue;
    }

    // Walk up the parent chain collecting each level's last-child flag.
    const colLast = new Array<boolean>(depth).fill(true);
    let curId: string | null = item.id;
    for (let col = depth - 1; col >= 0 && curId != null; col--) {
      const idx = indexById.get(curId);
      if (idx === undefined) break;
      colLast[col] = isLast[idx] ?? true;
      curId = assertPresent(items[idx]).parentId;
    }

    let s = "";
    for (let col = 0; col < depth; col++) {
      if (col < depth - 1) {
        s += colLast[col] ? " " : "v";
      } else {
        s += colLast[col] ? "L" : "T";
      }
    }
    guides.set(item.id, s);
  }
  return guides;
}

/**
 * Rounded elbow / stem connectors drawn in the indent gutter (left of content),
 * so they never overlap the title. Rendered as an overlay above the row's
 * background but outside the text region.
 */
function TreeConnectors({ guides, isSelected }: { guides: string; isSelected: boolean }) {
  const depth = guides.length;
  if (depth === 0) return null;

  const mid = ROW_HEIGHT / 2;
  const elems: React.ReactNode[] = [];

  for (let col = 0; col < depth; col++) {
    const ch = guides[col];
    const x = ROW_PADDING_LEFT + col * INDENTATION_WIDTH + GUIDE_OFFSET;

    if (col < depth - 1) {
      if (ch === "v") {
        elems.push(
          <Box
            key={`v${col}`}
            style={{
              position: "absolute",
              left: x,
              top: 0,
              bottom: 0,
              width: 1,
              backgroundColor: GUIDE_COLOR,
            }}
          />
        );
      }
      continue;
    }

    // Elbow column (this row's connector into its parent stem).
    const color = isSelected ? GUIDE_COLOR_ACTIVE : GUIDE_COLOR;
    elems.push(
      <Box
        key={`e${col}`}
        style={{
          position: "absolute",
          left: x,
          top: 0,
          height: mid,
          width: ELBOW_WIDTH,
          borderLeft: `1px solid ${color}`,
          borderBottom: `1px solid ${color}`,
          borderBottomLeftRadius: ELBOW_RADIUS,
        }}
      />
    );
    // 'T' = has a following sibling: continue the stem below the corner.
    if (ch === "T") {
      elems.push(
        <Box
          key={`t${col}`}
          style={{
            position: "absolute",
            left: x,
            top: mid,
            bottom: 0,
            width: 1,
            backgroundColor: color,
          }}
        />
      );
    }
  }

  return (
    <Box aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {elems}
    </Box>
  );
}

// ============================================================================
// Build status indicator
// ============================================================================

/** Spinner while building/cloning, colored dot for error/pending, nothing otherwise. */
function BuildIndicator({ buildState }: { buildState?: string }) {
  if (buildState === "building" || buildState === "cloning") {
    return (
      <Box
        className="app-tree-spinner"
        aria-label="Building"
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          border: "1.5px solid var(--amber-a5)",
          borderTopColor: "var(--amber-9)",
          flexShrink: 0,
        }}
      />
    );
  }
  const dotColor =
    buildState === "error"
      ? "var(--red-9)"
      : buildState === "pending"
        ? "var(--gray-8)"
        : undefined;
  if (!dotColor) return null;
  return (
    <Box
      aria-label={buildState === "error" ? "Build error" : "Pending build"}
      style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        backgroundColor: dotColor,
        flexShrink: 0,
      }}
    />
  );
}

// ============================================================================
// Sortable Tree Item Component
// ============================================================================

interface SortableTreeItemProps {
  item: FlattenedPanel;
  guides: string;
  isSelected: boolean;
  showIndicator: boolean;
  projectedDepth: number | null;
  isDraggingAny: boolean;
  showIndicatorBelow: boolean;
  isTouch: boolean;
  onSelect: (panelId: string) => void;
  onToggleCollapse: (panelId: string) => void;
  onPanelAction?: (panelId: string, action: PanelContextMenuAction) => void;
  onArchive?: (panelId: string) => void;
  onAddChild?: (panelId: string) => void;
  onIndent: (panelId: string) => void;
  onUnindent: (panelId: string) => void;
}

const SortableTreeItem = memo(
  function SortableTreeItem({
    item,
    guides,
    isSelected,
    showIndicator,
    projectedDepth,
    isDraggingAny,
    showIndicatorBelow,
    isTouch,
    onSelect,
    onToggleCollapse,
    onPanelAction,
    onArchive,
    onAddChild,
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

    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
      id: panel.id,
    });

    const style: CSSProperties = {
      transform: CSS.Translate.toString(transform),
      transition,
      opacity: isDragging ? 0.2 : 1,
    };

    const hasChildren = panel.childCount > 0;
    const showActions = (isHovered || isTouch) && !isDraggingAny;
    // The count is only meaningful when children are hidden behind a collapsed node.
    const showCount = hasChildren && collapsed && !showActions;

    const handleContextMenu = useCallback(
      async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const action = await menu.showPanelContext(panel.id, getWindowPositionFromMouseEvent(e));
        if (action) {
          onPanelAction?.(panel.id, action);
        }
      },
      [panel.id, onPanelAction]
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

    const handleAddChild = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        onAddChild?.(panel.id);
      },
      [panel.id, onAddChild]
    );

    const rowStyle: CSSProperties = {
      height: ROW_HEIGHT,
      cursor: "pointer",
      backgroundColor: getRowBackground(isSelected, isHovered),
      borderRadius: "var(--radius-3)",
      paddingLeft: ROW_PADDING_LEFT + depth * INDENTATION_WIDTH,
      transition: "background-color 120ms ease-out",
    };

    // Show drop indicator when this item is designated to show it
    const showDropIndicator = showIndicator && projectedDepth !== null;

    return (
      <Box ref={setNodeRef} style={{ position: "relative", ...style }}>
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
          pr="2"
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
          {/* Caret gutter — fixed width so titles align by depth */}
          <Flex
            align="center"
            justify="center"
            style={{ width: CARET_SLOT, height: CARET_SLOT, flexShrink: 0 }}
          >
            {hasChildren && (
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                aria-label={collapsed ? "Expand" : "Collapse"}
                onClick={handleToggleExpand}
                style={{
                  width: CARET_SLOT,
                  height: CARET_SLOT,
                  margin: 0,
                  color: isSelected ? "var(--accent-11)" : "var(--gray-9)",
                  transition: "transform 150ms ease",
                  transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
                }}
              >
                <CaretRightIcon />
              </IconButton>
            )}
          </Flex>

          {/* Title — the focal element; brightened + weighted when selected */}
          <Text
            size="2"
            weight={isSelected ? "medium" : "regular"}
            style={{
              flex: 1,
              minWidth: 0,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              color: isSelected ? "var(--accent-12)" : "var(--gray-11)",
            }}
          >
            {panel.title}
          </Text>

          {/* Build state indicator */}
          <BuildIndicator buildState={panel.buildState} />

          {/* Hidden-children count (collapsed nodes only) */}
          {showCount && (
            <Badge
              size="1"
              variant="soft"
              color={isSelected ? undefined : "gray"}
              radius="full"
              style={{ fontSize: "10px", flexShrink: 0 }}
            >
              {panel.childCount}
            </Badge>
          )}

          {/* Row actions — on hover (or always on touch), hidden while dragging */}
          {showActions && (
            <>
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                aria-label="Add child panel"
                onClick={handleAddChild}
                className="app-tree-action"
                style={{
                  width: ACTION_BUTTON_SIZE,
                  height: ACTION_BUTTON_SIZE,
                  flexShrink: 0,
                  margin: 0,
                }}
              >
                <PlusIcon width={12} height={12} />
              </IconButton>
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                aria-label="Archive panel"
                onClick={handleArchive}
                className="app-tree-action app-tree-action-danger"
                style={{
                  width: ACTION_BUTTON_SIZE,
                  height: ACTION_BUTTON_SIZE,
                  flexShrink: 0,
                  margin: 0,
                }}
              >
                <Cross2Icon width={12} height={12} />
              </IconButton>
            </>
          )}
        </Flex>

        <TreeConnectors guides={guides} isSelected={isSelected} />
      </Box>
    );
  },
  (prev, next) => {
    // Custom comparator: compare specific fields that affect rendering,
    // since flattenTree() creates fresh FlattenedPanel objects every call.
    return (
      prev.item.id === next.item.id &&
      prev.guides === next.guides &&
      prev.item.depth === next.item.depth &&
      prev.item.collapsed === next.item.collapsed &&
      prev.item.parentId === next.item.parentId &&
      prev.item.panel.title === next.item.panel.title &&
      prev.item.panel.childCount === next.item.panel.childCount &&
      prev.item.panel.buildState === next.item.panel.buildState &&
      prev.isSelected === next.isSelected &&
      prev.showIndicator === next.showIndicator &&
      prev.projectedDepth === next.projectedDepth &&
      prev.isDraggingAny === next.isDraggingAny &&
      prev.showIndicatorBelow === next.showIndicatorBelow &&
      prev.isTouch === next.isTouch &&
      prev.onSelect === next.onSelect &&
      prev.onToggleCollapse === next.onToggleCollapse &&
      prev.onPanelAction === next.onPanelAction &&
      prev.onArchive === next.onArchive &&
      prev.onAddChild === next.onAddChild &&
      prev.onIndent === next.onIndent &&
      prev.onUnindent === next.onUnindent
    );
  }
);

// ============================================================================
// End Drop Zone Component
// ============================================================================

interface EndDropZoneProps {
  isOver: boolean;
  projectedDepth: number | null;
  isDragging: boolean;
}

function EndDropZone({ isOver, projectedDepth, isDragging }: EndDropZoneProps) {
  const { attributes, listeners, setNodeRef } = useSortable({ id: END_DROP_ZONE_ID });

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
// Sidebar Footer (new panel CTA + workspace switcher)
// ============================================================================

interface SidebarFooterProps {
  activeWorkspaceName: string | null;
  onSwitchWorkspace: () => void;
  onNewPanel: () => void;
}

function SidebarFooter({ activeWorkspaceName, onSwitchWorkspace, onNewPanel }: SidebarFooterProps) {
  const handleWorkspaceKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSwitchWorkspace();
      }
    },
    [onSwitchWorkspace]
  );

  return (
    <Box p="2">
      <Button
        variant="soft"
        size="2"
        onClick={onNewPanel}
        aria-label="New panel"
        style={{ width: "100%" }}
      >
        <PlusIcon />
        New panel
      </Button>

      {/* Workspace selector — the whole row is the switch affordance */}
      {activeWorkspaceName && (
        <Flex
          className="app-tree-workspace"
          role="button"
          tabIndex={0}
          align="center"
          gap="2"
          mt="2"
          px="2"
          py="1"
          onClick={onSwitchWorkspace}
          onKeyDown={handleWorkspaceKeyDown}
          aria-label={`Workspace: ${activeWorkspaceName}. Activate to switch workspace.`}
          title="Switch workspace"
          style={{ borderRadius: "var(--radius-2)", cursor: "pointer" }}
        >
          <CubeIcon style={{ flexShrink: 0, color: "var(--gray-9)" }} />
          <Text size="2" truncate style={{ flex: 1, minWidth: 0, color: "var(--gray-12)" }}>
            {activeWorkspaceName}
          </Text>
          <CaretSortIcon style={{ flexShrink: 0, color: "var(--gray-9)" }} />
        </Flex>
      )}
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
  const activeWorkspaceName = useAtomValue(activeWorkspaceNameAtom);
  const setWorkspaceChooserOpen = useSetAtom(workspaceChooserDialogOpenAtom);
  const isTouch = useTouchDevice();

  const { flattenedItems, collapsedIds, toggleCollapse, expandIds, indentPanel, unindentPanel } =
    usePanelDndTree();

  const { activeId, overId, projectedDepth, indicatorItemId, showIndicatorBelow } =
    usePanelDndDrag();

  // Per-row connector descriptors (rounded elbows + sibling stems).
  const guidesById = useMemo(() => buildGuides(flattenedItems), [flattenedItems]);

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
    const result = await panel.createAboutPanel("new");
    window.dispatchEvent(
      new CustomEvent("shell-panel-created", {
        detail: { panelId: result.id },
      })
    );
  }, []);

  const handleSwitchWorkspace = useCallback(() => {
    setWorkspaceChooserOpen(true);
  }, [setWorkspaceChooserOpen]);

  const handleAddChild = useCallback(
    async (parentId: string) => {
      if (collapsedIds.has(parentId)) {
        expandIds([parentId]);
      }
      const result = await panel.createChild(parentId, "about/new", { focus: true });
      window.dispatchEvent(
        new CustomEvent("shell-panel-created", {
          detail: { panelId: result.id },
        })
      );
    },
    [collapsedIds, expandIds]
  );

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
    estimateSize: () => ROW_HEIGHT,
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
      <Flex direction="column" style={{ flex: 1, minHeight: 0 }}>
        <Flex
          direction="column"
          align="center"
          justify="center"
          gap="2"
          px="4"
          style={{ flex: 1, textAlign: "center" }}
        >
          <Flex
            align="center"
            justify="center"
            style={{
              width: 44,
              height: 44,
              borderRadius: "var(--radius-4)",
              backgroundColor: "var(--gray-a3)",
              color: "var(--gray-9)",
            }}
          >
            <LayersIcon width={22} height={22} />
          </Flex>
          <Text size="2" weight="medium" style={{ color: "var(--gray-12)" }}>
            No panels yet
          </Text>
          <Text size="1" color="gray">
            Create your first panel to get started.
          </Text>
          <Button variant="soft" size="2" mt="1" onClick={handleNewPanel} aria-label="New panel">
            <PlusIcon />
            New panel
          </Button>
        </Flex>
        <SidebarFooter
          activeWorkspaceName={activeWorkspaceName}
          onSwitchWorkspace={handleSwitchWorkspace}
          onNewPanel={handleNewPanel}
        />
      </Flex>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <Flex direction="column" style={{ flex: 1, minHeight: 0 }}>
      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
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

            const item = assertPresent(flattenedItems[virtualRow.index]);
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
                  guides={guidesById.get(item.id) ?? ""}
                  isSelected={item.id === selectedId}
                  showIndicator={item.id === indicatorItemId}
                  projectedDepth={item.id === indicatorItemId ? projectedDepth : null}
                  isDraggingAny={activeId !== null}
                  showIndicatorBelow={showIndicatorBelow}
                  isTouch={isTouch}
                  onSelect={onSelect}
                  onToggleCollapse={toggleCollapse}
                  onPanelAction={onPanelAction}
                  onArchive={onArchive}
                  onAddChild={handleAddChild}
                  onIndent={indentPanel}
                  onUnindent={unindentPanel}
                />
              </Box>
            );
          })}
        </Box>
      </div>
      <SidebarFooter
        activeWorkspaceName={activeWorkspaceName}
        onSwitchWorkspace={handleSwitchWorkspace}
        onNewPanel={handleNewPanel}
      />
    </Flex>
  );
}
