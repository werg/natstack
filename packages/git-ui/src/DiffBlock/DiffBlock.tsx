import { useState, useCallback, useMemo, useEffect } from "react";
import { Box, Flex, Text, IconButton, Separator, Tooltip } from "@radix-ui/themes";
import * as Collapsible from "@radix-ui/react-collapsible";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronLeftIcon,
  LayoutIcon,
} from "@radix-ui/react-icons";
import { FileTree, type FileTreeContextMenuActions } from "./FileTree";
import { DiffStack } from "./DiffStack";
import { CompactFileSearch } from "./FileSearchBar";
import type { DiffBlockProps, FileFilter, FileChange } from "./types";
import {
  FILE_TREE_WIDTH,
  LARGE_DIFF_LINE_THRESHOLD,
  LARGE_FOLDER_FILE_THRESHOLD,
} from "../constants";

export function DiffBlock({
  files,
  getDiff,
  refreshId,
  title,
  summary,
  collapsible = false,
  defaultCollapsed = false,
  showFileTree = true,
  defaultTreeVisible = true,
  filter: externalFilter,
  onFilterChange: externalOnFilterChange,
  largeDiffThreshold = LARGE_DIFF_LINE_THRESHOLD,
  largeFolderThreshold = LARGE_FOLDER_FILE_THRESHOLD,
  onStageFile,
  onStageHunks,
  onUnstageFile,
  onUnstageHunks,
  onDiscardFile,
  editable = false,
  onSaveEdit,
  onCopyPath,
  focusedPath,
  partiallyStagedFiles,
  theme,
  diffType,
  pendingFiles,
  showDiffControls = true,
  diffViewOptions,
  onDiffViewOptionsChange,
  diffKey,
}: DiffBlockProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const [treeVisible, setTreeVisible] = useState(defaultTreeVisible);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [internalFilter, setInternalFilter] = useState<FileFilter>({ search: "", status: null });

  // Use external filter if provided, otherwise use internal state
  const filter = externalFilter ?? internalFilter;
  const setFilter = externalOnFilterChange ?? setInternalFilter;

  // Internal selection state - only used when focusedPath is not provided (uncontrolled mode)
  const [uncontrolledSelection, setUncontrolledSelection] = useState<string | null>(null);

  // Filter files based on search query
  const filteredFiles = useMemo(() => {
    const query = filter.search.trim().toLowerCase();
    const statuses = filter.status;
    return files.filter((file) => {
      const matchesQuery = !query || file.path.toLowerCase().includes(query);
      const matchesStatus = !statuses || statuses.includes(file.status);
      return matchesQuery && matchesStatus;
    });
  }, [files, filter]);

  const statusCounts = useMemo(() => {
    return files.reduce<Record<FileChange["status"], number>>(
      (acc, file) => {
        acc[file.status] = (acc[file.status] ?? 0) + 1;
        return acc;
      },
      { added: 0, modified: 0, deleted: 0, renamed: 0 }
    );
  }, [files]);

  // Selection mode: controlled (focusedPath provided) or uncontrolled (internal state)
  // When focusedPath is provided, it takes precedence over internal state
  const selectedFile = focusedPath ?? uncontrolledSelection;

  // Auto-select first file when list changes and nothing is selected (uncontrolled mode only)
  useEffect(() => {
    // Skip if controlled by focusedPath
    if (focusedPath !== undefined && focusedPath !== null) return;

    if (filteredFiles.length === 0) {
      if (uncontrolledSelection !== null) {
        setUncontrolledSelection(null);
      }
      return;
    }

    // Auto-select first file if nothing selected or current selection is invalid
    if (!uncontrolledSelection || !filteredFiles.some((file) => file.path === uncontrolledSelection)) {
      setUncontrolledSelection(filteredFiles[0]?.path ?? null);
    }
  }, [filteredFiles, uncontrolledSelection, focusedPath]);

  const handleFileSelect = useCallback((path: string) => {
    setUncontrolledSelection(path);
  }, []);

  const handleToggleExpand = useCallback((path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Build context menu actions object (file-level actions only for tree)
  const contextMenuActions = useMemo<FileTreeContextMenuActions | undefined>(() => {
    if (!onStageFile && !onUnstageFile && !onDiscardFile && !onCopyPath) {
      return undefined;
    }
    return {
      onStageFile,
      onUnstageFile,
      onDiscardFile,
      onCopyPath,
    };
  }, [onStageFile, onUnstageFile, onDiscardFile, onCopyPath]);

  const content = (
    <Flex flexGrow="1" overflow="hidden">
        {/* Left edge collapse strip / File Tree */}
        {showFileTree && (
          <>
            {treeVisible ? (
              <Box style={{ width: FILE_TREE_WIDTH, position: "relative", display: "flex", flexDirection: "column" }}>
                <Flex align="center" justify="between" px="2" py="1" style={{ borderBottom: "1px solid var(--gray-a5)" }}>
                  <CompactFileSearch
                    filter={filter}
                    onFilterChange={setFilter}
                    statusCounts={statusCounts}
                  />
                  <Tooltip content="Hide file tree">
                    <IconButton
                      size="1"
                      variant="ghost"
                      onClick={() => setTreeVisible(false)}
                    >
                      <ChevronLeftIcon />
                    </IconButton>
                  </Tooltip>
                </Flex>
                <FileTree
                  files={filteredFiles}
                  selectedFile={selectedFile}
                  onSelect={handleFileSelect}
                  largeFolderThreshold={largeFolderThreshold}
                  contextMenuActions={contextMenuActions}
                  focusedPath={focusedPath}
                  highlightQuery={filter.search}
                  pendingFiles={pendingFiles}
                />
              </Box>
            ) : (
              <Tooltip content="Show file tree">
                <Box
                  style={{
                    width: 20,
                    cursor: "pointer",
                    background: "var(--gray-a3)",
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "center",
                    paddingTop: 8,
                  }}
                  onClick={() => setTreeVisible(true)}
                >
                  <LayoutIcon width={12} height={12} />
                </Box>
              </Tooltip>
            )}
            <Separator orientation="vertical" size="4" />
          </>
        )}

        {/* Diff Stack (right panel) */}
        <Box flexGrow="1" overflow="hidden">
          <DiffStack
            files={filteredFiles}
            getDiff={getDiff}
            refreshId={refreshId}
            selectedFile={selectedFile}
            expandedFiles={expandedFiles}
            onToggleExpand={handleToggleExpand}
            largeDiffThreshold={largeDiffThreshold}
            onStageFile={onStageFile}
            onStageHunks={onStageHunks}
            onUnstageFile={onUnstageFile}
            onUnstageHunks={onUnstageHunks}
            onDiscardFile={onDiscardFile}
            editable={editable}
            onSaveEdit={onSaveEdit}
            partiallyStagedFiles={partiallyStagedFiles}
            focusedFile={focusedPath}
            theme={theme}
            diffType={diffType}
            diffKey={diffKey}
            showControls={showDiffControls}
            diffViewOptions={diffViewOptions}
            onDiffViewOptionsChange={onDiffViewOptionsChange}
          />
        </Box>
    </Flex>
  );

  // Wrap in collapsible if needed
  if (collapsible) {
    return (
      <Collapsible.Root
        open={!isCollapsed}
        onOpenChange={(open) => setIsCollapsed(!open)}
      >
        <Flex direction="column">
          {/* Header with collapse trigger */}
          <Collapsible.Trigger asChild>
            <Flex align="center" justify="between" p="2" style={{ cursor: "pointer" }}>
              <Flex align="center" gap="2">
                {isCollapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
                {title && <Text weight="medium">{title}</Text>}
                <Text size="1" color="gray">
                  {files.length} file{files.length !== 1 ? "s" : ""}
                </Text>
              </Flex>
              {summary && (
                <Flex align="center" gap="2" onClick={(e) => e.stopPropagation()}>
                  {summary}
                </Flex>
              )}
            </Flex>
          </Collapsible.Trigger>

          {/* Collapsible content */}
          <Collapsible.Content>{content}</Collapsible.Content>
        </Flex>
      </Collapsible.Root>
    );
  }

  // Non-collapsible version
  return (
    <Flex direction="column">
      {/* Header */}
      {(title || summary) && (
        <Flex align="center" justify="between" p="2">
          <Flex align="center" gap="2">
            {title && <Text weight="medium">{title}</Text>}
            <Text size="1" color="gray">
              {files.length} file{files.length !== 1 ? "s" : ""}
            </Text>
          </Flex>
          {summary}
        </Flex>
      )}

      {/* Main content */}
      {content}
    </Flex>
  );
}
