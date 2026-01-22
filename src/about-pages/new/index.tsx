/**
 * New Panel Page - Shell panel for launching panels from workspace.
 * Opens with Cmd/Ctrl+T and displays available panels, workers, and repos.
 */

import { createRoot } from "react-dom/client";
import { useEffect, useState, useMemo, useCallback } from "react";
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
  Badge,
  ScrollArea,
  Separator,
  Tabs,
} from "@radix-ui/themes";
import { getWorkspaceTree, buildNsLink, buildAboutLink } from "@natstack/runtime";
import { usePanelTheme } from "@natstack/react";
import type { WorkspaceTree, WorkspaceNode, EnvArgSchema } from "@natstack/runtime";
import { WorkspaceTreeView } from "./WorkspaceTreeView";
import { RepoSelector } from "./RepoSelector";

// Shell pages to display in the page
const SHELL_PAGES = [
  { page: "model-provider-config" as const, label: "Model Provider Config", description: "Configure AI model providers" },
  { page: "keyboard-shortcuts" as const, label: "Keyboard Shortcuts", description: "View keyboard shortcuts" },
  { page: "about" as const, label: "About NatStack", description: "Application information" },
  { page: "help" as const, label: "Help", description: "Documentation and help" },
];

interface LaunchFormProps {
  node: WorkspaceNode;
  onLaunch: (node: WorkspaceNode, repoArgs: Record<string, string>, envArgs: Record<string, string>) => void;
}

function LaunchForm({ node, onLaunch }: LaunchFormProps) {
  const [repoArgValues, setRepoArgValues] = useState<Record<string, string>>({});
  const [envArgValues, setEnvArgValues] = useState<Record<string, string>>({});

  const hasRepoArgs = (node.launchable?.repoArgs?.length ?? 0) > 0;
  const hasEnvArgs = (node.launchable?.envArgs?.length ?? 0) > 0;

  const canLaunch = useMemo(() => {
    // Check all repoArgs are provided (all required)
    const repoArgs = node.launchable?.repoArgs ?? [];
    const repoOk = repoArgs.every((name) => repoArgValues[name]);

    // Check required envArgs are provided (or have defaults)
    const envArgs = node.launchable?.envArgs ?? [];
    const envOk = envArgs
      .filter((e) => e.required !== false)
      .every((e) => envArgValues[e.name] || e.default);

    return repoOk && envOk;
  }, [node, repoArgValues, envArgValues]);

  const handleLaunch = useCallback(() => {
    // Merge defaults with provided values for envArgs
    const envArgs = node.launchable?.envArgs ?? [];
    const mergedEnv: Record<string, string> = {};
    for (const arg of envArgs) {
      const value = envArgValues[arg.name] ?? arg.default;
      if (value !== undefined) {
        mergedEnv[arg.name] = value;
      }
    }
    onLaunch(node, repoArgValues, mergedEnv);
  }, [node, repoArgValues, envArgValues, onLaunch]);

  // If no args required, show launch button
  if (!hasRepoArgs && !hasEnvArgs) {
    return (
      <Flex mt="2">
        <Button size="1" onClick={handleLaunch}>
          Launch
        </Button>
      </Flex>
    );
  }

  return (
    <Card mt="2">
      <Flex direction="column" gap="3">
        {hasRepoArgs && (
          <Box>
            <Text size="2" weight="medium" mb="2" as="div">
              Repository Arguments
            </Text>
            {node.launchable?.repoArgs?.map((argName) => (
              <Box key={argName} mb="2">
                <Text size="1" color="gray" mb="1" as="div">
                  {argName} (required)
                </Text>
                <RepoSelector
                  value={repoArgValues[argName] ?? ""}
                  onChange={(value) =>
                    setRepoArgValues((prev) => ({
                      ...prev,
                      [argName]: value,
                    }))
                  }
                  placeholder={`Select repo for ${argName}...`}
                />
              </Box>
            ))}
          </Box>
        )}

        {hasEnvArgs && (
          <Box>
            <Text size="2" weight="medium" mb="2" as="div">
              Environment Variables
            </Text>
            {node.launchable?.envArgs?.map((arg: EnvArgSchema) => (
              <Box key={arg.name} mb="2">
                <Text size="1" color="gray" mb="1" as="div">
                  {arg.name}
                  {arg.required === false ? " (optional)" : " (required)"}
                  {arg.description && ` - ${arg.description}`}
                </Text>
                <TextField.Root
                  size="1"
                  placeholder={arg.default ?? ""}
                  value={envArgValues[arg.name] ?? ""}
                  onChange={(e) =>
                    setEnvArgValues((prev) => ({
                      ...prev,
                      [arg.name]: e.target.value,
                    }))
                  }
                />
              </Box>
            ))}
          </Box>
        )}

        <Flex justify="end">
          <Button size="1" disabled={!canLaunch} onClick={handleLaunch}>
            Launch
          </Button>
        </Flex>
      </Flex>
    </Card>
  );
}

function NewPanelPage() {
  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined);

  useEffect(() => {
    setLoading(true);
    getWorkspaceTree()
      .then(setTree)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  const handleLaunch = useCallback(
    (
      node: WorkspaceNode,
      repoArgs: Record<string, string>,
      env: Record<string, string>
    ) => {
      const hasRepoArgs = Object.keys(repoArgs).length > 0;
      const hasEnv = Object.keys(env).length > 0;

      const url = buildNsLink(node.path, {
        repoArgs: hasRepoArgs ? repoArgs : undefined,
        env: hasEnv ? env : undefined,
      });

      window.location.href = url;
    },
    []
  );

  const handleNodeSelect = useCallback((node: WorkspaceNode) => {
    setSelectedPath(node.path);
  }, []);

  const handleSimpleLaunch = useCallback((node: WorkspaceNode) => {
    // For items without args, launch directly
    const hasArgs =
      (node.launchable?.repoArgs?.length ?? 0) > 0 ||
      (node.launchable?.envArgs?.length ?? 0) > 0;

    if (!hasArgs && node.launchable) {
      const url = buildNsLink(node.path);
      window.location.href = url;
    } else {
      setSelectedPath(node.path);
    }
  }, []);

  const handleUrlNavigate = useCallback(() => {
    if (urlInput.trim()) {
      window.location.href = urlInput.trim();
    }
  }, [urlInput]);

  const handleShellPageClick = useCallback((page: string) => {
    window.location.href = buildAboutLink(page as "model-provider-config" | "about" | "keyboard-shortcuts" | "help");
  }, []);

  const renderNodeExtra = useCallback(
    (node: WorkspaceNode) => {
      if (!node.launchable) return null;
      return <LaunchForm node={node} onLaunch={handleLaunch} />;
    },
    [handleLaunch]
  );

  if (loading) {
    return (
      <Box p="4" style={{ maxWidth: "700px", margin: "0 auto" }}>
        <Heading size="7" mb="4">
          New Panel
        </Heading>
        <Text color="gray">Loading projects...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box p="4" style={{ maxWidth: "700px", margin: "0 auto" }}>
        <Heading size="7" mb="4">
          New Panel
        </Heading>
        <Card>
          <Text color="red">Error loading projects: {error}</Text>
        </Card>
      </Box>
    );
  }

  // Count items for tabs
  const countLaunchable = (nodes: WorkspaceNode[], type?: "app" | "worker"): number => {
    let count = 0;
    for (const node of nodes) {
      if (node.launchable && (!type || node.launchable.type === type)) {
        count++;
      }
      count += countLaunchable(node.children, type);
    }
    return count;
  };

  const countRepos = (nodes: WorkspaceNode[]): number => {
    let count = 0;
    for (const node of nodes) {
      if (node.isGitRepo && !node.launchable) {
        count++;
      }
      count += countRepos(node.children);
    }
    return count;
  };

  const appCount = tree ? countLaunchable(tree.children, "app") : 0;
  const workerCount = tree ? countLaunchable(tree.children, "worker") : 0;
  const repoCount = tree ? countRepos(tree.children) : 0;

  return (
    <Box p="4" style={{ maxWidth: "700px", margin: "0 auto" }}>
      <Heading size="7" mb="4">
        New Panel
      </Heading>

      <ScrollArea style={{ height: "calc(100vh - 100px)" }}>
        <Flex direction="column" gap="4">
          {/* URL Input */}
          <Card>
            <Heading size="3" mb="2">
              Open URL
            </Heading>
            <Flex gap="2">
              <TextField.Root
                style={{ flex: 1 }}
                placeholder="Enter URL or ns:// path..."
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleUrlNavigate()}
              />
              <Button onClick={handleUrlNavigate} disabled={!urlInput.trim()}>
                Go
              </Button>
            </Flex>
          </Card>

          {/* Tabs for different project types */}
          <Tabs.Root defaultValue="panels">
            <Tabs.List>
              <Tabs.Trigger value="panels">Apps ({appCount})</Tabs.Trigger>
              <Tabs.Trigger value="workers">Workers ({workerCount})</Tabs.Trigger>
              <Tabs.Trigger value="repos">Repos ({repoCount})</Tabs.Trigger>
              <Tabs.Trigger value="shell">Shell Pages</Tabs.Trigger>
            </Tabs.List>

            <Box pt="3">
              <Tabs.Content value="panels">
                {tree && appCount > 0 ? (
                  <Card>
                    <WorkspaceTreeView
                      tree={tree}
                      filter="launchable"
                      launchableType="app"
                      onSelect={handleSimpleLaunch}
                      selectedPath={selectedPath}
                      renderNodeExtra={renderNodeExtra}
                    />
                  </Card>
                ) : (
                  <Text color="gray">No app panels found in workspace</Text>
                )}
              </Tabs.Content>

              <Tabs.Content value="workers">
                {tree && workerCount > 0 ? (
                  <Card>
                    <WorkspaceTreeView
                      tree={tree}
                      filter="launchable"
                      launchableType="worker"
                      onSelect={handleSimpleLaunch}
                      selectedPath={selectedPath}
                      renderNodeExtra={renderNodeExtra}
                    />
                  </Card>
                ) : (
                  <Text color="gray">No workers found in workspace</Text>
                )}
              </Tabs.Content>

              <Tabs.Content value="repos">
                {tree && repoCount > 0 ? (
                  <Card>
                    <WorkspaceTreeView
                      tree={tree}
                      filter="repos"
                      onSelect={handleNodeSelect}
                      selectedPath={selectedPath}
                    />
                  </Card>
                ) : (
                  <Text color="gray">No other repos found in workspace</Text>
                )}
              </Tabs.Content>

              <Tabs.Content value="shell">
                {SHELL_PAGES.map((page) => (
                  <Card
                    key={page.page}
                    style={{ marginBottom: "8px", cursor: "pointer" }}
                    onClick={() => handleShellPageClick(page.page)}
                  >
                    <Flex direction="column" gap="1">
                      <Text weight="medium">{page.label}</Text>
                      <Text size="1" color="gray">
                        {page.description}
                      </Text>
                    </Flex>
                  </Card>
                ))}
              </Tabs.Content>
            </Box>
          </Tabs.Root>
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
