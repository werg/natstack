/**
 * WorkspaceTreeView - Reusable tree view component for workspace discovery.
 * Displays git repos and launchable panels in a hierarchical tree structure.
 */

import { useState, useMemo, useCallback } from "react";
import { Box, Flex, Text, IconButton } from "@radix-ui/themes";
import { CaretRightIcon, CubeIcon, FileIcon } from "@radix-ui/react-icons";
import type { WorkspaceTree, WorkspaceNode } from "@workspace/runtime";

interface WorkspaceTreeViewProps {
  tree: WorkspaceTree;
  /** Filter: "launchable" (has natstack), "repos" (git repos), "all" */
  filter?: "launchable" | "repos" | "all";
  /** Called when a leaf node is selected */
  onSelect: (node: WorkspaceNode) => void;
  /** Currently selected path */
  selectedPath?: string;
  /** Render extra content for a node (e.g., launch form) */
  renderNodeExtra?: (node: WorkspaceNode) => React.ReactNode;
}

const INDENT_WIDTH = 16;

interface TreeNodeProps {
  node: WorkspaceNode;
  depth: number;
  filter?: "launchable" | "repos" | "all";
  onSelect: (node: WorkspaceNode) => void;
  selectedPath?: string;
  renderNodeExtra?: (node: WorkspaceNode) => React.ReactNode;
  expandedPaths: Set<string>;
  toggleExpanded: (path: string) => void;
}

/**
 * Check if a node matches the filter criteria.
 */
function nodeMatchesFilter(
  node: WorkspaceNode,
  filter?: "launchable" | "repos" | "all",
): boolean {
  if (filter === "all") return true;
  if (filter === "launchable") return !!node.launchable;
  if (filter === "repos") return node.isGitRepo;
  return true;
}

/**
 * Check if a node or any of its descendants match the filter.
 */
function hasMatchingDescendants(
  node: WorkspaceNode,
  filter?: "launchable" | "repos" | "all",
): boolean {
  if (nodeMatchesFilter(node, filter) && node.isGitRepo) {
    return true;
  }

  for (const child of node.children) {
    if (hasMatchingDescendants(child, filter)) {
      return true;
    }
  }

  return false;
}

/**
 * Filter the tree to only include nodes that match the filter criteria.
 */
function filterTree(
  nodes: WorkspaceNode[],
  filter?: "launchable" | "repos" | "all",
): WorkspaceNode[] {
  return nodes
    .filter((node) => hasMatchingDescendants(node, filter))
    .map((node) => ({
      ...node,
      children: filterTree(node.children, filter),
    }));
}

function TreeNode({
  node,
  depth,
  filter,
  onSelect,
  selectedPath,
  renderNodeExtra,
  expandedPaths,
  toggleExpanded,
}: TreeNodeProps) {
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = selectedPath === node.path;
  const hasChildren = node.children.length > 0;
  const isSelectable = node.isGitRepo && nodeMatchesFilter(node, filter);

  const handleClick = useCallback(() => {
    if (isSelectable) {
      onSelect(node);
    } else if (hasChildren) {
      toggleExpanded(node.path);
    }
  }, [isSelectable, node, onSelect, hasChildren, toggleExpanded]);

  const handleExpandClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleExpanded(node.path);
    },
    [node.path, toggleExpanded]
  );

  // Get the appropriate icon
  const getIcon = () => {
    if (node.launchable?.type === "app") {
      return <CubeIcon style={{ color: "var(--blue-9)", width: 14, height: 14 }} />;
    }
    if (node.isGitRepo) {
      return <FileIcon style={{ color: "var(--gray-9)", width: 14, height: 14 }} />;
    }
    return null;
  };

  return (
    <Box>
      <Flex
        align="center"
        gap="1"
        px="2"
        py="1"
        tabIndex={isSelectable || hasChildren ? 0 : undefined}
        style={{
          marginLeft: depth * INDENT_WIDTH,
          cursor: isSelectable || hasChildren ? "pointer" : "default",
          backgroundColor: isSelected ? "var(--accent-a3)" : undefined,
          borderRadius: "var(--radius-2)",
        }}
        onClick={handleClick}
        onMouseEnter={(e) => {
          if (isSelectable || hasChildren) {
            (e.currentTarget as HTMLElement).style.backgroundColor =
              isSelected ? "var(--accent-a4)" : "var(--gray-a3)";
          }
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.backgroundColor = isSelected
            ? "var(--accent-a3)"
            : "";
        }}
      >
        {/* Expand/collapse button for folders */}
        {hasChildren ? (
          <IconButton
            size="1"
            variant="ghost"
            color="gray"
            onClick={handleExpandClick}
            style={{
              width: 16,
              height: 16,
              transition: "transform 150ms ease",
              transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
            }}
          >
            <CaretRightIcon />
          </IconButton>
        ) : (
          <Box style={{ width: 16 }} />
        )}

        {/* Icon */}
        {getIcon()}

        {/* Title */}
        <Text
          size="2"
          weight={isSelected ? "medium" : "regular"}
          style={{
            flex: 1,
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            color: isSelectable ? "var(--gray-12)" : "var(--gray-10)",
          }}
        >
          {node.launchable?.title ?? node.name}
        </Text>

        {/* Type badge */}
        {node.launchable && (
          <Text size="1" color="gray">
            {node.launchable.type}
          </Text>
        )}
      </Flex>

      {/* Extra content (e.g., launch form) */}
      {isSelected && renderNodeExtra && (
        <Box ml={String((depth + 1) * INDENT_WIDTH) + "px"} mt="2" mb="2">
          {renderNodeExtra(node)}
        </Box>
      )}

      {/* Children */}
      {isExpanded &&
        node.children.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            filter={filter}
            onSelect={onSelect}
            selectedPath={selectedPath}
            renderNodeExtra={renderNodeExtra}
            expandedPaths={expandedPaths}
            toggleExpanded={toggleExpanded}
          />
        ))}
    </Box>
  );
}

export function WorkspaceTreeView({
  tree,
  filter = "all",
  onSelect,
  selectedPath,
  renderNodeExtra,
}: WorkspaceTreeViewProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    // Auto-expand first level by default
    const initial = new Set<string>();
    for (const node of tree.children) {
      if (node.children.length > 0) {
        initial.add(node.path);
      }
    }
    return initial;
  });

  const toggleExpanded = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // Filter the tree based on filter criteria
  const filteredChildren = useMemo(
    () => filterTree(tree.children, filter),
    [tree.children, filter]
  );

  if (filteredChildren.length === 0) {
    return (
      <Box py="4">
        <Text color="gray" size="2">
          No matching items found
        </Text>
      </Box>
    );
  }

  return (
    <Flex direction="column" gap="0">
      {filteredChildren.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          filter={filter}
          onSelect={onSelect}
          selectedPath={selectedPath}
          renderNodeExtra={renderNodeExtra}
          expandedPaths={expandedPaths}
          toggleExpanded={toggleExpanded}
        />
      ))}
    </Flex>
  );
}

export type { WorkspaceTreeViewProps };
