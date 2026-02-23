/**
 * Configuration for managed workspace mode.
 * - Select or create a project repository
 */

import { useState, useEffect, useMemo } from "react";
import {
  Box,
  Text,
  Flex,
  Card,
  Spinner,
  RadioGroup,
  Callout,
  Button,
  TextField,
  ScrollArea,
  Separator,
  Badge,
} from "@radix-ui/themes";
import {
  InfoCircledIcon,
  PlusIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MagnifyingGlassIcon,
  CubeIcon,
} from "@radix-ui/react-icons";
import { rpc } from "@workspace/runtime";
import type { WorkspaceNode, WorkspaceTree } from "@workspace/runtime";

/** Directories that can contain project repos */
const PROJECT_DIRECTORIES = ["contexts", "panels", "workers", "projects"];

/** Find all git repos in known project directories */
function findProjectRepos(nodes: WorkspaceNode[], parentPath = ""): WorkspaceNode[] {
  const repos: WorkspaceNode[] = [];
  for (const node of nodes) {
    const nodePath = parentPath ? `${parentPath}/${node.name}` : node.name;
    const topDir = nodePath.split("/")[0] ?? "";
    if (PROJECT_DIRECTORIES.includes(topDir) && node.isGitRepo) {
      repos.push({ ...node, path: nodePath });
    }
    if (node.children.length > 0) {
      repos.push(...findProjectRepos(node.children, nodePath));
    }
  }
  return repos;
}

/** Group repos by their top-level directory */
function groupReposByDirectory(repos: WorkspaceNode[]): Record<string, WorkspaceNode[]> {
  const groups: Record<string, WorkspaceNode[]> = {};
  for (const repo of repos) {
    const dir = repo.path.split("/")[0] ?? "other";
    (groups[dir] ??= []).push(repo);
  }
  return groups;
}

interface ManagedModeConfigProps {
  includedRepos: string[];
  onIncludedReposChange: (repos: string[]) => void;
}

export function ManagedModeConfig({
  includedRepos,
  onIncludedReposChange,
}: ManagedModeConfigProps) {
  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Project repo selection
  const [selectedRepo, setSelectedRepo] = useState<string>("");
  const [repoSearch, setRepoSearch] = useState("");
  const [showCreateRepo, setShowCreateRepo] = useState(false);
  const [newRepoName, setNewRepoName] = useState("");
  const [newRepoLocation, setNewRepoLocation] = useState<string>("projects");
  const [createError, setCreateError] = useState<string | null>(null);

  // Load workspace tree
  const loadTree = async () => {
    try {
      setLoading(true);
      const result = await rpc.call<WorkspaceTree>("main", "bridge.getWorkspaceTree");
      setTree(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workspace");
      setTree(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTree();
  }, []);

  // Find all repos
  const allRepos = useMemo(() => {
    if (!tree) return [];
    return findProjectRepos(tree.children);
  }, [tree]);

  // Filter repos by search
  const filteredRepos = useMemo(() => {
    if (!repoSearch.trim()) return allRepos;
    const query = repoSearch.toLowerCase();
    return allRepos.filter(
      (r: WorkspaceNode) =>
        r.name.toLowerCase().includes(query) ||
        r.path.toLowerCase().includes(query)
    );
  }, [allRepos, repoSearch]);

  // Group filtered repos by directory
  const groupedRepos = useMemo(() => {
    return groupReposByDirectory(filteredRepos);
  }, [filteredRepos]);

  // Handle repo selection
  const handleRepoSelect = (repoPath: string) => {
    setSelectedRepo(repoPath);
    onIncludedReposChange([repoPath]);
  };

  // Handle creating a new repo
  const handleCreateRepo = async () => {
    if (!newRepoName.trim()) return;

    const repoPath = `${newRepoLocation}/${newRepoName.trim()}`;

    try {
      setCreateError(null);
      // Call bridge to create the repo
      await rpc.call("main", "bridge.createRepo", repoPath);

      // Reload tree and select the new repo
      await loadTree();
      handleRepoSelect(repoPath);
      setShowCreateRepo(false);
      setNewRepoName("");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create repository");
    }
  };

  if (loading) {
    return (
      <Flex align="center" justify="center" py="4">
        <Spinner size="2" />
        <Text size="2" color="gray" ml="2">
          Loading workspace...
        </Text>
      </Flex>
    );
  }

  if (error) {
    return (
      <Box>
        <Text size="2" color="red">
          {error}
        </Text>
      </Box>
    );
  }

  return (
    <Box>
      {/* Section: Project Repository */}
      <Text as="label" size="2" weight="medium" mb="2" style={{ display: "block" }}>
        Project Repository
      </Text>

      <Callout.Root size="1" color="gray" mb="3">
        <Callout.Icon>
          <InfoCircledIcon />
        </Callout.Icon>
        <Callout.Text>
          Select or create a repository for your project.
        </Callout.Text>
      </Callout.Root>

      {/* Search */}
      <TextField.Root
        size="2"
        placeholder="Search repositories..."
        value={repoSearch}
        onChange={(e) => setRepoSearch(e.target.value)}
        mb="3"
      >
        <TextField.Slot>
          <MagnifyingGlassIcon />
        </TextField.Slot>
      </TextField.Root>

      {/* Repo grid */}
      <ScrollArea style={{ maxHeight: 280 }}>
        {filteredRepos.length === 0 ? (
          <Box p="3" style={{ backgroundColor: "var(--gray-a3)", borderRadius: "var(--radius-2)" }}>
            <Text size="2" color="gray">
              {repoSearch ? "No matching repositories" : "No repositories found"}
            </Text>
          </Box>
        ) : (
          <RadioGroup.Root value={selectedRepo} onValueChange={handleRepoSelect}>
            <Flex direction="column" gap="3">
              {(Object.entries(groupedRepos) as [string, WorkspaceNode[]][]).map(([dir, repos]) => (
                <Box key={dir}>
                  <Text size="1" color="gray" weight="medium" mb="2" style={{ display: "block" }}>
                    {dir}/
                  </Text>
                  <Box
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
                      gap: "8px",
                    }}
                  >
                    {repos.map((repo: WorkspaceNode) => {
                      const isSelected = selectedRepo === repo.path;
                      return (
                        <Box
                          key={repo.path}
                          asChild
                          p="2"
                          style={{
                            cursor: "pointer",
                            borderRadius: "var(--radius-2)",
                            backgroundColor: isSelected ? "var(--accent-a4)" : "var(--gray-a3)",
                            border: isSelected ? "1px solid var(--accent-8)" : "1px solid transparent",
                            transition: "all 0.15s ease",
                          }}
                        >
                          <label>
                            <Flex direction="column" gap="1">
                              <Flex align="center" gap="2">
                                <RadioGroup.Item value={repo.path} style={{ display: "none" }} />
                                <CubeIcon style={{ color: isSelected ? "var(--accent-11)" : "var(--gray-11)", flexShrink: 0 }} />
                                <Text
                                  size="2"
                                  weight="medium"
                                  style={{
                                    color: isSelected ? "var(--accent-11)" : "inherit",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {repo.name}
                                </Text>
                              </Flex>
                              <Text
                                size="1"
                                style={{
                                  color: "var(--gray-10)",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {repo.path}
                              </Text>
                              {repo.launchable && (
                                <Badge size="1" color={isSelected ? "iris" : "gray"} variant="soft">
                                  {repo.launchable.type}
                                </Badge>
                              )}
                            </Flex>
                          </label>
                        </Box>
                      );
                    })}
                  </Box>
                </Box>
              ))}
            </Flex>
          </RadioGroup.Root>
        )}
      </ScrollArea>

      {/* Create new repo section */}
      <Separator size="4" my="3" />

      <Button
        variant="soft"
        size="2"
        onClick={() => setShowCreateRepo(!showCreateRepo)}
        style={{ width: "100%" }}
      >
        <Flex align="center" gap="2" justify="between" style={{ width: "100%" }}>
          <Flex align="center" gap="2">
            <PlusIcon />
            <Text>Create New Repository</Text>
          </Flex>
          {showCreateRepo ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </Flex>
      </Button>

      {showCreateRepo && (
        <Card mt="3">
          <Flex direction="column" gap="3">
            {/* Location selector */}
            <Box>
              <Text size="1" color="gray" mb="1" style={{ display: "block" }}>
                Location
              </Text>
              <RadioGroup.Root
                value={newRepoLocation}
                onValueChange={setNewRepoLocation}
              >
                <Flex gap="3" wrap="wrap">
                  {PROJECT_DIRECTORIES.map((dir: string) => (
                    <Flex key={dir} align="center" gap="1" asChild>
                      <label style={{ cursor: "pointer" }}>
                        <RadioGroup.Item value={dir} />
                        <Text size="2">{dir}/</Text>
                      </label>
                    </Flex>
                  ))}
                </Flex>
              </RadioGroup.Root>
            </Box>

            {/* Repo name */}
            <Box>
              <Text size="1" color="gray" mb="1" style={{ display: "block" }}>
                Repository Name
              </Text>
              <TextField.Root
                size="2"
                value={newRepoName}
                onChange={(e) => setNewRepoName(e.target.value)}
                placeholder="my-project"
              />
              {newRepoName && (
                <Text size="1" color="gray" mt="1" style={{ fontFamily: "monospace" }}>
                  {newRepoLocation}/{newRepoName}
                </Text>
              )}
            </Box>

            {/* Error display */}
            {createError && (
              <Text size="2" color="red">{createError}</Text>
            )}

            {/* Create button */}
            <Flex gap="2" justify="end">
              <Button
                variant="soft"
                color="gray"
                size="2"
                onClick={() => setShowCreateRepo(false)}
              >
                Cancel
              </Button>
              <Button
                variant="solid"
                size="2"
                onClick={handleCreateRepo}
                disabled={!newRepoName.trim()}
              >
                Create Repository
              </Button>
            </Flex>
          </Flex>
        </Card>
      )}

    </Box>
  );
}
