/**
 * Dropdown for selecting git ref (branch, tag, commit).
 */

import { useState } from "react";
import { Select, Text, TextField, Flex, Button, Popover, Box } from "@radix-ui/themes";
import type { RefSelection } from "../types";
import { useGitRefs } from "../hooks/useGitRefs";

interface RefSelectorProps {
  /** Current ref selection */
  value: RefSelection;
  /** Called when ref changes */
  onChange: (ref: RefSelection) => void;
  /** Repo spec to fetch refs for */
  repoSpec: string;
  /** Whether the selector is disabled */
  disabled?: boolean;
}

export function RefSelector({ value, onChange, repoSpec, disabled }: RefSelectorProps) {
  const { branches, commits, loading } = useGitRefs(repoSpec);
  const [showCommitInput, setShowCommitInput] = useState(false);
  const [commitHash, setCommitHash] = useState(value.type === "commit" ? value.value ?? "" : "");

  const displayValue = getDisplayValue(value);

  const handleSelectChange = (selected: string) => {
    if (selected === "latest") {
      onChange({ type: "latest" });
    } else if (selected === "commit-input") {
      setShowCommitInput(true);
    } else if (selected.startsWith("branch:")) {
      onChange({ type: "branch", value: selected.slice(7) });
    } else if (selected.startsWith("commit:")) {
      onChange({ type: "commit", value: selected.slice(7) });
    }
  };

  const handleCommitSubmit = () => {
    if (commitHash.trim()) {
      onChange({ type: "commit", value: commitHash.trim() });
      setShowCommitInput(false);
    }
  };

  if (showCommitInput) {
    return (
      <Flex gap="1" align="center">
        <TextField.Root
          size="1"
          value={commitHash}
          onChange={(e) => setCommitHash(e.target.value)}
          placeholder="Enter commit hash..."
          style={{ width: 120 }}
        />
        <Button size="1" variant="soft" onClick={handleCommitSubmit}>
          OK
        </Button>
        <Button size="1" variant="ghost" onClick={() => setShowCommitInput(false)}>
          Cancel
        </Button>
      </Flex>
    );
  }

  return (
    <Select.Root
      value={getSelectValue(value)}
      onValueChange={handleSelectChange}
      disabled={disabled || loading}
    >
      <Select.Trigger variant="soft" style={{ minWidth: 100 }}>
        {loading ? "Loading..." : displayValue}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="latest">
          <Text size="2">Latest (HEAD)</Text>
        </Select.Item>

        {branches.length > 0 && (
          <Select.Group>
            <Select.Label>Branches</Select.Label>
            {branches.map((branch) => (
              <Select.Item key={branch.name} value={`branch:${branch.name}`}>
                <Text size="2">{branch.name}</Text>
              </Select.Item>
            ))}
          </Select.Group>
        )}

        {commits.length > 0 && (
          <Select.Group>
            <Select.Label>Recent Commits</Select.Label>
            {commits.slice(0, 10).map((commit) => (
              <Select.Item key={commit.hash} value={`commit:${commit.hash.slice(0, 7)}`}>
                <Flex direction="column">
                  <Text size="1" style={{ fontFamily: "monospace" }}>
                    {commit.hash.slice(0, 7)}
                  </Text>
                  <Text size="1" color="gray" style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {commit.message.split("\n")[0]}
                  </Text>
                </Flex>
              </Select.Item>
            ))}
          </Select.Group>
        )}

        <Select.Separator />
        <Select.Item value="commit-input">
          <Text size="2" color="blue">Enter specific commit...</Text>
        </Select.Item>
      </Select.Content>
    </Select.Root>
  );
}

function getDisplayValue(ref: RefSelection): string {
  switch (ref.type) {
    case "latest":
      return "Latest";
    case "branch":
      return ref.value ?? "branch";
    case "tag":
      return ref.value ?? "tag";
    case "commit":
      return ref.value?.slice(0, 7) ?? "commit";
  }
}

function getSelectValue(ref: RefSelection): string {
  switch (ref.type) {
    case "latest":
      return "latest";
    case "branch":
      return `branch:${ref.value}`;
    case "tag":
      return `tag:${ref.value}`;
    case "commit":
      return `commit:${ref.value?.slice(0, 7)}`;
  }
}
