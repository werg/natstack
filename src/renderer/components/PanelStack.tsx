import { useState, useEffect, useRef } from "react";
import { Box, Button, Card, Flex, Tabs, Heading, Spinner, Text } from "@radix-ui/themes";

interface Panel {
  id: string;
  title: string;
  path: string;
  children: Panel[];
  selectedChildId: string | null;
}

interface PanelStackProps {
  onTitleChange?: (title: string) => void;
}

interface PanelLoadState {
  loading: boolean;
  error?: string;
  htmlPath?: string;
}

export function PanelStack({ onTitleChange }: PanelStackProps) {
  const [rootPanels, setRootPanels] = useState<Panel[]>([]);
  const [visiblePanelPath, setVisiblePanelPath] = useState<string[]>([]);
  const [panelLoadStates, setPanelLoadStates] = useState<Map<string, PanelLoadState>>(new Map());
  const [isInitializing, setIsInitializing] = useState(true);
  const [panelPreloadPath, setPanelPreloadPath] = useState<string | null>(null);
  const webviewRefs = useRef<Map<string, Electron.WebviewTag>>(new Map());
  const panelLoadStatesRef = useRef(panelLoadStates);

  useEffect(() => {
    panelLoadStatesRef.current = panelLoadStates;
  }, [panelLoadStates]);

  // Initialize root panel on mount
  useEffect(() => {
    const initRootPanel = async () => {
      try {
        const rootPanel = await window.electronAPI.initRootPanel("panels/example");
        setRootPanels([rootPanel]);
        setVisiblePanelPath([rootPanel.id]);

        // Build root panel
        await buildAndLoadPanel(rootPanel);
      } catch (error) {
        console.error("Failed to initialize root panel:", error);
      } finally {
        setIsInitializing(false);
      }
    };

    void initRootPanel();

    // Listen for panel tree updates from main process
    const cleanup = window.electronAPI.onPanelTreeUpdated((updatedRootPanels) => {
      setRootPanels(updatedRootPanels);

      const allPanels = flattenPanels(updatedRootPanels);
      const panelsToBuild = allPanels.filter((panel) => !panelLoadStatesRef.current.has(panel.id));

      setPanelLoadStates((prevStates) => {
        const nextStates = new Map(prevStates);
        const validIds = new Set(allPanels.map((panel) => panel.id));

        for (const id of Array.from(nextStates.keys())) {
          if (!validIds.has(id)) {
            nextStates.delete(id);
          }
        }

        for (const panel of panelsToBuild) {
          nextStates.set(panel.id, { loading: true });
        }

        return nextStates;
      });

      for (const panel of panelsToBuild) {
        void buildAndLoadPanel(panel);
      }
    });

    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Build and load a panel
  const buildAndLoadPanel = async (panel: Panel) => {
    setPanelLoadStates((prev) => new Map(prev).set(panel.id, { loading: true }));

    try {
      const result = await window.electronAPI.buildPanel(panel.path);

      if (result.success && result.htmlPath) {
        setPanelLoadStates((prev) =>
          new Map(prev).set(panel.id, {
            loading: false,
            htmlPath: result.htmlPath,
          })
        );
      } else {
        setPanelLoadStates((prev) =>
          new Map(prev).set(panel.id, { loading: false, error: result.error || "Unknown error" })
        );
      }
    } catch (error) {
      setPanelLoadStates((prev) =>
        new Map(prev).set(panel.id, {
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  };

  // Get the panel at a specific path
  const getPanelByPath = (path: string[]): Panel | null => {
    if (path.length === 0) return null;

    let current = rootPanels.find((p) => p.id === path[0]);
    if (!current) return null;

    for (let i = 1; i < path.length; i++) {
      current = current.children.find((c) => c.id === path[i]);
      if (!current) return null;
    }

    return current;
  };

  // Get the currently visible panel
  const visiblePanel = getPanelByPath(visiblePanelPath);

  // Get the path to the visible panel with all panels
  const getFullPath = (): Panel[] => {
    const path: Panel[] = [];
    for (let i = 0; i < visiblePanelPath.length; i++) {
      const panel = getPanelByPath(visiblePanelPath.slice(0, i + 1));
      if (panel) path.push(panel);
    }
    return path;
  };

  const fullPath = getFullPath();

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

  // Navigate to a specific panel in the tree
  const navigateToPanel = (path: string[]) => {
    setVisiblePanelPath(path);
  };

  // Initialize webview with panel ID when it loads
  const handleWebviewReady = (panelId: string, webview: HTMLElement) => {
    const webviewTag = webview as unknown as Electron.WebviewTag;
    webviewRefs.current.set(panelId, webviewTag);

    // Forward console messages from webview to main DevTools
    webviewTag.addEventListener("console-message", (e: any) => {
      const prefix = `[Panel ${panelId}]`;
      if (e.level === 0) {
        console.log(prefix, e.message);
      } else if (e.level === 1) {
        console.warn(prefix, e.message);
      } else if (e.level === 2) {
        console.error(prefix, e.message);
      }
    });

  };

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

  // Notify parent of title changes
  useEffect(() => {
    if (onTitleChange && visiblePanel) {
      onTitleChange(visiblePanel.title);
    }
  }, [onTitleChange, visiblePanel]);

  // Show loading state while initializing
  if (isInitializing || !panelPreloadPath) {
    return (
      <Box p="4" style={{ height: "calc(100vh - 32px)" }}>
        <Flex direction="column" align="center" justify="center" height="100%">
          <Spinner size="3" />
          <Text mt="3">Initializing panels...</Text>
        </Flex>
      </Box>
    );
  }

  return (
    <Box p="4" style={{ height: "calc(100vh - 32px)" }}>
      <Flex direction="column" gap="3" height="100%">
        {/* Ancestor Breadcrumbs */}
        {fullPath.length > 1 && (
          <Flex wrap="wrap" gap="2" align="center">
            {fullPath.slice(0, -1).map((panel, index) => {
              const path = visiblePanelPath.slice(0, index + 1);
              const parent = index > 0 ? getPanelByPath(visiblePanelPath.slice(0, index)) : null;
              const siblings = index === 0 ? rootPanels : parent?.children || [];

              if (siblings.length > 1) {
                return (
                  <Tabs.Root
                    key={panel.id}
                    value={panel.id}
                    onValueChange={(value) =>
                      navigateToPanel([...visiblePanelPath.slice(0, index), value])
                    }
                  >
                    <Tabs.List size="1">
                      {siblings.map((sibling) => (
                        <Tabs.Trigger key={sibling.id} value={sibling.id}>
                          {sibling.title}
                        </Tabs.Trigger>
                      ))}
                    </Tabs.List>
                  </Tabs.Root>
                );
              }

              return (
                <Button
                  key={panel.id}
                  variant="soft"
                  size="1"
                  onClick={() => navigateToPanel(path)}
                >
                  {panel.title}
                </Button>
              );
            })}
          </Flex>
        )}

        {/* Current Panel with Tab Siblings */}
        {visiblePanel && (
          <Flex direction="column" flexGrow="1" gap="0">
            {/* Current Panel Title Tabs */}
            {(() => {
              const parentPath = visiblePanelPath.slice(0, -1);
              const parent = parentPath.length > 0 ? getPanelByPath(parentPath) : null;
              const siblings = parentPath.length === 0 ? rootPanels : parent?.children || [];

              return siblings.length > 1 ? (
                <Tabs.Root
                  value={visiblePanel.id}
                  onValueChange={(value) => navigateToPanel([...parentPath, value])}
                >
                  <Tabs.List size="2">
                    {siblings.map((sibling) => (
                      <Tabs.Trigger key={sibling.id} value={sibling.id}>
                        {sibling.title}
                      </Tabs.Trigger>
                    ))}
                  </Tabs.List>
                </Tabs.Root>
              ) : (
                <Box pb="2">
                  <Heading size="5" weight="bold">
                    {visiblePanel.title}
                  </Heading>
                </Box>
              );
            })()}

            {/* Panel Content */}
            <Card size="3" style={{ flexGrow: 1, overflow: "hidden", padding: 0 }}>
              <Flex direction="column" gap="0" height="100%">
                <Box style={{ flexGrow: 1, position: "relative" }}>
                  {/* Render all webviews, show only the visible one */}
                  {allPanels.map((panel) => {
                    const loadState = panelLoadStates.get(panel.id);
                    const isVisible = panel.id === visiblePanel.id;

                    // Show loading or error state for visible panel
                    if (isVisible && loadState) {
                      if (loadState.loading) {
                        return (
                          <Flex
                            key={panel.id}
                            direction="column"
                            align="center"
                            justify="center"
                            height="100%"
                          >
                            <Spinner size="3" />
                            <Text mt="3">Building panel...</Text>
                          </Flex>
                        );
                      }

                      if (loadState.error) {
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
                              {loadState.error}
                            </Text>
                          </Flex>
                        );
                      }
                    }

                    // Render webview if loaded
                    if (loadState?.htmlPath) {
                      const normalizedPath = loadState.htmlPath.replace(/\\/g, "/");
                      const srcUrl = new URL(`file://${normalizedPath}`);
                      srcUrl.searchParams.set("panelId", panel.id);
                      return (
                        <webview
                          key={panel.id}
                          ref={(el) => {
                            if (el) handleWebviewReady(panel.id, el);
                          }}
                          src={srcUrl.toString()}
                          preload={panelPreloadPath}
                          partition={`persist:panel-${panel.id}`}
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

        {/* Descendant Breadcrumbs */}
        {visiblePanel && visiblePanel.children.length > 0 && (
          <Flex wrap="wrap" gap="2" align="center">
            {(() => {
              // Build the descendant path by following selectedChildId
              const descendantPath: Panel[] = [];
              let currentPanel: Panel | null = visiblePanel;

              while (currentPanel && currentPanel.children.length > 0) {
                descendantPath.push(currentPanel);
                if (currentPanel.selectedChildId) {
                  currentPanel =
                    currentPanel.children.find((c) => c.id === currentPanel!.selectedChildId) ||
                    null;
                } else {
                  currentPanel = null;
                }
              }

              return descendantPath.map((parentPanel, index) => {
                const pathToParent = [...visiblePanelPath];
                for (let i = 0; i < index; i++) {
                  const p = descendantPath[i];
                  if (p && p.selectedChildId) {
                    pathToParent.push(p.selectedChildId);
                  }
                }

                if (parentPanel.children.length > 1) {
                  return (
                    <Tabs.Root
                      key={parentPanel.id}
                      value={parentPanel.selectedChildId || ""}
                      onValueChange={(value) => navigateToPanel([...pathToParent, value])}
                    >
                      <Tabs.List size="1">
                        {parentPanel.children.map((child) => (
                          <Tabs.Trigger key={child.id} value={child.id}>
                            {child.title}
                          </Tabs.Trigger>
                        ))}
                      </Tabs.List>
                    </Tabs.Root>
                  );
                }

                return parentPanel.children.map((child) => (
                  <Button
                    key={child.id}
                    variant="soft"
                    size="1"
                    onClick={() => navigateToPanel([...pathToParent, child.id])}
                  >
                    {child.title}
                  </Button>
                ));
              });
            })()}
          </Flex>
        )}
      </Flex>
    </Box>
  );
}
