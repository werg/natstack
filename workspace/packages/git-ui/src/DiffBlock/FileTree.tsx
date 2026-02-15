import { useState, useMemo } from "react";
import { Box, Flex, Text, Badge, Button, IconButton, Spinner, ContextMenu, ScrollArea } from "@radix-ui/themes";
import * as Collapsible from "@radix-ui/react-collapsible";
import {
  ChevronRightIcon,
  ChevronDownIcon,
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
  onCreateFile?: (parentPath: string | null) => void;
  onDeleteFile?: (path: string, isDirectory: boolean) => void;
}

interface FileTreeProps {
  files: FileChange[];
  selectedFiles: Set<string>;
  onSelect: (path: string, event: React.MouseEvent) => void;
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
  // Don't show badge for unmodified files
  if (status === "unmodified") return null;
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

  const parentPath = file.path.includes("/")
    ? file.path.slice(0, file.path.lastIndexOf("/"))
    : null;

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
        {actions.onCreateFile && (
          <>
            <ContextMenu.Separator />
            <ContextMenu.Item onSelect={() => actions.onCreateFile!(parentPath)}>
              <PlusIcon /> New file here...
            </ContextMenu.Item>
          </>
        )}
        {actions.onDiscardFile && !file.staged && (
          <>
            <ContextMenu.Separator />
            <ContextMenu.Item color="red" onSelect={() => actions.onDiscardFile!(file.path)}>
              <TrashIcon /> {file.status === "added" ? "Delete file" : "Discard changes"}
            </ContextMenu.Item>
          </>
        )}
        {actions.onDeleteFile && file.status === "unmodified" && (
          <>
            {!actions.onDiscardFile && <ContextMenu.Separator />}
            <ContextMenu.Item color="red" onSelect={() => actions.onDeleteFile!(file.path, false)}>
              <TrashIcon /> Delete file
            </ContextMenu.Item>
          </>
        )}
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}

function DirectoryContextMenu({
  path,
  children,
  actions,
}: {
  path: string;
  children: React.ReactNode;
  actions?: FileTreeContextMenuActions;
}) {
  if (!actions?.onCreateFile && !actions?.onDeleteFile) {
    return <>{children}</>;
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
      <ContextMenu.Content>
        {actions.onCreateFile && (
          <ContextMenu.Item onSelect={() => actions.onCreateFile!(path)}>
            <PlusIcon /> New file...
          </ContextMenu.Item>
        )}
        {actions.onDeleteFile && (
          <>
            <ContextMenu.Separator />
            <ContextMenu.Item color="red" onSelect={() => actions.onDeleteFile!(path, true)}>
              <TrashIcon /> Delete directory
            </ContextMenu.Item>
          </>
        )}
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}

const INDENT_SIZE = 16;

function TreeNodeComponent({
  node,
  selectedFiles,
  onSelect,
  depth = 0,
  largeFolderThreshold,
  contextMenuActions,
  focusedPath,
  pendingFiles,
  highlightQuery,
  partiallyStagedFiles,
}: {
  node: TreeNode;
  selectedFiles: Set<string>;
  onSelect: (path: string, event: React.MouseEvent) => void;
  depth?: number;
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

  if (node.isDirectory) {
    const directoryHeader = (
      <Flex
        align="center"
        style={{ paddingLeft: depth * INDENT_SIZE, minWidth: "max-content" }}
        role="treeitem"
        aria-expanded={expanded && !shouldCollapse}
        aria-label={`${node.name} directory`}
      >
        <Collapsible.Trigger asChild>
          <Flex align="center" gap="1" style={{ cursor: "pointer" }}>
            {expanded ? <ChevronDownIcon width={12} height={12} /> : <ChevronRightIcon width={12} height={12} />}
            <Text size="1">{highlightMatch(`${node.name}/`, highlightQuery)}</Text>
            {isLargeFolder && (
              <Badge size="1" variant="soft">
                {node.children.length}
              </Badge>
            )}
          </Flex>
        </Collapsible.Trigger>
        {contextMenuActions?.onCreateFile && (
          <IconButton
            size="1"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              contextMenuActions.onCreateFile!(node.path);
            }}
            aria-label="New file in this directory"
            title="New file in this directory"
          >
            <PlusIcon />
          </IconButton>
        )}
      </Flex>
    );

    return (
      <Collapsible.Root
        open={expanded && !shouldCollapse}
        onOpenChange={setExpanded}
      >
        <DirectoryContextMenu path={node.path} actions={contextMenuActions}>
          {directoryHeader}
        </DirectoryContextMenu>

        {shouldCollapse ? (
          <Flex align="center" style={{ paddingLeft: (depth + 1) * INDENT_SIZE, minWidth: "max-content" }}>
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
            {node.children.map((child) => (
              <TreeNodeComponent
                key={child.path}
                node={child}
                selectedFiles={selectedFiles}
                onSelect={onSelect}
                depth={depth + 1}
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
  const isFileSelected = selectedFiles.has(node.path);
  const isFileFocused = focusedPath === node.path;
  const isFilePending = pendingFiles?.has(node.path) ?? false;
  const isPartiallyStaged = partiallyStagedFiles?.has(node.path) ?? false;
  const isUnmodified = node.file?.status === "unmodified";

  const fileContent = (
    <Box style={{ paddingLeft: depth * INDENT_SIZE }} role="treeitem" aria-selected={isFileSelected}>
      <Button
        variant="ghost"
        size="1"
        onClick={(e) => onSelect(node.path, e)}
        disabled={isFilePending}
        data-focused={isFileFocused || undefined}
        data-state={isFileSelected ? "selected" : undefined}
        aria-label={isPartiallyStaged ? `${node.name} (partially staged)` : node.name}
        aria-disabled={isFilePending}
        style={{
          justifyContent: "flex-start",
          backgroundColor: isFileSelected ? "var(--accent-a3)" : undefined,
        }}
      >
        {isFilePending ? (
          <Spinner size="1" />
        ) : (
          <Box style={{ width: 12, height: 12, flexShrink: 0 }} />
        )}
        <Text size="1" weight={isFileSelected ? "medium" : undefined} color={isUnmodified ? "gray" : undefined}>
          {highlightMatch(node.name, highlightQuery)}
        </Text>
        {node.file && getStatusBadge(node.file.status)}
        {isPartiallyStaged && (
          <Badge size="1" variant="outline" color="yellow" title="Partially staged">
            ½
          </Badge>
        )}
      </Button>
    </Box>
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
  selectedFiles,
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
          {tree.children.map((node) => (
            <TreeNodeComponent
              key={node.path}
              node={node}
              selectedFiles={selectedFiles}
              onSelect={onSelect}
              largeFolderThreshold={largeFolderThreshold}
              contextMenuActions={contextMenuActions}
              focusedPath={focusedPath}
              pendingFiles={pendingFiles}
              highlightQuery={highlightQuery}
              partiallyStagedFiles={partiallyStagedFiles}
            />
          ))}
          {/* Root-level add button */}
          {contextMenuActions?.onCreateFile && (
            <Button
              size="1"
              variant="ghost"
              onClick={() => contextMenuActions.onCreateFile!(null)}
              style={{ justifyContent: "flex-start" }}
            >
              <PlusIcon />
              New...
            </Button>
          )}
        </Flex>
      </ScrollArea>
    </Box>
  );
}
