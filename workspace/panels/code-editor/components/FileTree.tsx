/**
 * File tree sidebar component.
 *
 * Displays the workspace directory structure with expand/collapse
 * functionality for directories.
 */

import { Box, Flex, Text, Spinner, IconButton } from "@radix-ui/themes";
import { ReloadIcon } from "@radix-ui/react-icons";
import type { TreeNode } from "../types";
import { FileTreeNode } from "./FileTreeNode";

export interface FileTreeProps {
  root: TreeNode;
  expandedPaths: Set<string>;
  isLoading: boolean;
  error: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onRefresh: () => void;
  style?: React.CSSProperties;
}

export function FileTree({
  root,
  expandedPaths,
  isLoading,
  error,
  onToggle,
  onSelect,
  onRefresh,
  style,
}: FileTreeProps) {
  if (isLoading) {
    return (
      <Flex
        direction="column"
        align="center"
        justify="center"
        style={{ ...style, padding: 16 }}
      >
        <Spinner size="2" />
        <Text size="1" color="gray" style={{ marginTop: 8 }}>
          Loading...
        </Text>
      </Flex>
    );
  }

  if (error) {
    return (
      <Flex
        direction="column"
        align="center"
        justify="center"
        style={{ ...style, padding: 16 }}
      >
        <Text size="1" color="red">
          {error}
        </Text>
      </Flex>
    );
  }

  if (root.children.length === 0) {
    return (
      <Flex
        direction="column"
        align="center"
        justify="center"
        style={{ ...style, padding: 16 }}
      >
        <Text size="1" color="gray">
          No files found
        </Text>
      </Flex>
    );
  }

  return (
    <Flex
      direction="column"
      style={{
        ...style,
        overflow: "hidden",
      }}
    >
      {/* Header with refresh button */}
      <Flex
        align="center"
        justify="between"
        style={{
          padding: "6px 8px",
          borderBottom: "1px solid var(--gray-5)",
          flexShrink: 0,
        }}
      >
        <Text size="1" weight="medium" color="gray">
          Files
        </Text>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          onClick={onRefresh}
          disabled={isLoading}
        >
          <ReloadIcon />
        </IconButton>
      </Flex>

      {/* File tree content */}
      <Box
        style={{
          flex: 1,
          overflow: "auto",
          paddingTop: 4,
          paddingBottom: 8,
        }}
      >
        <style>
          {`
            .file-tree-node:hover {
              background-color: var(--gray-a3);
            }
          `}
        </style>
        {root.children.map((child) => (
          <FileTreeNode
            key={child.path}
            node={child}
            depth={0}
            isExpanded={expandedPaths.has(child.path)}
            expandedPaths={expandedPaths}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
      </Box>
    </Flex>
  );
}
