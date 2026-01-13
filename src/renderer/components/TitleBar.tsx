import {
  DotsHorizontalIcon,
  HamburgerMenuIcon,
  BoxIcon,
  ViewVerticalIcon,
  ChevronRightIcon,
  DividerVerticalIcon,
} from "@radix-ui/react-icons";
import { Box, Flex, IconButton, Text, Tooltip } from "@radix-ui/themes";
import type { CSSProperties, MouseEvent } from "react";

import { useNavigation } from "./NavigationContext";
import type {
  NavigationMode,
  LazyTitleNavigationData,
  LazyStatusNavigationData,
  PanelSummary,
  PanelAncestor,
  DescendantSiblingGroup,
} from "./navigationTypes";
import type { PanelContextMenuAction } from "../../shared/ipc/types";
import { menu } from "../shell/client";

interface TitleBarProps {
  title: string;
  onNavigateToId?: (panelId: string) => void;
  onPanelAction?: (panelId: string, action: PanelContextMenuAction) => void;
}

export function TitleBar({ title, onNavigateToId, onPanelAction }: TitleBarProps) {
  const {
    mode: navigationMode,
    setMode,
    lazyTitleNavigation: navigationData,
    lazyStatusNavigation: statusNavigation,
  } = useNavigation();

  const handleNavigationToggle = () => {
    const nextMode: NavigationMode = navigationMode === "stack" ? "tree" : "stack";
    setMode(nextMode);
  };

  const handleHamburgerClick = (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    void menu.showHamburger(getWindowPositionFromRect(rect));
  };

  return (
    <Box
      style={
        {
          appRegion: "drag",
          WebkitAppRegion: "drag",
          userSelect: "none",
          height: "32px",
          backgroundColor: "var(--gray-2)",
          borderBottom: "1px solid var(--gray-6)",
        } as CSSProperties
      }
    >
      <Flex align="center" justify="between" height="100%" px="2" gap="2">
        {/* Left side: Hamburger menu */}
        <Flex
          align="center"
          gap="2"
          style={{ appRegion: "no-drag", WebkitAppRegion: "no-drag" } as CSSProperties}
        >
          <IconButton variant="ghost" size="1" onClick={handleHamburgerClick}>
            <HamburgerMenuIcon />
          </IconButton>

          <Tooltip content={navigationMode === "tree" ? "Breadcrumb mode" : "Tree mode"}>
            <IconButton
              variant="ghost"
              size="1"
              onClick={handleNavigationToggle}
              aria-label={
                navigationMode === "tree"
                  ? "Switch to breadcrumb navigation"
                  : "Switch to tree view"
              }
            >
              {navigationMode === "tree" ? <BoxIcon /> : <ViewVerticalIcon />}
            </IconButton>
          </Tooltip>
        </Flex>

        {/* Center: Navigation + title */}
        <Box
          style={
            {
              flex: 1,
              minWidth: 0,
              appRegion: "no-drag",
              WebkitAppRegion: "no-drag",
              overflow: "hidden",
            } as CSSProperties
          }
        >
          <BreadcrumbBar
            title={title}
            navigationData={navigationData}
            statusNavigation={statusNavigation}
            onNavigateToId={onNavigateToId}
            onPanelAction={onPanelAction}
          />
        </Box>

        {/* Right side: spacer for native window controls (titleBarOverlay) */}
        <Box style={{ width: "138px" }} />
      </Flex>
    </Box>
  );
}

interface BreadcrumbBarProps {
  title: string;
  navigationData?: LazyTitleNavigationData | null;
  statusNavigation?: LazyStatusNavigationData | null;
  onNavigateToId?: (panelId: string) => void;
  onPanelAction?: (panelId: string, action: PanelContextMenuAction) => void;
}

const MAX_VISIBLE_ANCESTORS = 2;
const MAX_VISIBLE_DESC_GROUPS = 2;

/**
 * Get window-relative position from element bounding rect for native menu positioning.
 * Returns coordinates relative to the window's content area.
 * The main process will handle conversion to screen coordinates.
 */
function getWindowPositionFromRect(rect: DOMRect): { x: number; y: number } {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.bottom),
  };
}

// Shared styles for breadcrumb items
const itemStyle: CSSProperties = {
  padding: "2px 6px",
  borderRadius: "3px",
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "background-color 100ms",
};

// Style for sibling group container
const groupStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "1px",
  padding: "1px",
  borderRadius: "4px",
  border: "1px solid var(--gray-6)",
};

function BreadcrumbBar({
  title,
  navigationData,
  statusNavigation,
  onNavigateToId,
  onPanelAction,
}: BreadcrumbBarProps) {
  const ancestors = navigationData?.ancestors ?? [];
  const currentSiblings = navigationData?.currentSiblings ?? [];
  const descendantGroups = statusNavigation?.descendantGroups ?? [];

  const visibleAncestors = ancestors.slice(-MAX_VISIBLE_ANCESTORS);
  const hiddenAncestors = ancestors.slice(0, ancestors.length - visibleAncestors.length);

  const visibleDescendantGroups = descendantGroups.slice(0, MAX_VISIBLE_DESC_GROUPS);
  const hiddenDescendantGroups = descendantGroups.slice(visibleDescendantGroups.length);

  const handlePanelContextMenu = async (
    e: MouseEvent<HTMLSpanElement>,
    panel: PanelSummary | PanelAncestor
  ) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const action = await menu.showPanelContext(panel.id, panel.type, getWindowPositionFromRect(rect));
    if (action) {
      onPanelAction?.(panel.id, action);
    }
  };

  const renderBreadcrumbItem = (
    panel: PanelSummary,
    isActive: boolean,
    isCurrent: boolean
  ) => (
    <Text
      key={panel.id}
      as="span"
      size="2"
      color={isActive ? undefined : "gray"}
      style={{
        ...itemStyle,
        backgroundColor: isCurrent && isActive ? "var(--gray-a4)" : undefined,
      }}
      onClick={() => onNavigateToId?.(panel.id)}
      onContextMenu={(e: MouseEvent<HTMLSpanElement>) => handlePanelContextMenu(e, panel)}
      onMouseEnter={(e: MouseEvent<HTMLSpanElement>) => {
        if (!isCurrent || !isActive) {
          e.currentTarget.style.backgroundColor = "var(--gray-a3)";
        }
      }}
      onMouseLeave={(e: MouseEvent<HTMLSpanElement>) => {
        e.currentTarget.style.backgroundColor = isCurrent && isActive ? "var(--gray-a4)" : "";
      }}
    >
      {panel.title}
    </Text>
  );

  const renderAncestorItem = (ancestor: PanelAncestor) => (
    <Text
      key={ancestor.id}
      as="span"
      size="2"
      style={itemStyle}
      onClick={() => onNavigateToId?.(ancestor.id)}
      onContextMenu={(e: MouseEvent<HTMLSpanElement>) => handlePanelContextMenu(e, ancestor)}
      onMouseEnter={(e: MouseEvent<HTMLSpanElement>) => {
        e.currentTarget.style.backgroundColor = "var(--gray-a3)";
      }}
      onMouseLeave={(e: MouseEvent<HTMLSpanElement>) => {
        e.currentTarget.style.backgroundColor = "";
      }}
    >
      {ancestor.title}
    </Text>
  );

  const renderSiblingGroup = (
    siblings: PanelSummary[],
    activeId: string | null,
    isCurrent: boolean
  ) => {
    if (siblings.length === 0) return null;
    const effectiveActiveId = activeId || siblings[0]?.id || "";

    return (
      <span style={groupStyle}>
        {siblings.map((sibling, index) => (
          <span key={sibling.id} style={{ display: "inline-flex", alignItems: "center" }}>
            {index > 0 && (
              <DividerVerticalIcon
                style={{ color: "var(--gray-7)", width: 12, height: 12, flexShrink: 0 }}
              />
            )}
            {renderBreadcrumbItem(
              sibling,
              sibling.id === effectiveActiveId,
              isCurrent
            )}
          </span>
        ))}
      </span>
    );
  };

  const handleHiddenAncestorsClick = async (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const items = hiddenAncestors.map((ancestor) => ({
      id: ancestor.id,
      label: ancestor.title,
    }));
    const selected = await menu.showContext(items, getWindowPositionFromRect(rect));
    if (selected !== null) {
      onNavigateToId?.(selected);
    }
  };

  const handleHiddenDescendantsClick = async (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // For hidden descendant groups, show the selected panel from each group
    const items = hiddenDescendantGroups.map((group) => {
      const selectedPanel = group.siblings.find((s) => s.id === group.selectedId);
      return {
        id: group.selectedId,
        label: selectedPanel?.title ?? "Unknown",
      };
    });
    const selected = await menu.showContext(items, getWindowPositionFromRect(rect));
    if (selected !== null) {
      onNavigateToId?.(selected);
    }
  };

  const renderDescendantSiblingGroup = (group: DescendantSiblingGroup) => {
    if (group.siblings.length === 0) return null;

    return (
      <span style={groupStyle}>
        {group.siblings.map((sibling, index) => (
          <span key={sibling.id} style={{ display: "inline-flex", alignItems: "center" }}>
            {index > 0 && (
              <DividerVerticalIcon
                style={{ color: "var(--gray-7)", width: 12, height: 12, flexShrink: 0 }}
              />
            )}
            {renderBreadcrumbItem(
              sibling,
              sibling.id === group.selectedId,
              false
            )}
          </span>
        ))}
      </span>
    );
  };

  return (
    <Flex align="center" gap="1" style={{ minWidth: 0, overflow: "hidden" }}>
      {/* Ancestors */}
      {hiddenAncestors.length > 0 && (
        <>
          <IconButton
            size="1"
            variant="ghost"
            aria-label="More ancestors"
            onClick={handleHiddenAncestorsClick}
          >
            <DotsHorizontalIcon />
          </IconButton>
          <ChevronRightIcon color="var(--gray-8)" />
        </>
      )}
      {visibleAncestors.map((ancestor) => (
        <Flex key={ancestor.id} align="center" gap="1">
          <span style={groupStyle}>
            {renderAncestorItem(ancestor)}
          </span>
          <ChevronRightIcon color="var(--gray-8)" />
        </Flex>
      ))}

      {/* Current (with siblings) */}
      {currentSiblings.length > 0 ? (
        renderSiblingGroup(
          currentSiblings,
          navigationData?.currentId ?? null,
          true
        )
      ) : (
        <span style={groupStyle}>
          <Text
            size="2"
            style={{ ...itemStyle, backgroundColor: "var(--gray-a4)" }}
          >
            {navigationData?.currentTitle ?? title}
          </Text>
        </span>
      )}

      {/* Descendants (sibling groups) */}
      {visibleDescendantGroups.map((group) => (
        <Flex key={`desc-${group.depth}`} align="center" gap="1">
          <ChevronRightIcon color="var(--gray-8)" />
          {renderDescendantSiblingGroup(group)}
        </Flex>
      ))}
      {hiddenDescendantGroups.length > 0 && (
        <>
          <ChevronRightIcon color="var(--gray-8)" />
          <IconButton
            size="1"
            variant="ghost"
            aria-label="More descendants"
            onClick={handleHiddenDescendantsClick}
          >
            <DotsHorizontalIcon />
          </IconButton>
        </>
      )}
    </Flex>
  );
}
