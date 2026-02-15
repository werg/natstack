/**
 * Repo picker from workspace tree.
 */

import { useState, useMemo } from "react";
import { Button, Popover, Box, Text, Flex, TextField, ScrollArea } from "@radix-ui/themes";
import { PlusIcon, MagnifyingGlassIcon, CubeIcon } from "@radix-ui/react-icons";
import { useWorkspaceTree, findGitRepos } from "../hooks/useWorkspaceTree";
import type { WorkspaceNode } from "../types";

interface RepoSelectorProps {
  /** Called when a repo is selected */
  onSelect: (repoSpec: string) => void;
  /** Repos to exclude (already added) */
  excludeRepos?: string[];
}

export function RepoSelector({ onSelect, excludeRepos = [] }: RepoSelectorProps) {
  const { tree, loading, error } = useWorkspaceTree();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const excludeSet = useMemo(() => new Set(excludeRepos), [excludeRepos]);

  const repos = useMemo(() => {
    if (!tree) return [];
    return findGitRepos(tree.children).filter((r) => !excludeSet.has(r.path));
  }, [tree, excludeSet]);

  const filteredRepos = useMemo(() => {
    if (!search.trim()) return repos;
    const query = search.toLowerCase();
    return repos.filter(
      (r) =>
        r.name.toLowerCase().includes(query) ||
        r.path.toLowerCase().includes(query)
    );
  }, [repos, search]);

  // Group by top-level directory
  const groupedRepos = useMemo(() => {
    const groups: Record<string, WorkspaceNode[]> = {};
    for (const repo of filteredRepos) {
      const topDir = repo.path.split("/")[0] ?? "";
      if (!groups[topDir]) {
        groups[topDir] = [];
      }
      groups[topDir].push(repo);
    }
    return groups;
  }, [filteredRepos]);

  const handleSelect = (repo: WorkspaceNode) => {
    onSelect(repo.path);
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        <Button variant="soft" size="2">
          <PlusIcon />
          Add Repository
        </Button>
      </Popover.Trigger>
      <Popover.Content style={{ width: 320 }}>
        <Flex direction="column" gap="2">
          <TextField.Root
            size="2"
            placeholder="Search repositories..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          >
            <TextField.Slot>
              <MagnifyingGlassIcon />
            </TextField.Slot>
          </TextField.Root>

          <ScrollArea style={{ maxHeight: 300 }}>
            {loading && (
              <Text size="2" color="gray">
                Loading...
              </Text>
            )}

            {error && (
              <Text size="2" color="red">
                {error}
              </Text>
            )}

            {!loading && !error && filteredRepos.length === 0 && (
              <Text size="2" color="gray">
                {search ? "No matching repositories" : "No repositories available"}
              </Text>
            )}

            {!loading &&
              !error &&
              Object.entries(groupedRepos).map(([dir, dirRepos]) => (
                <Box key={dir} mb="3">
                  <Text size="1" color="gray" weight="medium" mb="1" style={{ display: "block" }}>
                    {dir}/
                  </Text>
                  <Flex direction="column" gap="1">
                    {dirRepos.map((repo) => (
                      <Box
                        key={repo.path}
                        onClick={() => handleSelect(repo)}
                        style={{
                          padding: "var(--space-2)",
                          borderRadius: "var(--radius-2)",
                          cursor: "pointer",
                        }}
                        className="repo-item"
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = "var(--gray-a3)";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = "transparent";
                        }}
                      >
                        <Flex align="center" gap="2">
                          <CubeIcon color="var(--gray-9)" />
                          <Flex direction="column">
                            <Text size="2">{repo.name}</Text>
                            <Text size="1" color="gray">
                              {repo.path}
                            </Text>
                          </Flex>
                        </Flex>
                      </Box>
                    ))}
                  </Flex>
                </Box>
              ))}
          </ScrollArea>
        </Flex>
      </Popover.Content>
    </Popover.Root>
  );
}
