import {
  DotsHorizontalIcon,
  HamburgerMenuIcon,
  BoxIcon,
  ViewVerticalIcon,
  ChevronRightIcon,
} from "@radix-ui/react-icons";
import { Box, Button, Card, DropdownMenu, Flex, IconButton, Text, Tooltip } from "@radix-ui/themes";
import type { CSSProperties } from "react";

import { useNavigation } from "./NavigationContext";
import type { NavigationMode, StatusNavigationData, TitleNavigationData } from "./navigationTypes";

interface TitleBarProps {
  title: string;
  onNavigate?: (path: string[]) => void;
  onOpenPanelDevTools?: () => void;
  onOpenAppDevTools?: () => void;
  onOpenSettings?: () => void;
  onOpenWorkspaceChooser?: () => void;
}

export function TitleBar({
  title,
  onNavigate,
  onOpenPanelDevTools,
  onOpenAppDevTools,
  onOpenSettings,
  onOpenWorkspaceChooser,
}: TitleBarProps) {
  const {
    mode: navigationMode,
    setMode,
    titleNavigation: navigationData,
    statusNavigation,
  } = useNavigation();

  const handleExit = () => {
    window.close();
  };

  const handleNavigationToggle = () => {
    const nextMode: NavigationMode = navigationMode === "stack" ? "tree" : "stack";
    setMode(nextMode);
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
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <IconButton variant="ghost" size="1">
                <HamburgerMenuIcon />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              <DropdownMenu.Item shortcut="⌘⇧O" onSelect={() => onOpenWorkspaceChooser?.()}>
                Switch Workspace...
              </DropdownMenu.Item>
              <DropdownMenu.Item shortcut="⌘," onSelect={() => onOpenSettings?.()}>
                Settings...
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item shortcut="Ctrl+Z">Undo</DropdownMenu.Item>
              <DropdownMenu.Item shortcut="Ctrl+Y">Redo</DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item shortcut="Ctrl+X">Cut</DropdownMenu.Item>
              <DropdownMenu.Item shortcut="Ctrl+C">Copy</DropdownMenu.Item>
              <DropdownMenu.Item shortcut="Ctrl+V">Paste</DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item shortcut="Ctrl+R">Reload</DropdownMenu.Item>
              <DropdownMenu.Item shortcut="Ctrl+Shift+R">Force Reload</DropdownMenu.Item>
              <DropdownMenu.Item shortcut="Ctrl+Shift+I" onSelect={() => onOpenPanelDevTools?.()}>
                Toggle Panel DevTools
              </DropdownMenu.Item>
              <DropdownMenu.Item shortcut="Ctrl+Alt+I" onSelect={() => onOpenAppDevTools?.()}>
                Toggle App DevTools
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item shortcut="Ctrl+Q" onSelect={handleExit}>
                Exit
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>

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
}

const MAX_VISIBLE_ANCESTORS = 2;
const MAX_VISIBLE_DESC_GROUPS = 2;

function BreadcrumbBar({
  title,
  navigationData,
  statusNavigation,
  onNavigate,
}: BreadcrumbBarProps) {
  const ancestors = navigationData?.ancestors ?? [];
  const descendantGroups = statusNavigation?.descendantGroups ?? [];

  const visibleAncestors = ancestors.slice(-MAX_VISIBLE_ANCESTORS);
  const hiddenAncestors = ancestors.slice(0, ancestors.length - visibleAncestors.length);

  const visibleDescendants = descendantGroups.slice(0, MAX_VISIBLE_DESC_GROUPS);
  const hiddenDescendants = descendantGroups.slice(visibleDescendants.length);

  const renderSiblingGroup = (
    siblings: Panel[],
    pathToParent: string[],
    activeId: string | null
  ) => {
    if (siblings.length === 0) return null;
    const showActive = activeId || siblings[0]?.id || "";

    if (siblings.length === 1) {
      const single = siblings[0];
      if (!single) return null;
      return (
        <Button
          key={single.id}
          variant="ghost"
          size="1"
          color={single.id === showActive ? undefined : "gray"}
          onClick={() => onNavigate?.([...pathToParent, single.id])}
        >
          {single.title}
        </Button>
      );
    }

    return (
      <Flex align="center" gap="1">
        {siblings.map((sibling) => (
          <Button
            key={sibling.id}
            variant="ghost"
            size="1"
            color={sibling.id === showActive ? undefined : "gray"}
            onClick={() => onNavigate?.([...pathToParent, sibling.id])}
          >
            {sibling.title}
          </Button>
        ))}
      </Flex>
    );
  };

  return (
    <Flex align="center" gap="2" style={{ minWidth: 0, overflow: "hidden" }}>
      {/* Ancestors */}
      <Flex align="center" gap="1" style={{ minWidth: 0, overflow: "hidden" }}>
        {hiddenAncestors.length > 0 && (
          <>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                <IconButton size="1" variant="ghost" aria-label="More ancestors">
                  <DotsHorizontalIcon />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content>
                {hiddenAncestors.map((crumb) => (
                  <DropdownMenu.Item
                    key={crumb.path.join("-")}
                    onSelect={() => onNavigate?.(crumb.path)}
                  >
                    {crumb.siblings.find(
                      (sibling) => sibling.id === crumb.path[crumb.path.length - 1]
                    )?.title ??
                      crumb.siblings[0]?.title ??
                      crumb.path.join(" / ")}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Root>
            <ChevronRightIcon />
          </>
        )}
        {visibleAncestors.map((crumb) => (
          <Flex key={crumb.path.join("-")} align="center" gap="1" style={{ minWidth: 0 }}>
            {renderSiblingGroup(
              crumb.siblings,
              crumb.path.slice(0, -1),
              crumb.path[crumb.path.length - 1] || null
            )}
            <ChevronRightIcon />
          </Flex>
        ))}
      </Flex>

      {/* Current (with siblings) */}
      <Card variant="surface" size="1" style={{ display: "inline-flex" }}>
        {navigationData?.current ? (
          (renderSiblingGroup(
            navigationData.current.siblings,
            navigationData.current.parentPath,
            navigationData.current.activeId
          ) ?? (
            <Text
              size="2"
              weight="medium"
              style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
            >
              {navigationData.currentTitle ?? title}
            </Text>
          ))
        ) : (
          <Text
            size="2"
            weight="medium"
            style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
          >
            {navigationData?.currentTitle ?? title}
          </Text>
        )}
      </Card>

      {/* Descendants */}
      <Flex align="center" gap="1" style={{ minWidth: 0, overflow: "hidden" }}>
        {visibleDescendants.map((group) => (
          <Flex key={group.parentId} align="center" gap="1">
            <ChevronRightIcon />
            {renderSiblingGroup(group.children, group.pathToParent, group.selectedChildId)}
          </Flex>
        ))}
        {hiddenDescendants.length > 0 && (
          <>
            <ChevronRightIcon />
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                <IconButton size="1" variant="ghost" aria-label="More descendants">
                  <DotsHorizontalIcon />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content>
                {hiddenDescendants.map((group) => (
                  <DropdownMenu.Item
                    key={group.parentId}
                    onSelect={() =>
                      onNavigate?.([
                        ...group.pathToParent,
                        group.selectedChildId || group.children[0]?.id || "",
                      ])
                    }
                  >
                    {group.children.find((c) => c.id === group.selectedChildId)?.title ??
                      group.children[0]?.title ??
                      "Child"}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </>
        )}
      </Flex>
    </Flex>
  );
}
