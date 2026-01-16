/**
 * Individual file/directory node in the file tree.
 */

import { Box, Flex, Text } from "@radix-ui/themes";
import {
  ChevronRightIcon,
  ChevronDownIcon,
  FileIcon,
  FileTextIcon,
} from "@radix-ui/react-icons";
import type { TreeNode } from "../types";
import { getExtension } from "../types";

export interface FileTreeNodeProps {
  node: TreeNode;
  depth: number;
  isExpanded: boolean;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}

/**
 * Get an icon for a file based on extension.
 */
function getFileIcon(name: string): React.ReactNode {
  const ext = getExtension(name).toLowerCase();

  // Use FileTextIcon for code files
  const codeExts = new Set([
    "ts", "tsx", "js", "jsx", "json", "md", "html", "css",
    "scss", "less", "py", "rs", "go", "java", "c", "cpp", "h",
  ]);

  if (codeExts.has(ext)) {
    return <FileTextIcon />;
  }

  return <FileIcon />;
}

export function FileTreeNode({
  node,
  depth,
  isExpanded,
  expandedPaths,
  onToggle,
  onSelect,
}: FileTreeNodeProps) {
  const handleClick = () => {
    if (node.isDirectory) {
      onToggle(node.path);
    } else {
      onSelect(node.path);
    }
  };

  const paddingLeft = 8 + depth * 16;

  return (
    <>
      <Flex
        align="center"
        gap="1"
        onClick={handleClick}
        style={{
          paddingLeft,
          paddingRight: 8,
          paddingTop: 4,
          paddingBottom: 4,
          cursor: "pointer",
          userSelect: "none",
          borderRadius: 4,
        }}
        className="file-tree-node"
      >
        {/* Expand/collapse chevron for directories */}
        <Box style={{ width: 16, flexShrink: 0 }}>
          {node.isDirectory ? (
            isExpanded ? (
              <ChevronDownIcon />
            ) : (
              <ChevronRightIcon />
            )
          ) : null}
        </Box>

        {/* File icon (directories don't need a second icon) */}
        {!node.isDirectory && (
          <Box style={{ flexShrink: 0, color: "var(--gray-11)" }}>
            {getFileIcon(node.name)}
          </Box>
        )}

        {/* Name */}
        <Text
          size="1"
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {node.name}
        </Text>
      </Flex>

      {/* Render children if expanded */}
      {node.isDirectory && isExpanded && (
        <>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              isExpanded={expandedPaths.has(child.path)}
              expandedPaths={expandedPaths}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </>
      )}
    </>
  );
}
