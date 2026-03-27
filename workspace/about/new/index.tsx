/**
 * New Panel Page - Shell panel for launching panels from workspace.
 * Opens with Cmd/Ctrl+T and displays available panels with a chat prompt input.
 */

import { createRoot } from "react-dom/client";
import { useEffect, useState, useCallback } from "react";
import "@radix-ui/themes/styles.css";
import {
  Theme,
  Card,
  Flex,
  Heading,
  Text,
  Box,
  Button,
  TextField,
  ScrollArea,
} from "@radix-ui/themes";
import { getWorkspaceTree, buildPanelLink, onFocus } from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";
import type { WorkspaceTree, WorkspaceNode } from "@workspace/runtime";

/** Flatten a workspace tree into a list of visible launchable panels. */
function collectPanels(nodes: WorkspaceNode[]): WorkspaceNode[] {
  const result: WorkspaceNode[] = [];
  for (const node of nodes) {
    if (node.launchable && !node.launchable.hidden && (node.path.startsWith("panels/") || node.path.startsWith("about/")))
      result.push(node);
    result.push(...collectPanels(node.children));
  }
  return result;
}

function NewPanelPage() {
  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [promptInput, setPromptInput] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      setTree(await getWorkspaceTree());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
    return onFocus(() => void fetchData());
  }, [fetchData]);

  const handleLaunch = useCallback((node: WorkspaceNode) => {
    window.location.href = buildPanelLink(node.path);
  }, []);

  const handleNewChat = useCallback(() => {
    const prompt = promptInput.trim();
    if (!prompt) return;
    const url = buildPanelLink("panels/chat", {
      stateArgs: { initialPrompt: prompt },
    });
    window.location.href = url + (url.includes("?") ? "&" : "?") + "_fresh";
  }, [promptInput]);

  if (loading) {
    return (
      <Box p="4" style={{ maxWidth: "700px", margin: "0 auto" }}>
        <Heading size="7" mb="4">New Panel</Heading>
        <Text color="gray">Loading...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box p="4" style={{ maxWidth: "700px", margin: "0 auto" }}>
        <Heading size="7" mb="4">New Panel</Heading>
        <Card>
          <Text color="red">Error: {error}</Text>
        </Card>
      </Box>
    );
  }

  const panels = tree ? collectPanels(tree.children) : [];

  return (
    <Box p="4" style={{ maxWidth: "700px", margin: "0 auto" }}>
      <Heading size="7" mb="4">New Panel</Heading>

      <ScrollArea style={{ height: "calc(100dvh - 100px)" }}>
        <Flex direction="column" gap="4">
          {/* Chat prompt input */}
          <Card>
            <Heading size="3" mb="2">New Chat</Heading>
            <Flex gap="2">
              <TextField.Root
                style={{ flex: 1 }}
                placeholder="Start a chat with a prompt..."
                value={promptInput}
                onChange={(e) => setPromptInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleNewChat()}
              />
              <Button onClick={handleNewChat} disabled={!promptInput.trim()}>
                Chat
              </Button>
            </Flex>
          </Card>

          {/* Panel list */}
          {panels.length > 0 ? (
            <Flex direction="column" gap="2">
              {panels.map((node) => (
                <Card
                  key={node.path}
                  tabIndex={0}
                  style={{ cursor: "pointer" }}
                  onClick={() => handleLaunch(node)}
                  onKeyDown={(e) => e.key === "Enter" && handleLaunch(node)}
                >
                  <Flex align="center" justify="between">
                    <Text weight="medium">{node.launchable?.title ?? node.name}</Text>
                    <Text size="1" color="gray">{node.path}</Text>
                  </Flex>
                </Card>
              ))}
            </Flex>
          ) : (
            <Text color="gray">No panels found in workspace</Text>
          )}
        </Flex>
      </ScrollArea>
    </Box>
  );
}

function ThemedApp() {
  const theme = usePanelTheme();
  return (
    <Theme appearance={theme} radius="medium">
      <NewPanelPage />
    </Theme>
  );
}

// Mount the app
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<ThemedApp />);
}
