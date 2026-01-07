import { useState, useMemo, useCallback, useRef, type RefObject } from "react";
import { Box, Button, Callout, Card, Flex, IconButton, Text, TextArea, Badge, ScrollArea, Separator, Tooltip, Kbd } from "@radix-ui/themes";
import * as Collapsible from "@radix-ui/react-collapsible";
import {
  ChevronRightIcon,
  ChevronDownIcon,
  FileIcon,
  PlusIcon,
  MinusIcon,
  DoubleArrowRightIcon,
  DoubleArrowLeftIcon,
  InfoCircledIcon,
  CheckCircledIcon,
} from "@radix-ui/react-icons";
import type { FileChange } from "./DiffBlock/types";
import { STATUS_LABELS, STATUS_COLORS } from "./DiffBlock/types";
import { buildTree, type TreeNode } from "./utils";

// Drag data type for file transfers between panels
const DRAG_TYPE = "application/x-git-file-path";

export interface FileOverviewProps {
  // File data
  stagedFiles: FileChange[];
  unstagedFiles: FileChange[];
  partiallyStagedFiles: Set<string>;

  // Stage/unstage actions
  onStageFile: (path: string) => void;
  onUnstageFile: (path: string) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;

  // Commit
  onCommit: (message: string) => Promise<void>;
  hasStaged: boolean;
  commitLoading?: boolean;
  commitInputRef?: RefObject<HTMLTextAreaElement | null>;

  // File selection (triggers diff expansion below)
  onSelectFile: (path: string, section: "staged" | "unstaged") => void;
  selectedFile?: string | null;
  selectedSection?: "staged" | "unstaged";

  // Loading states
  actionLoading?: boolean;
}

interface OverviewTreeProps {
  files: FileChange[];
  selectedFile: string | null;
  onSelect: (path: string) => void;
  onAction: (path: string) => void;
  actionIcon: "plus" | "minus";
  partiallyStagedFiles: Set<string>;
  actionLoading?: boolean;
  /** Which section this tree is in (for drag source identification) */
  section: "staged" | "unstaged";
}

function OverviewTreeNode({
  node,
  depth,
  selectedFile,
  onSelect,
  onAction,
  actionIcon,
  partiallyStagedFiles,
  actionLoading,
  section,
}: {
  node: TreeNode;
  depth: number;
  selectedFile: string | null;
  onSelect: (path: string) => void;
  onAction: (path: string) => void;
  actionIcon: "plus" | "minus";
  partiallyStagedFiles: Set<string>;
  actionLoading?: boolean;
  section: "staged" | "unstaged";
}) {
  const [expanded, setExpanded] = useState(true);

  const handleDragStart = useCallback(
    (e: React.DragEvent, path: string) => {
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ path, section }));
      e.dataTransfer.effectAllowed = "move";
    },
    [section]
  );

  if (node.isDirectory) {
    return (
      <Collapsible.Root open={expanded} onOpenChange={setExpanded}>
        <Flex
          align="center"
          minHeight="22px"
          style={{ paddingLeft: depth * 12 }}
        >
          <Collapsible.Trigger asChild>
            <Flex align="center" gap="1" flexGrow="1" style={{ cursor: "pointer" }}>
              {expanded ? (
                <ChevronDownIcon width={12} height={12} />
              ) : (
                <ChevronRightIcon width={12} height={12} />
              )}
              <Text size="1" color="gray">
                {node.name}/
              </Text>
            </Flex>
          </Collapsible.Trigger>
        </Flex>
        <Collapsible.Content>
          {node.children.map((child) => (
            <OverviewTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedFile={selectedFile}
              onSelect={onSelect}
              onAction={onAction}
              actionIcon={actionIcon}
              partiallyStagedFiles={partiallyStagedFiles}
              actionLoading={actionLoading}
              section={section}
            />
          ))}
        </Collapsible.Content>
      </Collapsible.Root>
    );
  }

  // File node
  const isSelected = selectedFile === node.path;
  const isPartiallyStaged = partiallyStagedFiles.has(node.path);

  return (
    <Flex
      align="center"
      gap="1"
      minHeight="22px"
      draggable
      onDragStart={(e) => handleDragStart(e, node.path)}
      style={{
        paddingLeft: depth * 12,
        background: isSelected ? "var(--accent-a3)" : undefined,
        borderRadius: "var(--radius-1)",
        cursor: "grab",
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        onAction(node.path);
      }}
    >
      <Flex
        align="center"
        gap="1"
        flexGrow="1"
        py="1"
        px="1"
        onClick={() => onSelect(node.path)}
      >
        <Box flexShrink="0">
          <FileIcon width={12} height={12} />
        </Box>
        <Box flexGrow="1" minWidth="0">
          <Text size="1" truncate>
            {node.name}
          </Text>
        </Box>
        <Badge size="1" variant="soft" color={STATUS_COLORS[node.file?.status ?? "modified"]}>
          {STATUS_LABELS[node.file?.status ?? "modified"]}
        </Badge>
        {isPartiallyStaged && (
          <Badge size="1" variant="outline" color="yellow" title="Partially staged">
            ½
          </Badge>
        )}
      </Flex>
      <Tooltip content={actionIcon === "plus" ? "Stage file" : "Unstage file"}>
        <IconButton
          size="1"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            onAction(node.path);
          }}
          disabled={actionLoading}
          aria-label={actionIcon === "plus" ? "Stage file" : "Unstage file"}
        >
          {actionIcon === "plus" ? <PlusIcon /> : <MinusIcon />}
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

function OverviewTree({
  files,
  selectedFile,
  onSelect,
  onAction,
  actionIcon,
  partiallyStagedFiles,
  actionLoading,
  section,
}: OverviewTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);

  if (files.length === 0) {
    return (
      <Callout.Root size="1" color={section === "staged" ? "green" : "gray"} variant="soft">
        <Callout.Icon>
          {section === "staged" ? <CheckCircledIcon /> : <InfoCircledIcon />}
        </Callout.Icon>
        <Callout.Text>
          {section === "staged"
            ? "No staged changes. Use + to stage files."
            : "Working tree clean"}
        </Callout.Text>
      </Callout.Root>
    );
  }

  return (
    <Flex direction="column" gap="0">
      {tree.children.map((node) => (
        <OverviewTreeNode
          key={node.path}
          node={node}
          depth={0}
          selectedFile={selectedFile}
          onSelect={onSelect}
          onAction={onAction}
          actionIcon={actionIcon}
          partiallyStagedFiles={partiallyStagedFiles}
          actionLoading={actionLoading}
          section={section}
        />
      ))}
    </Flex>
  );
}

export function FileOverview({
  stagedFiles,
  unstagedFiles,
  partiallyStagedFiles,
  onStageFile,
  onUnstageFile,
  onStageAll,
  onUnstageAll,
  onCommit,
  hasStaged,
  commitLoading,
  commitInputRef,
  onSelectFile,
  selectedFile,
  selectedSection,
  actionLoading,
}: FileOverviewProps) {
  const [commitMessage, setCommitMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const setTextareaRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node;
      if (commitInputRef) {
        commitInputRef.current = node;
      }
    },
    [commitInputRef]
  );
  const [dragOverPanel, setDragOverPanel] = useState<"staged" | "unstaged" | null>(null);

  const handleCommit = useCallback(async () => {
    const message = commitMessage.trim();
    if (!message || !hasStaged || commitLoading) return;

    setCommitError(null);
    try {
      await onCommit(message);
      setCommitMessage("");
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : String(err));
    }
  }, [commitMessage, hasStaged, commitLoading, onCommit]);

  // Keyboard shortcut: Ctrl/Cmd+Enter to commit
  const handleCommitKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void handleCommit();
      }
    },
    [handleCommit]
  );

  const handleUnstagedSelect = useCallback(
    (path: string) => onSelectFile(path, "unstaged"),
    [onSelectFile]
  );

  const handleStagedSelect = useCallback(
    (path: string) => onSelectFile(path, "staged"),
    [onSelectFile]
  );

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent, panel: "staged" | "unstaged") => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverPanel(panel);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverPanel(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetPanel: "staged" | "unstaged") => {
      e.preventDefault();
      setDragOverPanel(null);

      const data = e.dataTransfer.getData(DRAG_TYPE);
      if (!data) return;

      try {
        const { path, section } = JSON.parse(data) as { path: string; section: "staged" | "unstaged" };
        // Only act if dropping in a different panel
        if (section !== targetPanel) {
          if (targetPanel === "staged") {
            onStageFile(path);
          } else {
            onUnstageFile(path);
          }
        }
      } catch {
        // Invalid drag data
      }
    },
    [onStageFile, onUnstageFile]
  );

  return (
    <Flex direction="column">
      <Flex direction="column" gap="2" px="2" pt="2" pb="2">
        {/* Commit Row */}
      <Flex align="start" gap="2">
        <TextArea
          ref={setTextareaRef}
          size="2"
          placeholder="Commit message..."
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          onKeyDown={handleCommitKeyDown}
          disabled={commitLoading}
          style={{
            flex: 1,
            minHeight: 36,
            maxHeight: 120,
            resize: "vertical",
            fieldSizing: "content",
          }}
        />
        <Tooltip content={<Flex align="center" gap="2">Commit changes <Kbd size="1">⌘</Kbd><Kbd size="1">↵</Kbd></Flex>}>
          <Button
            size="2"
            onClick={() => void handleCommit()}
            disabled={!hasStaged || !commitMessage.trim() || commitLoading}
            loading={commitLoading}
            style={{ alignSelf: "flex-start" }}
          >
            Commit
          </Button>
        </Tooltip>
      </Flex>
      {commitError && (
        <Text size="1" color="red">
          {commitError}
        </Text>
      )}
      {!commitMessage.trim() && hasStaged && (
        <Text size="1" color="amber">
          Enter a commit message
        </Text>
      )}

      {/* Side-by-side file panels (responsive: stacks on narrow viewports) */}
      <Box
        className="file-overview-panels"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "var(--space-2)",
          minHeight: 120,
          maxHeight: 300,
        }}
      >
        {/* Unstaged Panel */}
        <Card
          size="1"
          onDragOver={(e) => handleDragOver(e, "unstaged")}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, "unstaged")}
          style={{
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            outline: dragOverPanel === "unstaged" ? "2px dashed var(--accent-9)" : undefined,
            background: dragOverPanel === "unstaged" ? "var(--accent-a2)" : undefined,
            transition: "outline 0.15s, background 0.15s",
          }}
        >
          <Flex align="center" justify="between" px="2" py="1">
            <Flex align="center" gap="2">
              <Text size="1" weight="medium">
                Unstaged
              </Text>
              <Badge size="1" variant="soft" color="gray">
                {unstagedFiles.length}
              </Badge>
            </Flex>
            {unstagedFiles.length > 0 && (
              <Tooltip content={<Flex align="center" gap="2">Stage all files <Kbd>s</Kbd></Flex>}>
                <Button
                  size="1"
                  variant="ghost"
                  onClick={onStageAll}
                  disabled={actionLoading}
                >
                  <DoubleArrowRightIcon />
                  Stage All
                </Button>
              </Tooltip>
            )}
          </Flex>
          <Separator size="4" />
          <Box flexGrow="1" overflow="hidden">
            <ScrollArea>
              <Box p="1">
                <OverviewTree
                  files={unstagedFiles}
                  selectedFile={selectedSection === "unstaged" ? selectedFile ?? null : null}
                  onSelect={handleUnstagedSelect}
                  onAction={onStageFile}
                  actionIcon="plus"
                  partiallyStagedFiles={partiallyStagedFiles}
                  actionLoading={actionLoading}
                  section="unstaged"
                />
              </Box>
            </ScrollArea>
          </Box>
        </Card>

        {/* Staged Panel */}
        <Card
          size="1"
          onDragOver={(e) => handleDragOver(e, "staged")}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, "staged")}
          style={{
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            outline: dragOverPanel === "staged" ? "2px dashed var(--accent-9)" : undefined,
            background: dragOverPanel === "staged" ? "var(--accent-a2)" : undefined,
            transition: "outline 0.15s, background 0.15s",
          }}
        >
          <Flex align="center" justify="between" px="2" py="1">
            <Flex align="center" gap="2">
              <Text size="1" weight="medium">
                Staged
              </Text>
              <Badge size="1" variant="soft" color={stagedFiles.length > 0 ? "green" : "gray"}>
                {stagedFiles.length}
              </Badge>
            </Flex>
            {stagedFiles.length > 0 && (
              <Tooltip content={<Flex align="center" gap="2">Unstage all files <Kbd>u</Kbd></Flex>}>
                <Button
                  size="1"
                  variant="ghost"
                  onClick={onUnstageAll}
                  disabled={actionLoading}
                >
                  <DoubleArrowLeftIcon />
                  Unstage All
                </Button>
              </Tooltip>
            )}
          </Flex>
          <Separator size="4" />
          <Box flexGrow="1" overflow="hidden">
            <ScrollArea>
              <Box p="1">
                <OverviewTree
                  files={stagedFiles}
                  selectedFile={selectedSection === "staged" ? selectedFile ?? null : null}
                  onSelect={handleStagedSelect}
                  onAction={onUnstageFile}
                  actionIcon="minus"
                  partiallyStagedFiles={partiallyStagedFiles}
                  actionLoading={actionLoading}
                  section="staged"
                />
              </Box>
            </ScrollArea>
          </Box>
        </Card>
      </Box>
      </Flex>

      {/* Separator below file overview - outside padded area for flush alignment */}
      <Separator size="4" />
    </Flex>
  );
}
