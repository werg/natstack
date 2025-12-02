import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from "react";
import {
  CaretDownIcon,
  CaretRightIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ReloadIcon,
  Cross2Icon,
  GlobeIcon,
} from "@radix-ui/react-icons";
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
import type { WorkerConsoleLogEntry, BrowserPanel, BrowserState } from "../../shared/ipc/types";
import { useNavigation } from "./NavigationContext";

interface PanelStackProps {
  onTitleChange?: (title: string) => void;
  hostTheme: "light" | "dark";
  onRegisterDevToolsHandler?: (handler: () => void) => void;
  onRegisterNavigate?: (navigate: (path: string[]) => void) => void;
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
}

function PanelTreeSidebar({ rootPanels, visiblePath, onSelect }: PanelTreeSidebarProps) {
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
}: PanelStackProps) {
  // Debug: log component render

  const { mode: navigationMode, setTitleNavigation, setStatusNavigation } = useNavigation();
  const [rootPanels, setRootPanels] = useState<Panel[]>([]);
  const [visiblePanelPath, setVisiblePanelPath] = useState<string[]>([]);
  const [isTreeReady, setIsTreeReady] = useState(false);
  const [panelPreloadPath, setPanelPreloadPath] = useState<string | null>(null);
  const [hostThemeCss, setHostThemeCss] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(260);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [isResizeHover, setIsResizeHover] = useState(false);
  const [browserUrlInputs, setBrowserUrlInputs] = useState<Map<string, string>>(new Map());
  const webviewRefs = useRef<Map<string, Electron.WebviewTag>>(new Map());
  const panelThemeCssKeys = useRef<Map<string, string>>(new Map());
  const domReadyPanels = useRef<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement | null>(null);
  const resizePointerIdRef = useRef<number | null>(null);

  const applyThemeCss = (panelId: string, explicitWebview?: Electron.WebviewTag) => {
    const panel = findPanelById(panelId);
    if (!panel || panel.injectHostThemeVariables === false) {
      return;
    }

    if (!hostThemeCss || !domReadyPanels.current.has(panelId)) {
      return;
    }

    const webview = explicitWebview ?? webviewRefs.current.get(panelId);
    if (!webview) {
      return;
    }

    const previousKey = panelThemeCssKeys.current.get(panelId);

    const insertCss = () => {
      void (webview as any)
        .insertCSS(hostThemeCss, { cssOrigin: "author" })
        .then((key: string) => {
          panelThemeCssKeys.current.set(panelId, key);
        })
        .catch((error: unknown) => {
          console.error(`Failed to inject theme CSS for panel ${panelId}`, error);
        });
    };

    if (previousKey) {
      void webview
        .removeInsertedCSS(previousKey)
        .catch((error) => {
          console.error(`Failed to remove previous theme CSS for panel ${panelId}`, error);
        })
        .finally(() => {
          panelThemeCssKeys.current.delete(panelId);
          insertCss();
        });
    } else {
      insertCss();
    }
  };

  // Browser navigation helpers
  const getBrowserUrlInput = (panelId: string, fallback: string): string => {
    return browserUrlInputs.get(panelId) ?? fallback;
  };

  const setBrowserUrlInput = (panelId: string, url: string) => {
    setBrowserUrlInputs((prev) => {
      const next = new Map(prev);
      next.set(panelId, url);
      return next;
    });
  };

  const handleBrowserNavigate = (panelId: string, url: string) => {
    const webview = webviewRefs.current.get(panelId);
    if (webview) {
      // Ensure URL has a protocol
      let normalizedUrl = url.trim();
      if (normalizedUrl && !normalizedUrl.match(/^[a-z]+:\/\//i)) {
        normalizedUrl = `https://${normalizedUrl}`;
      }
      if (normalizedUrl) {
        void webview.loadURL(normalizedUrl);
      }
    }
  };

  const handleBrowserGoBack = (panelId: string) => {
    const webview = webviewRefs.current.get(panelId);
    if (webview?.canGoBack()) {
      webview.goBack();
    }
  };

  const handleBrowserGoForward = (panelId: string) => {
    const webview = webviewRefs.current.get(panelId);
    if (webview?.canGoForward()) {
      webview.goForward();
    }
  };

  const handleBrowserReload = (panelId: string) => {
    const webview = webviewRefs.current.get(panelId);
    webview?.reload();
  };

  const handleBrowserStop = (panelId: string) => {
    const webview = webviewRefs.current.get(panelId);
    webview?.stop();
  };

  useEffect(() => {
    const css = captureHostThemeCss();
    setHostThemeCss(css);

    void window.electronAPI.updatePanelTheme(hostTheme).catch((error) => {
      console.error("Failed to broadcast panel theme", error);
    });
  }, [hostTheme]);

  useEffect(() => {
    if (!hostThemeCss) {
      return;
    }

    for (const [panelId, webview] of webviewRefs.current.entries()) {
      applyThemeCss(panelId, webview);
    }
  }, [hostThemeCss]);

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
      // Debug: log all panels in tree
      const logPanels = (panels: Panel[], depth = 0): void => {
        for (const p of panels) {
          console.log(
            `[PanelStack] ${"  ".repeat(depth)}Panel: ${p.id}, htmlPath: ${p.artifacts?.htmlPath?.slice(0, 80) ?? "none"}`
          );
          if (p.children.length > 0) logPanels(p.children, depth + 1);
        }
      };
      console.log("[PanelStack] Panel tree updated:");
      logPanels(updatedRootPanels);
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

  useEffect(() => {
    let mounted = true;
    window.electronAPI
      .getPanelPreloadPath()
      .then((value) => {
        if (mounted) {
          setPanelPreloadPath(value);
        }
      })
      .catch((error) => {
        console.error("Failed to resolve panel preload path", error);
      });

    return () => {
      mounted = false;
    };
  }, []);

  // Sync browser URL inputs when actual URLs change (e.g., from navigation)
  // Also clean up entries for removed panels to prevent memory leaks
  useEffect(() => {
    setBrowserUrlInputs((prev) => {
      const next = new Map(prev);

      // Collect all current browser panel IDs
      const currentBrowserIds = new Set<string>();
      const collectBrowserIds = (panels: Panel[]) => {
        for (const panel of panels) {
          if (panel.type === "browser") {
            currentBrowserIds.add(panel.id);

            // Also check if stored URL doesn't match actual URL (navigation occurred)
            const stored = next.get(panel.id);
            const actualUrl = (panel as BrowserPanel).url;
            if (stored !== undefined && stored !== actualUrl) {
              next.delete(panel.id);
            }
          }
          collectBrowserIds(panel.children);
        }
      };
      collectBrowserIds(rootPanels);

      // Remove entries for panels that no longer exist
      for (const panelId of next.keys()) {
        if (!currentBrowserIds.has(panelId)) {
          next.delete(panelId);
        }
      }

      return next;
    });
  }, [rootPanels]);

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

  // Initialize webview with panel ID when it loads
  const webviewCleanup = useRef<Map<string, () => void>>(new Map());

  const handleWebviewReady = (panelId: string, webview: HTMLElement, isBrowser: boolean = false) => {
    // Skip if we already have listeners set up for this panel
    // (ref callbacks can be called multiple times)
    if (webviewCleanup.current.has(panelId)) {
      return;
    }

    const webviewTag = webview as unknown as Electron.WebviewTag;
    webviewRefs.current.set(panelId, webviewTag);

    // Note: Browser webview registration with the CDP server is now handled automatically
    // by the main process via the did-attach-webview event. This is more reliable than
    // trying to call getWebContentsId from the renderer, which has timing issues with
    // Electron's webview lifecycle.

    const onDomReady = () => {
      console.log(`[PanelStack] dom-ready fired for ${panelId}, isBrowser=${isBrowser}`);
      domReadyPanels.current.add(panelId);
      applyThemeCss(panelId, webviewTag);
    };

    const onDestroyed = () => {
      domReadyPanels.current.delete(panelId);
      panelThemeCssKeys.current.delete(panelId);
      webviewCleanup.current.get(panelId)?.();
      webviewCleanup.current.delete(panelId);
    };

    webviewTag.addEventListener("dom-ready", onDomReady);
    webviewTag.addEventListener("destroyed", onDestroyed);

    // Browser-specific event listeners for state forwarding
    // Uses debouncing to batch multiple updates and reduce IPC traffic
    let browserCleanup: (() => void) | undefined;
    if (isBrowser) {
      // Debounced state update - batches changes within 50ms window
      let pendingState: {
        url?: string;
        isLoading?: boolean;
        canGoBack?: boolean;
        canGoForward?: boolean;
        pageTitle?: string;
      } = {};
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;

      const flushPendingState = () => {
        if (Object.keys(pendingState).length > 0) {
          void window.electronAPI.updateBrowserState(panelId, pendingState);
          pendingState = {};
        }
        debounceTimer = null;
      };

      const queueStateUpdate = (update: typeof pendingState) => {
        Object.assign(pendingState, update);
        if (!debounceTimer) {
          debounceTimer = setTimeout(flushPendingState, 50);
        }
      };

      const onDidNavigate = (event: Electron.DidNavigateEvent) => {
        queueStateUpdate({ url: event.url });
      };

      const onDidStartLoading = () => {
        queueStateUpdate({ isLoading: true });
      };

      const onDidStopLoading = () => {
        queueStateUpdate({
          isLoading: false,
          canGoBack: webviewTag.canGoBack(),
          canGoForward: webviewTag.canGoForward(),
        });
      };

      const onPageTitleUpdated = (event: Electron.PageTitleUpdatedEvent) => {
        queueStateUpdate({ pageTitle: event.title });
      };

      // Handle navigation failures - ERR_ABORTED (-3) is common for redirects
      const onDidFailLoad = (event: Electron.DidFailLoadEvent) => {
        // Ignore aborted loads (redirects, user navigation, etc.)
        if (event.errorCode === -3) {
          return;
        }
        // Log other errors for debugging
        console.warn(`[Browser] Navigation failed: ${event.errorDescription} (${event.errorCode})`);
      };

      webviewTag.addEventListener("did-navigate", onDidNavigate);
      webviewTag.addEventListener("did-navigate-in-page", onDidNavigate);
      webviewTag.addEventListener("did-start-loading", onDidStartLoading);
      webviewTag.addEventListener("did-stop-loading", onDidStopLoading);
      webviewTag.addEventListener("page-title-updated", onPageTitleUpdated);
      webviewTag.addEventListener("did-fail-load", onDidFailLoad);

      browserCleanup = () => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          flushPendingState(); // Flush any pending updates on cleanup
        }
        webviewTag.removeEventListener("did-navigate", onDidNavigate);
        webviewTag.removeEventListener("did-navigate-in-page", onDidNavigate);
        webviewTag.removeEventListener("did-start-loading", onDidStartLoading);
        webviewTag.removeEventListener("did-stop-loading", onDidStopLoading);
        webviewTag.removeEventListener("page-title-updated", onPageTitleUpdated);
        webviewTag.removeEventListener("did-fail-load", onDidFailLoad);
      };
    }

    webviewCleanup.current.set(panelId, () => {
      webviewTag.removeEventListener("dom-ready", onDomReady);
      webviewTag.removeEventListener("destroyed", onDestroyed);
      browserCleanup?.();
    });
  };

  useEffect(() => {
    return () => {
      webviewCleanup.current.forEach((cleanup) => cleanup());
      webviewCleanup.current.clear();
    };
  }, []);

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
    onRegisterDevToolsHandler?.(() => openDevToolsForVisiblePanel);
  }, [onRegisterDevToolsHandler, openDevToolsForVisiblePanel]);

  // Notify parent of title changes
  useEffect(() => {
    if (onTitleChange && visiblePanel) {
      onTitleChange(visiblePanel.title);
    }
  }, [onTitleChange, visiblePanel]);

  const isTreeNavigation = navigationMode === "tree";

  // Show loading state while initializing
  if (!isTreeReady || !panelPreloadPath) {
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
                <Box style={{ flexGrow: 1, position: "relative" }}>
                  {/* Render all webviews, show only the visible one */}
                  {allPanels.map((panel) => {
                    const artifacts = panel.artifacts;
                    const isVisible = visiblePanel ? panel.id === visiblePanel.id : false;

                    // Debug logging for all panels
                    console.log(
                      `[PanelStack] Rendering panel: ${panel.id}, visible: ${isVisible}, hasArtifacts: ${!!artifacts}, htmlPath: ${artifacts?.htmlPath?.slice(0, 50)}...`
                    );

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

                        // Browser panels show a webview with URL bar controls
                        if (panel.type === "browser") {
                          const browserPanel = panel as BrowserPanel;
                          const isLoading = browserPanel.browserState?.isLoading;
                          return (
                            <Flex
                              key={panel.id}
                              direction="column"
                              height="100%"
                              style={{ overflow: "hidden" }}
                            >
                              {/* Browser toolbar */}
                              <Flex
                                align="center"
                                gap="2"
                                p="2"
                                style={{
                                  borderBottom: "1px solid var(--gray-6)",
                                  backgroundColor: "var(--gray-2)",
                                }}
                              >
                                <IconButton
                                  size="1"
                                  variant="ghost"
                                  color="gray"
                                  disabled={!browserPanel.browserState?.canGoBack}
                                  aria-label="Go back"
                                  onClick={() => handleBrowserGoBack(panel.id)}
                                >
                                  <ArrowLeftIcon />
                                </IconButton>
                                <IconButton
                                  size="1"
                                  variant="ghost"
                                  color="gray"
                                  disabled={!browserPanel.browserState?.canGoForward}
                                  aria-label="Go forward"
                                  onClick={() => handleBrowserGoForward(panel.id)}
                                >
                                  <ArrowRightIcon />
                                </IconButton>
                                <IconButton
                                  size="1"
                                  variant="ghost"
                                  color="gray"
                                  aria-label={isLoading ? "Stop" : "Reload"}
                                  onClick={() =>
                                    isLoading
                                      ? handleBrowserStop(panel.id)
                                      : handleBrowserReload(panel.id)
                                  }
                                >
                                  {isLoading ? <Cross2Icon /> : <ReloadIcon />}
                                </IconButton>
                                <Flex flexGrow="1" align="center" gap="2">
                                  <GlobeIcon color="gray" />
                                  <TextField.Root
                                    size="1"
                                    variant="soft"
                                    style={{ flex: 1 }}
                                    value={getBrowserUrlInput(panel.id, browserPanel.url)}
                                    onChange={(e) => setBrowserUrlInput(panel.id, e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") {
                                        handleBrowserNavigate(panel.id, getBrowserUrlInput(panel.id, browserPanel.url));
                                      }
                                    }}
                                    placeholder="Enter URL..."
                                  />
                                </Flex>
                                <Badge color="blue" variant="soft">
                                  Browser
                                </Badge>
                              </Flex>
                              {/* Browser webview - no partition for standard browser behavior */}
                              <Box style={{ flex: 1, position: "relative" }}>
                                <webview
                                  ref={(el) => {
                                    if (el) {
                                      handleWebviewReady(panel.id, el, true);
                                    } else {
                                      webviewRefs.current.delete(panel.id);
                                      domReadyPanels.current.delete(panel.id);
                                      panelThemeCssKeys.current.delete(panel.id);
                                    }
                                  }}
                                  src={browserPanel.url}
                                  style={{
                                    width: "100%",
                                    height: "100%",
                                  }}
                                />
                              </Box>
                            </Flex>
                          );
                        }

                        // Regular panel loading state
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

                    // Browser panels also need webviews even when not visible (to maintain state)
                    // No partition for standard browser behavior (shared cookies/storage)
                    if (panel.type === "browser") {
                      const browserPanel = panel as BrowserPanel;
                      return (
                        <webview
                          key={panel.id}
                          ref={(el) => {
                            if (el) {
                              handleWebviewReady(panel.id, el, true);
                            } else {
                              webviewRefs.current.delete(panel.id);
                              domReadyPanels.current.delete(panel.id);
                              panelThemeCssKeys.current.delete(panel.id);
                            }
                          }}
                          src={browserPanel.url}
                          style={{
                            width: "100%",
                            height: "100%",
                            display: "none",
                          }}
                        />
                      );
                    }

                    if (artifacts?.htmlPath) {
                      // All panels are now served via natstack-panel:// protocol
                      const srcUrl = new URL(artifacts.htmlPath);
                      srcUrl.searchParams.set("panelId", panel.id);
                      const partitionName = `persist:${panel.id}`;
                      console.log(`[PanelStack] Panel URL: ${srcUrl.toString()}`);
                      console.log(
                        `[PanelStack] Creating webview element for: ${panel.id.slice(-30)}`
                      );
                      return (
                        <webview
                          key={panel.id}
                          ref={(el) => {
                            console.log(
                              `[PanelStack] webview ref callback for ${panel.id.slice(-30)}, el: ${el ? "HTMLElement" : "null"}`
                            );
                            if (el) {
                              handleWebviewReady(panel.id, el);
                            } else {
                              webviewRefs.current.delete(panel.id);
                              domReadyPanels.current.delete(panel.id);
                              panelThemeCssKeys.current.delete(panel.id);
                            }
                          }}
                          src={srcUrl.toString()}
                          preload={panelPreloadPath}
                          partition={partitionName}
                          style={{
                            width: "100%",
                            height: "100%",
                            ...(panel.id === visiblePanel.id ? {} : { display: "none" }),
                          }}
                        />
                      );
                    }

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
