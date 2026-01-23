/**
 * RepoSelector - Three-stage picker for selecting a repo with branch/commit.
 * Stage 1: Select repo from tree
 * Stage 2: Select branch
 * Stage 3: Optional commit selection
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Box,
  Flex,
  Text,
  Button,
  Select,
  Checkbox,
  Spinner,
} from "@radix-ui/themes";
import {
  getWorkspaceTree,
  listBranches,
  listCommits,
  onFocus,
} from "@natstack/runtime";
import type {
  WorkspaceTree,
  WorkspaceNode,
  BranchInfo,
  CommitInfo,
} from "@natstack/runtime";
import { WorkspaceTreeView } from "./WorkspaceTreeView";

interface RepoSelectorProps {
  /**
   * Current value: "repos/shared#main" or "repos/shared@abc123"
   * Format: "path#branch" or "path@commit"
   */
  value: string;
  onChange: (value: string) => void;
  /** Placeholder text when no repo is selected */
  placeholder?: string;
}

/**
 * Parse a repo reference value into its components.
 */
function parseRepoRef(value: string): { path: string; branch?: string; commit?: string } {
  if (!value) return { path: "" };

  // Check for commit reference (path@commit)
  const atIndex = value.lastIndexOf("@");
  if (atIndex > 0) {
    return {
      path: value.slice(0, atIndex),
      commit: value.slice(atIndex + 1),
    };
  }

  // Check for branch reference (path#branch)
  const hashIndex = value.lastIndexOf("#");
  if (hashIndex > 0) {
    return {
      path: value.slice(0, hashIndex),
      branch: value.slice(hashIndex + 1),
    };
  }

  return { path: value };
}

/**
 * Format repo reference components into a string value.
 */
function formatRepoRef(path: string, branch?: string, commit?: string): string {
  if (commit) {
    return `${path}@${commit}`;
  }
  if (branch) {
    return `${path}#${branch}`;
  }
  return path;
}

export function RepoSelector({
  value,
  onChange,
  placeholder = "Select a repository...",
}: RepoSelectorProps) {
  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Parsed current value
  const { path: selectedPath, branch: selectedBranch, commit: selectedCommit } = useMemo(
    () => parseRepoRef(value),
    [value]
  );

  // Branches and commits for the selected repo
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [branchLoading, setBranchLoading] = useState(false);
  const [commitLoading, setCommitLoading] = useState(false);
  const [showCommitPicker, setShowCommitPicker] = useState(!!selectedCommit);

  // Fetch workspace tree - runs on mount and when panel receives focus
  const fetchTree = useCallback(() => {
    setLoading(true);
    getWorkspaceTree()
      .then(setTree)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchTree();
    // Also refetch when the panel receives focus (user navigates back to it)
    return onFocus(fetchTree);
  }, [fetchTree]);

  // Load branches when repo is selected
  useEffect(() => {
    if (!selectedPath) {
      setBranches([]);
      return;
    }

    setBranchLoading(true);
    listBranches(selectedPath)
      .then((branchList) => {
        setBranches(branchList);
        // If no branch selected, select the current branch
        if (!selectedBranch && branchList.length > 0) {
          const currentBranch = branchList.find((b) => b.current) ?? branchList[0]!;
          onChange(formatRepoRef(selectedPath, currentBranch.name, selectedCommit));
        }
      })
      .catch((err) => {
        console.error("Failed to load branches:", err);
        setBranches([]);
      })
      .finally(() => setBranchLoading(false));
  }, [selectedPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load commits when branch is selected and commit picker is enabled
  useEffect(() => {
    if (!selectedPath || !selectedBranch || !showCommitPicker) {
      setCommits([]);
      return;
    }

    setCommitLoading(true);
    listCommits(selectedPath, selectedBranch, 30)
      .then(setCommits)
      .catch((err) => {
        console.error("Failed to load commits:", err);
        setCommits([]);
      })
      .finally(() => setCommitLoading(false));
  }, [selectedPath, selectedBranch, showCommitPicker]);

  const handleRepoSelect = useCallback(
    (node: WorkspaceNode) => {
      // Reset to just the repo path (branch will be auto-selected)
      onChange(node.path);
      setShowCommitPicker(false);
    },
    [onChange]
  );

  const handleBranchChange = useCallback(
    (branch: string) => {
      // Clear commit when branch changes
      onChange(formatRepoRef(selectedPath, branch));
      setShowCommitPicker(false);
    },
    [selectedPath, onChange]
  );

  const handleCommitChange = useCallback(
    (commit: string) => {
      onChange(formatRepoRef(selectedPath, selectedBranch, commit || undefined));
    },
    [selectedPath, selectedBranch, onChange]
  );

  const handleCommitPickerToggle = useCallback(
    (checked: boolean) => {
      setShowCommitPicker(checked);
      if (!checked) {
        // Clear commit selection
        onChange(formatRepoRef(selectedPath, selectedBranch));
      }
    },
    [selectedPath, selectedBranch, onChange]
  );

  const handleClear = useCallback(() => {
    onChange("");
    setShowCommitPicker(false);
  }, [onChange]);

  if (loading) {
    return (
      <Flex align="center" gap="2" py="2">
        <Spinner size="1" />
        <Text size="2" color="gray">
          Loading repositories...
        </Text>
      </Flex>
    );
  }

  if (error) {
    return (
      <Text size="2" color="red">
        Error loading repositories: {error}
      </Text>
    );
  }

  if (!tree) {
    return (
      <Text size="2" color="gray">
        No repositories found
      </Text>
    );
  }

  // If a repo is selected, show the branch/commit selectors
  if (selectedPath) {
    return (
      <Flex direction="column" gap="3">
        {/* Selected repo display */}
        <Flex align="center" justify="between" gap="2">
          <Text size="2" weight="medium">
            {selectedPath}
          </Text>
          <Button size="1" variant="ghost" color="gray" onClick={handleClear}>
            Change
          </Button>
        </Flex>

        {/* Branch selector */}
        <Flex direction="column" gap="1">
          <Text size="1" color="gray">
            Branch
          </Text>
          {branchLoading ? (
            <Flex align="center" gap="2">
              <Spinner size="1" />
              <Text size="2" color="gray">
                Loading branches...
              </Text>
            </Flex>
          ) : (
            <Select.Root
              value={selectedBranch ?? ""}
              onValueChange={handleBranchChange}
            >
              <Select.Trigger placeholder="Select branch..." />
              <Select.Content>
                {branches.map((branch) => (
                  <Select.Item key={branch.name} value={branch.name}>
                    {branch.name}
                    {branch.current && " (current)"}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          )}
        </Flex>

        {/* Commit picker toggle */}
        <Flex align="center" gap="2">
          <Checkbox
            checked={showCommitPicker}
            onCheckedChange={handleCommitPickerToggle}
          />
          <Text size="2">Pin to specific commit</Text>
        </Flex>

        {/* Commit selector */}
        {showCommitPicker && (
          <Flex direction="column" gap="1">
            <Text size="1" color="gray">
              Commit
            </Text>
            {commitLoading ? (
              <Flex align="center" gap="2">
                <Spinner size="1" />
                <Text size="2" color="gray">
                  Loading commits...
                </Text>
              </Flex>
            ) : (
              <Select.Root
                value={selectedCommit ?? ""}
                onValueChange={handleCommitChange}
              >
                <Select.Trigger placeholder="Select commit..." />
                <Select.Content>
                  {commits.map((commit) => (
                    <Select.Item key={commit.oid} value={commit.oid}>
                      <Flex direction="column" gap="0">
                        <Text size="2" style={{ fontFamily: "monospace" }}>
                          {commit.oid.slice(0, 7)}
                        </Text>
                        <Text size="1" color="gray">
                          {commit.message.slice(0, 50)}
                          {commit.message.length > 50 ? "..." : ""}
                        </Text>
                      </Flex>
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            )}
          </Flex>
        )}

        {/* Current value display */}
        <Box>
          <Text size="1" color="gray">
            Value: <code>{value || "(none)"}</code>
          </Text>
        </Box>
      </Flex>
    );
  }

  // No repo selected - show the tree picker
  return (
    <Flex direction="column" gap="2">
      <Text size="2" color="gray">
        {placeholder}
      </Text>
      <Box
        style={{
          maxHeight: "200px",
          overflowY: "auto",
          border: "1px solid var(--gray-6)",
          borderRadius: "var(--radius-2)",
          padding: "8px",
        }}
      >
        <WorkspaceTreeView
          tree={tree}
          filter="repos"
          onSelect={handleRepoSelect}
          selectedPath={selectedPath}
        />
      </Box>
    </Flex>
  );
}

export type { RepoSelectorProps };
