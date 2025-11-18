import { useState, useEffect } from "react";
import { PlusIcon } from "@radix-ui/react-icons";
import { Box, Button, Card, Flex, Tabs, Heading } from "@radix-ui/themes";

interface Panel {
  id: string;
  title: string;
  url: string;
  children: Panel[];
  selectedChildId: string | null;
}

interface PanelStackProps {
  onTitleChange?: (title: string) => void;
}

const generateRandomUrl = (): string => {
  const urls = [
    "https://www.wikipedia.org",
    "https://www.github.com",
    "https://news.ycombinator.com",
    "https://www.reddit.com",
    "https://www.stackoverflow.com",
  ];
  return urls[Math.floor(Math.random() * urls.length)] || "https://www.google.com";
};

export function PanelStack({ onTitleChange }: PanelStackProps) {
  const [rootPanels, setRootPanels] = useState<Panel[]>([
    {
      id: "root-1",
      title: "Browser 1",
      url: generateRandomUrl(),
      children: [],
      selectedChildId: null,
    },
  ]);
  const [selectedRootId, setSelectedRootId] = useState<string>("root-1");
  const [visiblePanelPath, setVisiblePanelPath] = useState<string[]>(["root-1"]);
  const [nextChildCounter, setNextChildCounter] = useState(2);

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

  // Add a child to a specific panel
  const addChild = (path: string[]) => {
    const newChild: Panel = {
      id: `panel-${Date.now()}-${Math.random()}`,
      title: `Browser ${nextChildCounter}`,
      url: generateRandomUrl(),
      children: [],
      selectedChildId: null,
    };
    setNextChildCounter(nextChildCounter + 1);

    const updatePanelTree = (
      panels: Panel[],
      currentPath: string[],
      depth: number = 0
    ): Panel[] => {
      if (depth >= currentPath.length) return panels;

      return panels.map((panel) => {
        if (panel.id === currentPath[depth]) {
          if (depth === currentPath.length - 1) {
            // This is the target panel
            return {
              ...panel,
              children: [...panel.children, newChild],
              selectedChildId: newChild.id,
            };
          } else {
            // Keep traversing
            return {
              ...panel,
              children: updatePanelTree(panel.children, currentPath, depth + 1),
            };
          }
        }
        return panel;
      });
    };

    setRootPanels(updatePanelTree(rootPanels, path));
    setVisiblePanelPath([...path, newChild.id]);
  };

  // Navigate to a specific panel in the tree
  const navigateToPanel = (path: string[]) => {
    setVisiblePanelPath(path);
    if (path.length > 0 && path[0] !== undefined) {
      setSelectedRootId(path[0]);
    }

    // Update selected children along the path
    const updateSelections = (
      panels: Panel[],
      currentPath: string[],
      depth: number = 0
    ): Panel[] => {
      if (depth >= currentPath.length - 1) return panels;

      return panels.map((panel) => {
        if (panel.id === currentPath[depth]) {
          const nextId = currentPath[depth + 1];
          return {
            ...panel,
            selectedChildId: nextId !== undefined ? nextId : null,
            children: updateSelections(panel.children, currentPath, depth + 1),
          };
        }
        return panel;
      });
    };

    setRootPanels(updateSelections(rootPanels, path));
  };

  // Suppress unused variable warning - selectedRootId is used for state management
  void selectedRootId;

  // Notify parent of title changes
  useEffect(() => {
    if (onTitleChange && visiblePanel) {
      onTitleChange(visiblePanel.title);
    }
  }, [onTitleChange, visiblePanel]);

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
                  <webview
                    src={visiblePanel.url}
                    style={{
                      width: "100%",
                      height: "100%",
                    }}
                  />
                </Box>

                {/* Add Child Button */}
                <Box p="3" style={{ borderTop: "1px solid var(--gray-6)" }}>
                  <Button size="3" onClick={() => addChild(visiblePanelPath)}>
                    <PlusIcon />
                    Add Child Browser
                  </Button>
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
