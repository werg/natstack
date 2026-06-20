/**
 * New Panel Page - Shell panel for launching panels from workspace.
 * Opens with Cmd/Ctrl+T and displays available panels with a chat prompt input.
 */
import { useEffect, useState, useCallback, useMemo } from "react";
import { Card, Flex, Heading, Text, Box, Button, TextField, Spinner } from "@radix-ui/themes";
import {
  PlusIcon,
  MagnifyingGlassIcon,
  ChatBubbleIcon,
  PaperPlaneIcon,
  ChevronRightIcon,
} from "@radix-ui/react-icons";
import { buildPanelLink, panel, workspace } from "@workspace/runtime";
import { useIsMobile } from "@workspace/react";
import { mountAboutPanel, AboutPage, Section } from "@workspace/about-shared/ui";
import type { WorkspaceTree, WorkspaceNode } from "@workspace/runtime";

/** Flatten a workspace tree into a list of visible launchable panels. */
function collectPanels(nodes: WorkspaceNode[]): WorkspaceNode[] {
  const result: WorkspaceNode[] = [];
  for (const node of nodes) {
    if (
      node.launchable &&
      !node.launchable.hidden &&
      (node.path.startsWith("panels/") || node.path.startsWith("about/"))
    )
      result.push(node);
    result.push(...collectPanels(node.children));
  }
  return result;
}

function PanelCard({ node }: { node: WorkspaceNode }) {
  const isMobile = useIsMobile();
  return (
    <Card asChild>
      <a href={buildPanelLink(node.path)} style={{ textDecoration: "none", color: "inherit" }}>
        <Flex align="center" justify="between" gap="3">
          <Flex
            align={isMobile ? "start" : "center"}
            direction={isMobile ? "column" : "row"}
            gap={isMobile ? "0" : "3"}
            style={{ minWidth: 0 }}
          >
            <Text weight="medium" size="2">
              {node.launchable?.title ?? node.name}
            </Text>
            <Text size="1" color="gray" style={{ wordBreak: "break-all" }}>
              {node.path}
            </Text>
          </Flex>
          <ChevronRightIcon style={{ flexShrink: 0, color: "var(--gray-8)" }} />
        </Flex>
      </a>
    </Card>
  );
}

function NewPanelPage() {
  const isMobile = useIsMobile();
  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [promptInput, setPromptInput] = useState("");
  const [filter, setFilter] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      setTree(await workspace.sourceTree());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
    return panel.onFocus(() => void fetchData());
  }, [fetchData]);

  const handleNewChat = useCallback(() => {
    const prompt = promptInput.trim();
    if (!prompt) return;
    window.location.href = buildPanelLink("panels/chat", {
      stateArgs: { initialPrompt: prompt },
    });
  }, [promptInput]);

  const panels = useMemo(() => (tree ? collectPanels(tree.children) : []), [tree]);

  const filteredPanels = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return panels;
    return panels.filter(
      (node) =>
        node.path.toLowerCase().includes(query) ||
        (node.launchable?.title ?? node.name).toLowerCase().includes(query)
    );
  }, [panels, filter]);

  return (
    <AboutPage icon={<PlusIcon width={20} height={20} />} title="New Panel" maxWidth={640}>
      {/* New chat hero */}
      <Section>
        <Flex align="center" gap="2" mb="3">
          <ChatBubbleIcon style={{ color: "var(--accent-9)" }} />
          <Heading size="3">Start a chat</Heading>
        </Flex>
        <Flex gap="2" direction={isMobile ? "column" : "row"}>
          <TextField.Root
            autoFocus
            size="3"
            style={{ flex: 1 }}
            placeholder="Ask anything to open a new chat..."
            value={promptInput}
            onChange={(e) => setPromptInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleNewChat()}
          />
          <Button size="3" onClick={handleNewChat} disabled={!promptInput.trim()}>
            <PaperPlaneIcon /> Chat
          </Button>
        </Flex>
      </Section>

      {/* Panel list */}
      {loading ? (
        <Flex align="center" justify="center" gap="2" py="6">
          <Spinner />
          <Text color="gray">Loading panels...</Text>
        </Flex>
      ) : error ? (
        <Section>
          <Flex direction="column" gap="3" align="start">
            <Text color="red" size="2">
              Failed to load workspace panels: {error}
            </Text>
            <Button variant="soft" onClick={() => void fetchData()}>
              Retry
            </Button>
          </Flex>
        </Section>
      ) : (
        <Box>
          <Flex align="center" justify="between" gap="3" mb="3">
            <Heading size="3">Panels</Heading>
            <TextField.Root
              size="2"
              style={{ width: isMobile ? "50%" : 220 }}
              placeholder="Filter..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <TextField.Slot>
                <MagnifyingGlassIcon />
              </TextField.Slot>
            </TextField.Root>
          </Flex>

          {filteredPanels.length > 0 ? (
            <Flex direction="column" gap="2">
              {filteredPanels.map((node) => (
                <PanelCard key={node.path} node={node} />
              ))}
            </Flex>
          ) : (
            <Text color="gray" size="2">
              {panels.length === 0 ? "No panels found in workspace" : `No panels match "${filter}"`}
            </Text>
          )}
        </Box>
      )}
    </AboutPage>
  );
}

mountAboutPanel(NewPanelPage);
