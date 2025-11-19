import { useState, useEffect, useRef, useCallback } from "react";
import { Box, Button, Card, Flex, Tabs, Heading, Spinner, Text } from "@radix-ui/themes";

interface PanelStackProps {
  onTitleChange?: (title: string) => void;
  hostTheme: "light" | "dark";
  onRegisterDevToolsHandler?: (handler: () => void) => void;
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

export function PanelStack({ onTitleChange, hostTheme, onRegisterDevToolsHandler }: PanelStackProps) {
  const [rootPanels, setRootPanels] = useState<Panel[]>([]);
  const [visiblePanelPath, setVisiblePanelPath] = useState<string[]>([]);
  const [isTreeReady, setIsTreeReady] = useState(false);
  const [panelPreloadPath, setPanelPreloadPath] = useState<string | null>(null);
  const [hostThemeCss, setHostThemeCss] = useState<string | null>(null);
  const webviewRefs = useRef<Map<string, Electron.WebviewTag>>(new Map());
  const panelThemeCssKeys = useRef<Map<string, string>>(new Map());
  const domReadyPanels = useRef<Set<string>>(new Set());

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
      void webview
        .insertCSS(hostThemeCss)
        .then((key) => {
          panelThemeCssKeys.current.set(panelId, key);
        })
        .catch((error) => {
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

  const findPanelByPathInTree = (tree: Panel[], path: string[]): Panel | null => {
    if (path.length === 0) return null;

    let current: Panel | undefined = tree.find((p) => p.id === path[0]);
    if (!current) return null;

    for (let i = 1; i < path.length; i++) {
      current = current.children.find((c) => c.id === path[i]);
      if (!current) return null;
    }

    return current;
  };

  // Get the panel at a specific path using current state
  const getPanelByPath = (path: string[]): Panel | null => {
    return findPanelByPathInTree(rootPanels, path);
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
  const navigateToPanel = (path: string[]) => {
    setVisiblePanelPath(path);
  };

  // Initialize webview with panel ID when it loads
  const handleWebviewReady = (panelId: string, webview: HTMLElement) => {
    const webviewTag = webview as unknown as Electron.WebviewTag;
    webviewRefs.current.set(panelId, webviewTag);

    webviewTag.addEventListener("dom-ready", () => {
      domReadyPanels.current.add(panelId);
      applyThemeCss(panelId, webviewTag);
    });

    webviewTag.addEventListener("destroyed", () => {
      domReadyPanels.current.delete(panelId);
      panelThemeCssKeys.current.delete(panelId);
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

  // Show loading state while initializing
  if (!isTreeReady || !panelPreloadPath) {
    return (
      <Box p="4" style={{ height: "calc(100vh - 32px)" }}>
        <Flex direction="column" align="center" justify="center" height="100%">
          <Spinner size="3" />
          <Text mt="3">Initializing panels...</Text>
        </Flex>
      </Box>
    );
  }

  if (!visiblePanel) {
    return (
      <Box p="4" style={{ height: "calc(100vh - 32px)" }}>
        <Flex direction="column" align="center" justify="center" height="100%">
          <Text>No panels available.</Text>
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

                    if (artifacts?.htmlPath) {
                      const normalizedPath = artifacts.htmlPath.replace(/\\/g, "/");
                      const srcUrl = new URL(`file://${normalizedPath}`);
                      srcUrl.searchParams.set("panelId", panel.id);
                      return (
                        <webview
                          key={panel.id}
                          ref={(el) => {
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
