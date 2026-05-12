import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Box,
  Card,
  Flex,
  Heading,
  Spinner,
  Text,
} from "@radix-ui/themes";

import type { LazyTitleNavigationData, LazyStatusNavigationData } from "./navigationTypes";
import type { PanelContextMenuAction } from "@natstack/shared/types";
import {
  buildPanelChromeState,
  isBrowserPanelSource,
  parseAddressInput,
  type PanelChromeState,
} from "@natstack/shared/panelChrome";
import {
  useRootPanels,
  useFullPanel,
  useAncestors,
  useSiblings,
  useDescendantSiblingGroups,
} from "../shell/hooks/PanelTreeContext";
import { panel as panelService, view } from "../shell/client";
import { useNavigation } from "./NavigationContext";
import { LazyPanelTreeSidebar } from "./LazyPanelTreeSidebar";
import { useShellEvent } from "../shell/useShellEvent";
import { SavePasswordBar } from "./SavePasswordBar";

interface PanelStackProps {
  onTitleChange?: (title: string) => void;
  onChromeStateChange?: (state: PanelChromeState | null) => void;
  hostTheme: "light" | "dark";
  onRegisterDevToolsHandler?: (handler: () => void) => void;
  onRegisterNavigateToId?: (navigate: (panelId: string) => void) => void;
  onRegisterPanelAction?: (handler: (panelId: string, action: PanelContextMenuAction) => void) => void;
  onRegisterArchive?: (handler: (panelId: string) => void) => void;
  onRegisterChromeCommand?: (handler: (command: ChromeCommand) => void) => void;
}

export type ChromeCommand =
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" }
  | { type: "force-reload" }
  | { type: "stop" }
  | { type: "navigate"; value: string };

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
  min-height: 100dvh;
  box-sizing: border-box;
}`;

  return `${cssVariables}\n${baseline}`;
}


export function PanelStack({
  onTitleChange,
  onChromeStateChange,
  hostTheme,
  onRegisterDevToolsHandler,
  onRegisterNavigateToId,
  onRegisterPanelAction,
  onRegisterArchive,
  onRegisterChromeCommand,
}: PanelStackProps) {
  const {
    mode: navigationMode,
    setLazyTitleNavigation,
    setLazyStatusNavigation,
    registerNavigateToId,
  } = useNavigation();

  // ID-based visible panel state
  const [visiblePanelId, setVisiblePanelId] = useState<string | null>(null);
  const [hostThemeCss, setHostThemeCss] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(260);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [isResizeHover, setIsResizeHover] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const resizePointerIdRef = useRef<number | null>(null);

  // Lazy data hooks
  const { panels: rootPanels, loading: rootLoading } = useRootPanels();
  const { panel: visiblePanel, loading: panelLoading } = useFullPanel(visiblePanelId);
  const { ancestors } = useAncestors(visiblePanelId);
  const { siblings } = useSiblings(visiblePanelId);
  const { groups: descendantGroups } = useDescendantSiblingGroups(visiblePanelId);

  // Ancestor IDs for tree auto-expansion
  const ancestorIds = useMemo(() => ancestors.map((a) => a.id), [ancestors]);

  // Theme CSS initialization
  useEffect(() => {
    const css = captureHostThemeCss();
    setHostThemeCss(css);

    void panelService.updateTheme(hostTheme).catch((error) => {
      console.error("Failed to broadcast panel theme", error);
    });
  }, [hostTheme]);

  // Initial panel selection - set visible panel when root panels load
  useEffect(() => {
    if (!visiblePanelId && rootPanels.length > 0) {
      setVisiblePanelId(rootPanels[0]!.id);
    }
  }, [rootPanels, visiblePanelId]);

  // Handle panel deletion - fall back to first root if current panel is gone
  // Use a small delay to avoid race condition with tree updates when creating new panels.
  // The tree update is debounced (16ms), so we need to wait before assuming the panel was deleted.
  useEffect(() => {
    // If we have a visible panel ID but no panel data and loading is done, panel may be deleted
    if (!visiblePanelId || visiblePanel || panelLoading || rootPanels.length === 0) {
      return;
    }
    // Delay fallback to allow pending tree updates to arrive
    const timer = setTimeout(() => {
      setVisiblePanelId((currentId) => {
        // Only fall back if we still have the same ID and still can't find the panel
        // This prevents incorrectly falling back during panel creation
        if (currentId === visiblePanelId) {
          return rootPanels[0]!.id;
        }
        return currentId;
      });
    }, 50); // 50ms > 16ms debounce, gives tree time to update
    return () => clearTimeout(timer);
  }, [visiblePanelId, visiblePanel, panelLoading, rootPanels]);

  // Build lazy title navigation data
  const lazyTitleNavigationData = useMemo<LazyTitleNavigationData | null>(() => {
    if (!visiblePanel) {
      return null;
    }

    return {
      ancestors,
      currentSiblings: siblings,
      currentId: visiblePanel.id,
      currentTitle: visiblePanel.title,
    };
  }, [ancestors, siblings, visiblePanel]);

  // Build lazy status navigation data
  const lazyStatusNavigationData = useMemo<LazyStatusNavigationData | null>(() => {
    if (!visiblePanelId) {
      return null;
    }

    return {
      descendantGroups,
      visiblePanelId,
    };
  }, [descendantGroups, visiblePanelId]);

  // Update navigation context with lazy data
  useEffect(() => {
    setLazyTitleNavigation(lazyTitleNavigationData);
  }, [setLazyTitleNavigation, lazyTitleNavigationData]);

  useEffect(() => {
    setLazyStatusNavigation(lazyStatusNavigationData);
  }, [setLazyStatusNavigation, lazyStatusNavigationData]);

  // Navigate to a specific panel by ID
  const navigateToPanelId = useCallback(
    (panelId: string) => {
      if (!panelId) {
        return;
      }
      setVisiblePanelId(panelId);
    },
    []
  );

  // Register navigate function with context
  useEffect(() => {
    registerNavigateToId(navigateToPanelId);
  }, [registerNavigateToId, navigateToPanelId]);

  // Register navigate function with parent
  useEffect(() => {
    if (!onRegisterNavigateToId) return;
    onRegisterNavigateToId(navigateToPanelId);
  }, [onRegisterNavigateToId, navigateToPanelId]);

  // Listen for navigate-to-panel events from main process (e.g., when new panels are created with focus: true)
  useShellEvent("navigate-to-panel", useCallback(({ panelId }) => {
    navigateToPanelId(panelId);
  }, [navigateToPanelId]));

  // Handle panel context menu actions (reload, unload)
  const handlePanelAction = useCallback(
    async (panelId: string, action: PanelContextMenuAction) => {
      switch (action) {
        case "back":
          await view.browserGoBack(panelId);
          break;
        case "forward":
          await view.browserGoForward(panelId);
          break;
        case "reload":
          await panelService.reload(panelId);
          break;
        case "force-reload":
          await view.browserForceReload(panelId);
          break;
        case "stop":
          await view.browserStop(panelId);
          break;
        case "copy-address": {
          const state = await panelService.getChromeState(panelId);
          await navigator.clipboard.writeText(state.editableAddress);
          break;
        }
        case "open-external": {
          const state = await panelService.getChromeState(panelId);
          if (state.resolvedUrl && /^https?:\/\//i.test(state.resolvedUrl)) {
            window.open(state.resolvedUrl, "_blank", "noopener,noreferrer");
          }
          break;
        }
        case "unload":
          // Unload panel resources but keep in tree (can be re-loaded later)
          await panelService.unload(panelId);
          break;
        case "archive":
          // Archive panel (remove from tree)
          await panelService.archive(panelId);
          break;
      }
    },
    []
  );

  // Register panel action handler with parent
  useEffect(() => {
    onRegisterPanelAction?.(handlePanelAction);
  }, [onRegisterPanelAction, handlePanelAction]);

  // Handle direct archive button clicks (X button in tree sidebar)
  const handleArchive = useCallback(
    async (panelId: string) => {
      await panelService.archive(panelId);
    },
    []
  );

  // Register archive handler with parent (for titlebar X buttons)
  useEffect(() => {
    onRegisterArchive?.(handleArchive);
  }, [onRegisterArchive, handleArchive]);

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
      window.removeEventListener("pointerup", stopResize, { capture: true } as EventListenerOptions);
      window.removeEventListener("pointercancel", stopResize, { capture: true } as EventListenerOptions);
    };
  }, [isResizingSidebar]);

  // Notify panels about focus changes
  useEffect(() => {
    const panelId = visiblePanel?.id;
    if (!panelId) {
      return;
    }

    void panelService.notifyFocused(panelId).catch((error) => {
      console.error("Failed to notify panel focus", error);
    });
  }, [visiblePanel?.id]);

  const previousVisiblePanelId = useRef<string | null>(null);

  // Show/hide panel views when visible panel changes
  // Main process calculates bounds based on layout state
  useEffect(() => {
    const panelId = visiblePanel?.id;
    const htmlPath = visiblePanel?.artifacts?.htmlPath;

    if (!panelId) {
      return;
    }

    // Hide previous panel's view when switching panels
    if (previousVisiblePanelId.current && previousVisiblePanelId.current !== panelId) {
      void view.setVisible(previousVisiblePanelId.current, false).catch((err: unknown) => console.warn("[PanelStack] Failed to hide panel:", err));
    }
    previousVisiblePanelId.current = panelId;

    // Only interact with view if it exists (htmlPath set after build)
    // Panels with errors, still building, or unloaded (pending) have no view to show
    const buildState = visiblePanel?.artifacts?.buildState;
    const isUnloaded = buildState === "pending" || buildState === "building" || buildState === "error";
    if (!isUnloaded && htmlPath) {
      // Show current panel's view - main process handles bounds calculation
      void view.setVisible(panelId, true).catch((err: unknown) => console.warn("[PanelStack] Failed to show panel:", err));
    }
  }, [visiblePanel?.id, visiblePanel?.artifacts?.htmlPath, visiblePanel?.artifacts?.buildState]);

  // Notify main process of layout changes (sidebar visibility and width)
  const sidebarVisible = navigationMode === "tree";
  useEffect(() => {
    void view.updateLayout({
      sidebarVisible,
      sidebarWidth,
    }).catch((err: unknown) => console.warn("[PanelStack] Layout update failed:", err));
  }, [sidebarVisible, sidebarWidth]);

  // Send theme CSS to main process for injection into views
  useEffect(() => {
    if (hostThemeCss) {
      void view.setThemeCss(hostThemeCss).catch((err: unknown) => console.warn("[PanelStack] Theme CSS injection failed:", err));
    }
  }, [hostThemeCss]);

  const openDevToolsForVisiblePanel = useCallback(() => {
    const panelId = visiblePanel?.id;
    if (!panelId) {
      return;
    }

    void panelService.openDevTools(panelId).catch((error) => {
      console.error("Failed to open panel devtools", error);
    });
  }, [visiblePanel?.id]);

  const runChromeCommand = useCallback(
    (command: ChromeCommand) => {
      const panelId = visiblePanel?.id;
      if (!panelId) return;

      switch (command.type) {
        case "back":
          void view.browserGoBack(panelId);
          return;
        case "forward":
          void view.browserGoForward(panelId);
          return;
        case "reload":
          void panelService.reload(panelId);
          return;
        case "force-reload":
          void view.browserForceReload(panelId);
          return;
        case "stop":
          void view.browserStop(panelId);
          return;
        case "navigate": {
          const parsed = parseAddressInput(command.value);
          if (!parsed) return;
          if (parsed.type === "browser-url") {
            if (visiblePanel && isBrowserPanelSource(visiblePanel.snapshot.source)) {
              void view.browserNavigate(panelId, parsed.url);
            } else {
              void panelService.createBrowser(parsed.url, { focus: true })
                .then((result) => navigateToPanelId(result.id));
            }
            return;
          }
          if (parsed.type === "panel-source") {
            void panelService.createPanel(parsed.source, { isRoot: true })
              .then((result) => navigateToPanelId(result.id));
            return;
          }
          if (parsed.type === "search") {
            const query = encodeURIComponent(parsed.query);
            void panelService.createBrowser(`https://www.google.com/search?q=${query}`, { focus: true })
              .then((result) => navigateToPanelId(result.id));
          }
        }
      }
    },
    [navigateToPanelId, visiblePanel],
  );

  useEffect(() => {
    onRegisterChromeCommand?.(runChromeCommand);
  }, [onRegisterChromeCommand, runChromeCommand]);

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

  useEffect(() => {
    if (!visiblePanel) {
      onChromeStateChange?.(null);
      return;
    }

    const fallback = buildPanelChromeState({
      panel: {
        id: visiblePanel.id,
        title: visiblePanel.title,
        children: [],
        selectedChildId: visiblePanel.selectedChildId,
        snapshot: visiblePanel.snapshot,
        artifacts: visiblePanel.artifacts,
        navigation: visiblePanel.navigation,
      },
    });
    onChromeStateChange?.(fallback);

    let cancelled = false;
    void panelService.getChromeState(visiblePanel.id)
      .then((state) => {
        if (!cancelled) onChromeStateChange?.(state);
      })
      .catch(() => {
        // Fallback above is enough when git/server metadata is unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, [onChromeStateChange, visiblePanel]);

  const isTreeNavigation = navigationMode === "tree";

  // Show loading state while initializing
  if (rootLoading && rootPanels.length === 0) {
    return (
      <Flex direction="column" align="center" justify="center" style={{ flex: 1, height: "100%" }}>
        <Spinner size="3" />
        <Text mt="3">Initializing panels...</Text>
      </Flex>
    );
  }

  if (!visiblePanel && !panelLoading) {
    return (
      <Flex direction="column" align="center" justify="center" style={{ flex: 1, height: "100%" }}>
        <Text>No panels available.</Text>
      </Flex>
    );
  }

  // Helper to render panel content based on its state
  const renderPanelContent = () => {
    if (!visiblePanel) {
      return (
        <Flex direction="column" align="center" justify="center" height="100%">
          <Spinner size="3" />
          <Text mt="3">Loading panel...</Text>
        </Flex>
      );
    }

    const artifacts = visiblePanel.artifacts;

    // Error state
    if (artifacts?.error) {
      return (
        <Flex
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
      // Panel loading state (while build is in progress)
      return (
        <Flex
          direction="column"
          align="center"
          justify="center"
          height="100%"
        >
          <Spinner size="3" />
          <Text mt="3">
            {"Preparing panel..."}
          </Text>
        </Flex>
      );
    }

    // Panel is ready - WebContentsView is managed by main process
    return <Box style={{ flex: 1, position: "relative", height: "100%" }} />;
  };

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
              <LazyPanelTreeSidebar
                selectedId={visiblePanelId}
                ancestorIds={ancestorIds}
                onSelect={navigateToPanelId}
                onPanelAction={handlePanelAction}
                onArchive={handleArchive}
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
              width: 8,
              height: "100%",
              touchAction: "none",
              backgroundColor:
                isResizingSidebar || isResizeHover ? "var(--gray-8)" : "var(--gray-6)",
              transition: "background-color 120ms ease-out",
            }}
          />
        )}

        {/* Current Panel Content */}
        <Flex direction="column" flexGrow="1" gap="0" minHeight="0">
          <SavePasswordBar visiblePanelId={visiblePanelId} />
          <Card size="3" style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: 0, display: "flex", flexDirection: "column" }}>
            <Box style={{ flex: 1, minHeight: 0, position: "relative" }}>
              {renderPanelContent()}
            </Box>
          </Card>
        </Flex>
      </Flex>
    </Flex>
  );
}
