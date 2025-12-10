import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from "react";
import { CaretDownIcon, CaretRightIcon } from "@radix-ui/react-icons";
import {
  Badge,
  Box,
  Card,
  Flex,
  Heading,
  IconButton,
  ScrollArea,
  Spinner,
  Text,
  TextField,
  Tooltip,
} from "@radix-ui/themes";

import type { StatusNavigationData, TitleNavigationData } from "./navigationTypes";
import type { WorkerConsoleLogEntry, PanelContextMenuAction } from "../../shared/ipc/types";
import { useNavigation } from "./NavigationContext";

interface PanelStackProps {
  onTitleChange?: (title: string) => void;
  hostTheme: "light" | "dark";
  onRegisterDevToolsHandler?: (handler: () => void) => void;
  onRegisterNavigate?: (navigate: (path: string[]) => void) => void;
  onRegisterPanelAction?: (handler: (panelId: string, action: PanelContextMenuAction) => void) => void;
}

function captureHostThemeCss(): string {
  if (typeof window === "undefined") {
    return "";
  }

  const computed = getComputedStyle(document.documentElement);
  const declarations: string[] = [];

  for (const property of Array.from(computed)) {
    if (!property.startsWith("--")) {
      continue;
    }
    const value = computed.getPropertyValue(property).trim();
    if (value) {
      declarations.push(`${property}: ${value}`);
    }
  }

  const cssVariables = `:root { ${declarations.join("; ")} }`;
  const baseline = `html, body { margin: 0; padding: 0; height: 100%; }
#root {
  min-height: 100vh;
  box-sizing: border-box;
}`;

  return `${cssVariables}\n${baseline}`;
}

interface PanelTreeSidebarProps {
  rootPanels: Panel[];
  visiblePath: string[];
  onSelect: (path: string[]) => void;
  onPanelAction?: (panelId: string, action: PanelContextMenuAction) => void;
}

function PanelTreeSidebar({ rootPanels, visiblePath, onSelect, onPanelAction }: PanelTreeSidebarProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  useEffect(() => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      visiblePath.forEach((id) => next.add(id));
      return next;
    });
  }, [visiblePath]);

  const toggleExpanded = (panelId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(panelId)) {
        next.delete(panelId);
      } else {
        next.add(panelId);
      }
      return next;
    });
  };

  const handleContextMenu = async (e: React.MouseEvent, panel: Panel) => {
    e.preventDefault();
    e.stopPropagation();
    const { screenX, screenY } = e;
    const action = await window.electronAPI.showPanelContextMenu(
      panel.id,
      panel.type,
      { x: Math.round(screenX), y: Math.round(screenY) }
    );
    if (action) {
      onPanelAction?.(panel.id, action);
    }
  };

  const renderNodes = (panels: Panel[], ancestry: string[]): ReactNode =>
    panels.map((panel) => {
      const path = [...ancestry, panel.id];
      const isActive =
        path.length === visiblePath.length &&
        path.every((value, index) => visiblePath[index] === value);
      const isExpanded = expandedIds.has(panel.id) || panel.children.length === 0;
      const backgroundColor =
        isActive && hoveredId === panel.id
          ? "var(--gray-a5)"
          : isActive
            ? "var(--gray-a4)"
            : hoveredId === panel.id
              ? "var(--gray-a3)"
              : undefined;

      // Get tooltip content based on panel type
      const tooltipContent =
        panel.type === "browser" ? panel.url : "path" in panel ? panel.path : panel.id;

      return (
        <Box key={panel.id} style={{ paddingLeft: `calc(${ancestry.length} * var(--space-2))` }}>
          <Tooltip content={tooltipContent} side="right">
            <Flex
              align="center"
              gap="2"
              px="2"
              py="1"
              style={{
                cursor: "pointer",
                backgroundColor,
                transition: "background-color 120ms ease-out",
              }}
              data-active={isActive ? "true" : "false"}
              onClick={() => onSelect(path)}
              onContextMenu={(e) => handleContextMenu(e, panel)}
              onMouseEnter={() => setHoveredId(panel.id)}
              onMouseLeave={() =>
                setHoveredId((current) => (current === panel.id ? null : current))
              }
            >
              {panel.children.length > 0 ? (
                <IconButton
                  size="1"
                  variant="ghost"
                  color="gray"
                  aria-label={isExpanded ? "Collapse section" : "Expand section"}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleExpanded(panel.id);
                  }}
                >
                  {isExpanded ? <CaretDownIcon /> : <CaretRightIcon />}
                </IconButton>
              ) : (
                <Box style={{ width: "24px", height: "24px", minWidth: "24px", flexShrink: 0 }} />
              )}
              <Text
                size="2"
                weight={isActive ? "medium" : "regular"}
                style={{
                  flex: 1,
                  minWidth: 0,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {panel.title}
              </Text>
              {panel.children.length > 0 ? (
                <Badge size="1" variant="soft" color="gray" radius="full">
                  {panel.children.length}
                </Badge>
              ) : null}
            </Flex>
          </Tooltip>
          {isExpanded && panel.children.length > 0 ? renderNodes(panel.children, path) : null}
        </Box>
      );
    });

  if (rootPanels.length === 0) {
    return (
      <Flex height="100%" align="center" justify="center">
        <Text color="gray">No panels yet</Text>
      </Flex>
    );
  }

  return (
    <ScrollArea type="auto" scrollbars="vertical" style={{ height: "100%" }}>
      <Flex direction="column" gap="1" p="1">
        {renderNodes(rootPanels, [])}
      </Flex>
    </ScrollArea>
  );
}

export function PanelStack({
  onTitleChange,
  hostTheme,
  onRegisterDevToolsHandler,
  onRegisterNavigate,
  onRegisterPanelAction,
}: PanelStackProps) {
  // Debug: log component render

  const { mode: navigationMode, setTitleNavigation, setStatusNavigation } = useNavigation();
  const [rootPanels, setRootPanels] = useState<Panel[]>([]);
  const [visiblePanelPath, setVisiblePanelPath] = useState<string[]>([]);
  const [isTreeReady, setIsTreeReady] = useState(false);
  const [hostThemeCss, setHostThemeCss] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(260);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [isResizeHover, setIsResizeHover] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const resizePointerIdRef = useRef<number | null>(null);

  // Browser navigation helpers
  useEffect(() => {
    const css = captureHostThemeCss();
    setHostThemeCss(css);

    void window.electronAPI.updatePanelTheme(hostTheme).catch((error) => {
      console.error("Failed to broadcast panel theme", error);
    });
  }, [hostTheme]);

  // Listen for panel tree updates from main process
  useEffect(() => {
    let mounted = true;

    const initializeTree = async () => {
      try {
        const currentTree = await window.electronAPI.getPanelTree();
        if (mounted) {
          setRootPanels(currentTree);
          if (currentTree.length > 0) {
            setIsTreeReady(true);
            setVisiblePanelPath([currentTree[0]!.id]);
          }
        }
      } catch (error) {
        console.error("Failed to load initial panel tree", error);
      }
    };

    void initializeTree();

    const cleanup = window.electronAPI.onPanelTreeUpdated((updatedRootPanels) => {
      setIsTreeReady(true);
      setRootPanels(updatedRootPanels);

      setVisiblePanelPath((prevPath) => {
        if (updatedRootPanels.length === 0) {
          return [];
        }

        if (prevPath.length === 0) {
          return [updatedRootPanels[0]!.id];
        }

        if (!findPanelByPathInTree(updatedRootPanels, prevPath)) {
          return [updatedRootPanels[0]!.id];
        }

        return prevPath;
      });
    });

    return () => {
      mounted = false;
      cleanup();
    };
  }, []);

  // CDP visibility toggle is no longer needed with WebContentsView architecture.
  // WebContentsViews are always composited even when not visible on screen,
  // so screenshots work without visibility hacks.

  const findPanelByPathInTree = (tree: Panel[], path: string[]): Panel | null => {
    if (path.length === 0) return null;

    let current: Panel | undefined = tree.find((p) => p.id === path[0]);
    if (!current) return null;

    for (let i = 1; i < path.length; i++) {
      current = current.children.find((c: Panel) => c.id === path[i]);
      if (!current) return null;
    }

    return current;
  };

  // Get the panel at a specific path using current state
  const getPanelByPath = useCallback(
    (path: string[]): Panel | null => findPanelByPathInTree(rootPanels, path),
    [rootPanels]
  );

  const visiblePanel = useMemo(
    () => getPanelByPath(visiblePanelPath),
    [getPanelByPath, visiblePanelPath]
  );

  const fullPath = useMemo(() => {
    const path: Panel[] = [];
    for (let i = 0; i < visiblePanelPath.length; i++) {
      const panel = getPanelByPath(visiblePanelPath.slice(0, i + 1));
      if (panel) path.push(panel);
    }
    return path;
  }, [getPanelByPath, visiblePanelPath]);

  const titleNavigationData = useMemo<TitleNavigationData | null>(() => {
    if (!visiblePanel) {
      return null;
    }

    const ancestors = fullPath.slice(0, -1).map((_, index) => {
      const parent = index > 0 ? getPanelByPath(visiblePanelPath.slice(0, index)) : null;
      const siblings = index === 0 ? rootPanels : parent?.children || [];
      return {
        path: visiblePanelPath.slice(0, index + 1),
        siblings,
      };
    });

    const parentPath = visiblePanelPath.slice(0, -1);
    const parent = parentPath.length > 0 ? getPanelByPath(parentPath) : null;
    const siblings = parentPath.length === 0 ? rootPanels : parent?.children || [];

    const current =
      siblings.length > 0
        ? {
            parentPath,
            siblings,
            activeId: visiblePanel.id,
          }
        : null;

    return {
      ancestors,
      current,
      currentTitle: visiblePanel.title,
    };
  }, [fullPath, getPanelByPath, rootPanels, visiblePanel, visiblePanelPath]);

  const statusNavigationData = useMemo<StatusNavigationData>(() => {
    const descendantGroups: StatusNavigationData["descendantGroups"] = [];
    let currentPanel: Panel | null = visiblePanel;
    const pathToParent = [...visiblePanelPath];

    while (currentPanel && currentPanel.children.length > 0) {
      if (currentPanel.selectedChildId) {
        descendantGroups.push({
          pathToParent: [...pathToParent],
          children: currentPanel.children,
          selectedChildId: currentPanel.selectedChildId,
          parentId: currentPanel.id,
        });
        pathToParent.push(currentPanel.selectedChildId);
        currentPanel =
          currentPanel.children.find((c: Panel) => c.id === currentPanel!.selectedChildId) || null;
      } else {
        break;
      }
    }

    return { descendantGroups };
  }, [visiblePanel, visiblePanelPath]);

  useEffect(() => {
    setTitleNavigation(titleNavigationData);
  }, [setTitleNavigation, titleNavigationData]);

  useEffect(() => {
    setStatusNavigation(statusNavigationData);
  }, [setStatusNavigation, statusNavigationData]);

  // Flatten all panels into a single array for rendering all webviews
  const flattenPanels = (panels: Panel[]): Panel[] => {
    const result: Panel[] = [];
    const traverse = (panelList: Panel[]) => {
      for (const panel of panelList) {
        result.push(panel);
        if (panel.children.length > 0) {
          traverse(panel.children);
        }
      }
    };
    traverse(panels);
    return result;
  };

  const allPanels = flattenPanels(rootPanels);

  // Debug: log all panels
  function findPanelById(panelId: string): Panel | null {
    const traverse = (panelList: Panel[]): Panel | null => {
      for (const panel of panelList) {
        if (panel.id === panelId) {
          return panel;
        }
        if (panel.children.length > 0) {
          const found = traverse(panel.children);
          if (found) {
            return found;
          }
        }
      }
      return null;
    };

    return traverse(rootPanels);
  }

  // Navigate to a specific panel in the tree
  const navigateToPanel = useCallback(
    (path: string[]) => {
      if (!Array.isArray(path) || path.length === 0) {
        return;
      }
      setVisiblePanelPath(path);
    },
    [setVisiblePanelPath]
  );

  useEffect(() => {
    if (!onRegisterNavigate) return;
    onRegisterNavigate(navigateToPanel);
  }, [onRegisterNavigate, navigateToPanel]);

  // Helper to find siblings of a panel (panels with the same parent)
  const findSiblings = useCallback(
    (panelId: string): Panel[] => {
      // Check if panel is a root panel
      const isRoot = rootPanels.some((p) => p.id === panelId);
      if (isRoot) {
        return rootPanels;
      }

      // Find parent by traversing tree
      const findParent = (panels: Panel[]): Panel | null => {
        for (const panel of panels) {
          if (panel.children.some((c: Panel) => c.id === panelId)) {
            return panel;
          }
          const found = findParent(panel.children);
          if (found) return found;
        }
        return null;
      };

      const parent = findParent(rootPanels);
      return parent?.children ?? [];
    },
    [rootPanels]
  );

  // Handle panel context menu actions (reload, close, etc.)
  const handlePanelAction = useCallback(
    async (panelId: string, action: PanelContextMenuAction) => {
      switch (action) {
        case "reload":
          await window.electronAPI.reloadPanel(panelId);
          break;
        case "close":
          await window.electronAPI.closePanel(panelId);
          break;
        case "close-siblings": {
          // Close all siblings except this one in parallel for better UX
          const siblings = findSiblings(panelId);
          const closePromises = siblings
            .filter((sibling) => sibling.id !== panelId)
            .map((sibling) => window.electronAPI.closePanel(sibling.id));
          await Promise.all(closePromises);
          break;
        }
        case "close-subtree":
          // Close the panel and all its descendants (closePanel handles recursion)
          await window.electronAPI.closePanel(panelId);
          break;
      }
    },
    [findSiblings]
  );

  // Register panel action handler with parent
  useEffect(() => {
    onRegisterPanelAction?.(handlePanelAction);
  }, [onRegisterPanelAction, handlePanelAction]);

  const startSidebarResize = (event: React.PointerEvent) => {
    event.preventDefault();
    resizePointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizingSidebar(true);
  };

  useEffect(() => {
    if (!isResizingSidebar) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (resizePointerIdRef.current !== null && event.pointerId !== resizePointerIdRef.current) {
        return;
      }
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const nextWidth = event.clientX - rect.left;
      const maxWidth = Math.max(240, rect.width - 200);
      const clamped = Math.min(maxWidth, Math.max(180, nextWidth));
      setSidebarWidth(clamped);
    };

    const stopResize = (event: PointerEvent) => {
      if (resizePointerIdRef.current !== null && event.pointerId !== resizePointerIdRef.current) {
        return;
      }
      resizePointerIdRef.current = null;
      setIsResizingSidebar(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize, { capture: true });
    window.addEventListener("pointercancel", stopResize, { capture: true });

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize, { capture: true } as any);
      window.removeEventListener("pointercancel", stopResize, { capture: true } as any);
    };
  }, [isResizingSidebar]);

  // Notify panels about focus changes
  useEffect(() => {
    const panelId = visiblePanel?.id;
    if (!panelId) {
      return;
    }

    void window.electronAPI.notifyPanelFocused(panelId).catch((error) => {
      console.error("Failed to notify panel focus", error);
    });
  }, [visiblePanel?.id]);

  // Track the panel content container for bounds reporting
  const panelContentRef = useRef<HTMLDivElement | null>(null);
  const previousVisiblePanelId = useRef<string | null>(null);

  // Report bounds to main process when visible panel changes or container resizes
  useEffect(() => {
    const container = panelContentRef.current;
    const panelId = visiblePanel?.id;
    const htmlPath = visiblePanel?.artifacts?.htmlPath;

    if (!container || !panelId) {
      return;
    }

    // Hide previous panel's view when switching panels
    if (previousVisiblePanelId.current && previousVisiblePanelId.current !== panelId) {
      void window.electronAPI.setViewVisible(previousVisiblePanelId.current, false);
    }
    previousVisiblePanelId.current = panelId;

    // For app panels, only interact with view if htmlPath is set (view is created after build)
    // Browser panels don't have htmlPath but do have views
    // Panels with errors or still building have no view to show
    const hasView = visiblePanel?.type === "browser" || !!htmlPath;
    if (!hasView) {
      return;
    }

    // Report bounds to main process for WebContentsView positioning
    const reportBounds = () => {
      const rect = container.getBoundingClientRect();
      const bounds = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      void window.electronAPI.setViewBounds(panelId, bounds);
    };

    // Wait for next paint cycle before first bounds report to ensure DOM is settled
    const rafId = requestAnimationFrame(() => {
      reportBounds();
    });

    // Show current panel's view
    void window.electronAPI.setViewVisible(panelId, true);

    // Set up ResizeObserver to track container size changes
    const observer = new ResizeObserver(() => {
      reportBounds();
    });
    observer.observe(container);

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
    // Re-run when panel ID changes OR when htmlPath is set (view becomes ready)
  }, [visiblePanel?.id, visiblePanel?.type, visiblePanel?.artifacts?.htmlPath]);

  // Send theme CSS to main process for injection into views
  useEffect(() => {
    if (hostThemeCss) {
      void window.electronAPI.setViewThemeCss(hostThemeCss);
    }
  }, [hostThemeCss]);

  const openDevToolsForVisiblePanel = useCallback(() => {
    const panelId = visiblePanel?.id;
    if (!panelId) {
      return;
    }

    void window.electronAPI.openPanelDevTools(panelId).catch((error) => {
      console.error("Failed to open panel devtools", error);
    });
  }, [visiblePanel?.id]);

  useEffect(() => {
    // Provide the actual handler so callers don't need to double-invoke
    onRegisterDevToolsHandler?.(openDevToolsForVisiblePanel);
  }, [onRegisterDevToolsHandler, openDevToolsForVisiblePanel]);

  // Notify parent of title changes
  useEffect(() => {
    if (onTitleChange && visiblePanel) {
      onTitleChange(visiblePanel.title);
    }
  }, [onTitleChange, visiblePanel]);

  const isTreeNavigation = navigationMode === "tree";

  // Show loading state while initializing
  if (!isTreeReady) {
    return (
      <Flex direction="column" align="center" justify="center" style={{ flex: 1, height: "100%" }}>
        <Spinner size="3" />
        <Text mt="3">Initializing panels...</Text>
      </Flex>
    );
  }

  if (!visiblePanel) {
    return (
      <Flex direction="column" align="center" justify="center" style={{ flex: 1, height: "100%" }}>
        <Text>No panels available.</Text>
      </Flex>
    );
  }

  return (
    <Flex
      direction="column"
      gap="0"
      height="100%"
      style={{ flex: 1, minHeight: 0 }}
      ref={containerRef}
    >
      <Flex gap="0" flexGrow="1" minHeight="0">
        {isTreeNavigation && (
          <Card
            size="2"
            style={{
              width: `${sidebarWidth}px`,
              minWidth: "200px",
              flexShrink: 0,
              height: "100%",
              overflow: "hidden",
            }}
          >
            <Flex direction="column" height="100%" gap="2">
              <Flex align="center" justify="between" px="1" pt="1">
                <Heading size="2" weight="medium">
                  Panel tree
                </Heading>
                <Text size="1" color="gray">
                  {rootPanels.length} root{rootPanels.length === 1 ? "" : "s"}
                </Text>
              </Flex>
              <PanelTreeSidebar
                rootPanels={rootPanels}
                visiblePath={visiblePanelPath}
                onSelect={navigateToPanel}
                onPanelAction={handlePanelAction}
              />
            </Flex>
          </Card>
        )}

        {isTreeNavigation && (
          <Box
            onPointerDown={startSidebarResize}
            onPointerEnter={() => setIsResizeHover(true)}
            onPointerLeave={() => setIsResizeHover(false)}
            style={{
              cursor: "col-resize",
              flexShrink: 0,
              height: "100%",
              backgroundColor:
                isResizingSidebar || isResizeHover ? "var(--gray-8)" : "var(--gray-6)",
              transition: "background-color 120ms ease-out",
            }}
          />
        )}

        {/* Current Panel with Tab Siblings */}
        {visiblePanel && (
          <Flex direction="column" flexGrow="1" gap="0" minHeight="0">
            {/* Panel Content */}
            <Card size="3" style={{ flexGrow: 1, overflow: "hidden", padding: 0 }}>
              <Flex direction="column" gap="0" height="100%">
                <Box ref={panelContentRef} style={{ flexGrow: 1, position: "relative", minHeight: 0, height: "100%" }}>
                  {/* Panel content area - WebContentsViews are positioned over this by main process */}
                  {/* We still render some content for workers/errors, but app/browser panels are managed by ViewManager */}
                  {allPanels.map((panel) => {
                    const artifacts = panel.artifacts;
                    const isVisible = visiblePanel ? panel.id === visiblePanel.id : false;

                    if (isVisible) {
                      if (artifacts?.error) {
                        return (
                          <Flex
                            key={panel.id}
                            direction="column"
                            align="center"
                            justify="center"
                            height="100%"
                            p="4"
                          >
                            <Text color="red" size="4" weight="bold" mb="2">
                              Panel Build Error
                            </Text>
                            <Text color="red" size="2" style={{ fontFamily: "monospace" }}>
                              {artifacts.error}
                            </Text>
                          </Flex>
                        );
                      }

                      if (!artifacts?.htmlPath) {
                        // Workers don't have htmlPath - show console output
                        if (panel.type === "worker") {
                          const logs = panel.consoleLogs ?? [];
                          return (
                            <Flex
                              key={panel.id}
                              direction="column"
                              height="100%"
                              p="3"
                              style={{ overflow: "hidden" }}
                            >
                              <Flex align="center" gap="2" mb="2">
                                <Badge color="orange" variant="soft">
                                  Worker
                                </Badge>
                                <Text size="2" weight="bold">
                                  {panel.title}
                                </Text>
                              </Flex>
                              <Card
                                variant="surface"
                                style={{
                                  flex: 1,
                                  overflow: "hidden",
                                  backgroundColor: "var(--gray-2)",
                                }}
                              >
                                <ScrollArea
                                  type="auto"
                                  scrollbars="vertical"
                                  style={{ height: "100%" }}
                                >
                                  <Flex direction="column" gap="1" p="2">
                                    {logs.length === 0 ? (
                                      <Text size="2" color="gray">
                                        No console output yet...
                                      </Text>
                                    ) : (
                                      logs.map((log: WorkerConsoleLogEntry, idx: number) => {
                                        const time = new Date(log.timestamp).toLocaleTimeString();
                                        const color =
                                          log.level === "error"
                                            ? "red"
                                            : log.level === "warn"
                                              ? "orange"
                                              : "gray";
                                        return (
                                          <Text
                                            key={idx}
                                            size="1"
                                            color={color}
                                            style={{
                                              fontFamily: "monospace",
                                              whiteSpace: "pre-wrap",
                                              wordBreak: "break-word",
                                            }}
                                          >
                                            <Text color="gray">[{time}]</Text> {log.message}
                                          </Text>
                                        );
                                      })
                                    )}
                                  </Flex>
                                </ScrollArea>
                              </Card>
                            </Flex>
                          );
                        }

                        // Browser panels - WebContentsView is managed by main process, no in-shell toolbar
                        if (panel.type === "browser") {
                          return (
                            <Box
                              key={panel.id}
                              style={{ flex: 1, position: "relative", height: "100%" }}
                            />
                          );
                        }

                        // Regular panel loading state (while build is in progress)
                        // Once build completes, ViewManager creates the WebContentsView
                        return (
                          <Flex
                            key={panel.id}
                            direction="column"
                            align="center"
                            justify="center"
                            height="100%"
                          >
                            <Spinner size="3" />
                            <Text mt="3">Preparing panel...</Text>
                          </Flex>
                        );
                      }
                    }

                    // Non-visible panels: no UI needed, WebContentsViews are managed by main process
                    // Return null for hidden app/browser panels (ViewManager handles visibility)
                    return null;
                  })}
                </Box>
              </Flex>
            </Card>
          </Flex>
        )}
      </Flex>
    </Flex>
  );
}
