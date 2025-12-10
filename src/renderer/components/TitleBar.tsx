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
import type { NavigationMode, StatusNavigationData, TitleNavigationData } from "./navigationTypes";
import type { PanelContextMenuAction } from "../../shared/ipc/types";

interface TitleBarProps {
  title: string;
  onNavigate?: (path: string[]) => void;
  onPanelAction?: (panelId: string, action: PanelContextMenuAction) => void;
}

export function TitleBar({ title, onNavigate, onPanelAction }: TitleBarProps) {
  const {
    mode: navigationMode,
    setMode,
    titleNavigation: navigationData,
    statusNavigation,
  } = useNavigation();

  const handleNavigationToggle = () => {
    const nextMode: NavigationMode = navigationMode === "stack" ? "tree" : "stack";
    setMode(nextMode);
  };

  const handleHamburgerClick = (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    void window.electronAPI.showHamburgerMenu(getScreenPositionFromRect(rect));
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
            onNavigate={onNavigate}
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
  navigationData?: TitleNavigationData | null;
  statusNavigation?: StatusNavigationData | null;
  onNavigate?: (path: string[]) => void;
  onPanelAction?: (panelId: string, action: PanelContextMenuAction) => void;
}

const MAX_VISIBLE_ANCESTORS = 2;
const MAX_VISIBLE_DESC_GROUPS = 2;

/**
 * Convert element bounding rect to screen coordinates for native menu positioning.
 * Uses window.screenX/Y for proper multi-monitor support.
 * Note: For context menus (right-click), use event.screenX/screenY directly instead.
 */
function getScreenPositionFromRect(rect: DOMRect): { x: number; y: number } {
  return {
    x: Math.round(window.screenX + rect.left + window.scrollX),
    y: Math.round(window.screenY + rect.bottom + window.scrollY),
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
  onNavigate,
  onPanelAction,
}: BreadcrumbBarProps) {
  const ancestors = navigationData?.ancestors ?? [];
  const descendantGroups = statusNavigation?.descendantGroups ?? [];

  const visibleAncestors = ancestors.slice(-MAX_VISIBLE_ANCESTORS);
  const hiddenAncestors = ancestors.slice(0, ancestors.length - visibleAncestors.length);

  const visibleDescendants = descendantGroups.slice(0, MAX_VISIBLE_DESC_GROUPS);
  const hiddenDescendants = descendantGroups.slice(visibleDescendants.length);

  const handlePanelContextMenu = async (
    e: MouseEvent<HTMLSpanElement>,
    panel: Panel
  ) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const action = await window.electronAPI.showPanelContextMenu(panel.id, panel.type, getScreenPositionFromRect(rect));
    if (action) {
      onPanelAction?.(panel.id, action);
    }
  };

  const renderBreadcrumbItem = (
    panel: Panel,
    pathToParent: string[],
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
      onClick={() => onNavigate?.([...pathToParent, panel.id])}
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

  const renderSiblingGroup = (
    siblings: Panel[],
    pathToParent: string[],
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
              pathToParent,
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
    const items = hiddenAncestors.map((crumb, index) => ({
      id: String(index),
      label:
        crumb.siblings.find((sibling) => sibling.id === crumb.path[crumb.path.length - 1])
          ?.title ??
        crumb.siblings[0]?.title ??
        crumb.path.join(" / "),
    }));
    const selected = await window.electronAPI.showContextMenu(items, getScreenPositionFromRect(rect));
    if (selected !== null) {
      const crumb = hiddenAncestors.find((_, index) => String(index) === selected);
      if (crumb) {
        onNavigate?.(crumb.path);
      }
    }
  };

  const handleHiddenDescendantsClick = async (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const items = hiddenDescendants.map((group, index) => ({
      id: String(index),
      label:
        group.children.find((c) => c.id === group.selectedChildId)?.title ??
        group.children[0]?.title ??
        "Child",
    }));
    const selected = await window.electronAPI.showContextMenu(items, getScreenPositionFromRect(rect));
    if (selected !== null) {
      const group = hiddenDescendants.find((_, index) => String(index) === selected);
      if (group) {
        const targetId = group.selectedChildId || group.children[0]?.id || "";
        onNavigate?.([...group.pathToParent, targetId]);
      }
    }
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
      {visibleAncestors.map((crumb) => (
        <Flex key={crumb.path.join("-")} align="center" gap="1">
          {renderSiblingGroup(
            crumb.siblings,
            crumb.path.slice(0, -1),
            crumb.path[crumb.path.length - 1] || null,
            false
          )}
          <ChevronRightIcon color="var(--gray-8)" />
        </Flex>
      ))}

      {/* Current (with siblings) */}
      {navigationData?.current ? (
        renderSiblingGroup(
          navigationData.current.siblings,
          navigationData.current.parentPath,
          navigationData.current.activeId,
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

      {/* Descendants */}
      {visibleDescendants.map((group) => (
        <Flex key={group.parentId} align="center" gap="1">
          <ChevronRightIcon color="var(--gray-8)" />
          {renderSiblingGroup(group.children, group.pathToParent, group.selectedChildId, false)}
        </Flex>
      ))}
      {hiddenDescendants.length > 0 && (
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
