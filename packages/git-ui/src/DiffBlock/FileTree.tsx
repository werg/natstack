import { useState, useMemo } from "react";
import { Box, Flex, Text, Badge, Button, Spinner, ContextMenu, ScrollArea } from "@radix-ui/themes";
import * as Collapsible from "@radix-ui/react-collapsible";
import {
  ChevronRightIcon,
  ChevronDownIcon,
  FileIcon,
  PlusIcon,
  MinusIcon,
  TrashIcon,
  CopyIcon,
} from "@radix-ui/react-icons";
import type { FileChange } from "./types";
import { STATUS_LABELS } from "./types";
import { buildTree, type TreeNode } from "../utils";

export interface FileTreeContextMenuActions {
  onStageFile?: (path: string) => void;
  onUnstageFile?: (path: string) => void;
  onDiscardFile?: (path: string) => void;
  onCopyPath?: (path: string) => void;
}

interface FileTreeProps {
  files: FileChange[];
  selectedFile: string | null;
  onSelect: (path: string) => void;
  largeFolderThreshold: number;
  contextMenuActions?: FileTreeContextMenuActions;
  /** Path of keyboard-focused file for visual indication */
  focusedPath?: string | null;
  /** Set of file paths with pending operations (show loading spinner) */
  pendingFiles?: Set<string>;
  /** Highlight matches for search */
  highlightQuery?: string;
  /** Set of file paths that are partially staged (show indicator) */
  partiallyStagedFiles?: Set<string>;
}

function getStatusBadge(status: FileChange["status"]) {
  return (
    <Badge size="1" variant="soft">
      {STATUS_LABELS[status]}
    </Badge>
  );
}

function highlightMatch(text: string, query?: string) {
  const needle = query?.trim();
  if (!needle) return text;
  const lower = text.toLowerCase();
  const match = lower.indexOf(needle.toLowerCase());
  if (match === -1) return text;
  return (
    <>
      {text.slice(0, match)}
      <Text asChild highContrast>
        <mark>{text.slice(match, match + needle.length)}</mark>
      </Text>
      {text.slice(match + needle.length)}
    </>
  );
}

function FileContextMenu({
  file,
  children,
  actions,
}: {
  file: FileChange;
  children: React.ReactNode;
  actions?: FileTreeContextMenuActions;
}) {
  if (!actions) {
    return <>{children}</>;
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
      <ContextMenu.Content>
        {actions.onStageFile && !file.staged && (
          <ContextMenu.Item onSelect={() => actions.onStageFile!(file.path)}>
            <PlusIcon /> Stage file
          </ContextMenu.Item>
        )}
        {actions.onUnstageFile && file.staged && (
          <ContextMenu.Item onSelect={() => actions.onUnstageFile!(file.path)}>
            <MinusIcon /> Unstage file
          </ContextMenu.Item>
        )}
        {actions.onCopyPath && (
          <ContextMenu.Item onSelect={() => actions.onCopyPath!(file.path)}>
            <CopyIcon /> Copy path
          </ContextMenu.Item>
        )}
        {actions.onDiscardFile && !file.staged && (
          <>
            <ContextMenu.Separator />
            <ContextMenu.Item color="red" onSelect={() => actions.onDiscardFile!(file.path)}>
              <TrashIcon /> {file.status === "added" ? "Delete file" : "Discard changes"}
            </ContextMenu.Item>
          </>
        )}
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}

const INDENT_SIZE = 16;

/** Renders tree line guides for a node */
function TreeLines({ depth, isLast, parentLines }: { depth: number; isLast: boolean; parentLines: boolean[] }) {
  if (depth === 0) return null;

  return (
    <Box style={{ position: "relative", display: "flex", flexShrink: 0 }}>
      {/* Vertical lines from ancestors */}
      {parentLines.map((showLine, i) => (
        <Box
          key={i}
          style={{
            width: INDENT_SIZE,
            height: "100%",
            position: "relative",
          }}
        >
          {showLine && (
            <Box
              style={{
                position: "absolute",
                left: INDENT_SIZE / 2 - 0.5,
                top: 0,
                bottom: 0,
                width: 1,
                background: "var(--gray-a6)",
              }}
            />
          )}
        </Box>
      ))}
      {/* Current level connector */}
      <Box
        style={{
          width: INDENT_SIZE,
          height: "100%",
          position: "relative",
        }}
      >
        {/* Vertical line (stops at middle for last item) */}
        <Box
          style={{
            position: "absolute",
            left: INDENT_SIZE / 2 - 0.5,
            top: 0,
            bottom: isLast ? "50%" : 0,
            width: 1,
            background: "var(--gray-a6)",
          }}
        />
        {/* Horizontal branch */}
        <Box
          style={{
            position: "absolute",
            left: INDENT_SIZE / 2 - 0.5,
            top: "50%",
            width: INDENT_SIZE / 2,
            height: 1,
            background: "var(--gray-a6)",
          }}
        />
      </Box>
    </Box>
  );
}

function TreeNodeComponent({
  node,
  selectedFile,
  onSelect,
  depth = 0,
  isLast = true,
  parentLines = [],
  largeFolderThreshold,
  contextMenuActions,
  focusedPath,
  pendingFiles,
  highlightQuery,
  partiallyStagedFiles,
}: {
  node: TreeNode;
  selectedFile: string | null;
  onSelect: (path: string) => void;
  depth?: number;
  isLast?: boolean;
  parentLines?: boolean[];
  largeFolderThreshold: number;
  contextMenuActions?: FileTreeContextMenuActions;
  focusedPath?: string | null;
  pendingFiles?: Set<string>;
  highlightQuery?: string;
  partiallyStagedFiles?: Set<string>;
}) {
  const [expanded, setExpanded] = useState(true);
  const [forceExpanded, setForceExpanded] = useState(false);

  const isLargeFolder =
    node.isDirectory && node.children.length > largeFolderThreshold;
  const shouldCollapse = isLargeFolder && !forceExpanded;

  // Build parent lines for children (include current level's line if not last)
  const childParentLines = depth > 0 ? [...parentLines, !isLast] : [];

  if (node.isDirectory) {
    return (
      <Collapsible.Root
        open={expanded && !shouldCollapse}
        onOpenChange={setExpanded}
      >
        <Flex align="center" minHeight="24px">
          <TreeLines depth={depth} isLast={isLast} parentLines={parentLines} />
          <Collapsible.Trigger asChild>
            <Flex align="center" gap="1" flexGrow="1" style={{ cursor: "pointer" }}>
              {expanded ? <ChevronDownIcon width={12} height={12} /> : <ChevronRightIcon width={12} height={12} />}
              <Text size="1">{highlightMatch(`${node.name}/`, highlightQuery)}</Text>
              {isLargeFolder && (
                <Badge size="1" variant="soft">
                  {node.children.length}
                </Badge>
              )}
            </Flex>
          </Collapsible.Trigger>
        </Flex>

        {shouldCollapse ? (
          <Flex align="center" minHeight="24px">
            <TreeLines depth={depth + 1} isLast={true} parentLines={childParentLines} />
            <Button
              size="1"
              variant="ghost"
              onClick={() => setForceExpanded(true)}
            >
              Show {node.children.length} files...
            </Button>
          </Flex>
        ) : (
          <Collapsible.Content>
            {node.children.map((child, index) => (
              <TreeNodeComponent
                key={child.path}
                node={child}
                selectedFile={selectedFile}
                onSelect={onSelect}
                depth={depth + 1}
                isLast={index === node.children.length - 1}
                parentLines={childParentLines}
                largeFolderThreshold={largeFolderThreshold}
                contextMenuActions={contextMenuActions}
                focusedPath={focusedPath}
                pendingFiles={pendingFiles}
                highlightQuery={highlightQuery}
                partiallyStagedFiles={partiallyStagedFiles}
              />
            ))}
          </Collapsible.Content>
        )}
      </Collapsible.Root>
    );
  }

  // File node
  const isFileSelected = selectedFile === node.path;
  const isFileFocused = focusedPath === node.path;
  const isFilePending = pendingFiles?.has(node.path) ?? false;
  const isPartiallyStaged = partiallyStagedFiles?.has(node.path) ?? false;

  const fileContent = (
    <Flex align="center" minHeight="24px">
      <TreeLines depth={depth} isLast={isLast} parentLines={parentLines} />
      <Button
        variant={isFileSelected ? "soft" : "ghost"}
        size="1"
        onClick={() => onSelect(node.path)}
        disabled={isFilePending}
        data-focused={isFileFocused || undefined}
        aria-label={isPartiallyStaged ? `${node.name} (partially staged)` : node.name}
        style={{
          flex: 1,
          justifyContent: "flex-start",
          opacity: isFilePending ? 0.6 : 1,
          height: 24,
          padding: "0 4px",
        }}
      >
        {isFilePending ? <Spinner size="1" /> : <FileIcon width={12} height={12} />}
        <Text size="1" weight={isFileSelected ? "medium" : undefined}>
          {highlightMatch(node.name, highlightQuery)}
        </Text>
        {node.file && getStatusBadge(node.file.status)}
        {isPartiallyStaged && (
          <Badge size="1" variant="outline" color="yellow" title="Partially staged">
            ½
          </Badge>
        )}
      </Button>
    </Flex>
  );

  if (node.file && contextMenuActions) {
    return (
      <FileContextMenu file={node.file} actions={contextMenuActions}>
        {fileContent}
      </FileContextMenu>
    );
  }

  return fileContent;
}

export function FileTree({
  files,
  selectedFile,
  onSelect,
  largeFolderThreshold,
  contextMenuActions,
  focusedPath,
  pendingFiles,
  highlightQuery,
  partiallyStagedFiles,
}: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);

  return (
    <Box
      flexGrow="1"
      overflow="hidden"
      role="tree"
      aria-label="File tree"
    >
      <ScrollArea size="1">
        <Flex direction="column" gap="0" px="1" py="1">
          {tree.children.map((node, index) => (
            <TreeNodeComponent
              key={node.path}
              node={node}
              selectedFile={selectedFile}
              onSelect={onSelect}
              isLast={index === tree.children.length - 1}
              largeFolderThreshold={largeFolderThreshold}
              contextMenuActions={contextMenuActions}
              focusedPath={focusedPath}
              pendingFiles={pendingFiles}
              highlightQuery={highlightQuery}
              partiallyStagedFiles={partiallyStagedFiles}
            />
          ))}
        </Flex>
      </ScrollArea>
    </Box>
  );
}
