import { useCallback, useEffect, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Box, Flex, ScrollArea, Button, Callout } from "@radix-ui/themes";
import * as Accordion from "@radix-ui/react-accordion";
import { ChevronDownIcon } from "@radix-ui/react-icons";
import type { GitClient, FsPromisesLike, HunkSelection } from "@natstack/git";

import { DiffBlock } from "./DiffBlock";
import { GitStatusHeader } from "./GitStatusHeader";
import { FileOverview } from "./FileOverview";
import { CommitHistory } from "./CommitHistory";
import { StashSection } from "./StashSection";
import { StashDropConfirmDialog } from "./StashDropConfirmDialog";
import { DiscardConfirmDialog } from "./DiscardConfirmDialog";
import { UnstageConfirmDialog } from "./UnstageConfirmDialog";
import { ConflictResolutionView } from "./ConflictResolutionView";
import { LoadingState } from "./LoadingState";
import { useDiffViewOptions } from "./hooks/useDiffViewOptions";
import { useKeyboardNavigation } from "./hooks/useKeyboardNavigation";
import { useConflicts } from "./hooks/useConflicts";
import { REFRESH_INTERVAL_MS, MIN_REFRESH_AGE_MS } from "./constants";
import {
  branchAtom,
  loadingAtom,
  errorAtom,
  actionLoadingAtom,
  stashesAtom,
  stashActionLoadingAtom,
  commitsAtom,
  commitsHasMoreAtom,
  historyLoadingAtom,
  discardPathAtom,
  showUnstageConfirmAtom,
  dropStashIndexAtom,
  focusedSectionAtom,
  focusedIndexAtom,
  stagedFilesAtom,
  unstagedFilesAtom,
  partiallyStagedFilesAtom,
  hasStagedAtom,
  hasChangesAtom,
  focusedPathAtom,
  refreshStatusAtom,
  manualRefreshAtom,
  loadMoreHistoryAtom,
  stageFileAtom,
  stageHunksAtom,
  stageAllAtom,
  unstageFileAtom,
  unstageHunksAtom,
  unstageAllAtom,
  discardFileAtom,
  saveFileAtom,
  commitAtom,
  dropStashAtom,
  fetchDiffAtom,
  initializeStoreAtom,
  cleanupStoreAtom,
} from "./store";
import type { GitNotification, FileDiff } from "./store";

export type { GitNotification };

export interface GitStatusViewProps {
  dir: string;
  fs: FsPromisesLike;
  gitClient: GitClient;
  onCommitSuccess?: (sha: string) => void;
  onClose?: () => void;
  /** Callback for action notifications (stage, unstage, commit, etc.) */
  onNotify?: (notification: GitNotification) => void;
  /** Theme for Monaco editor in diff views */
  theme?: "light" | "dark";
}

/**
 * Main Git status view with accordion sections for unstaged, staged, and history
 */
export function GitStatusView({
  dir,
  fs,
  gitClient,
  onCommitSuccess,
  onClose,
  onNotify,
  theme,
}: GitStatusViewProps) {
  // Container ref for scoped keyboard handling
  const containerRef = useRef<HTMLDivElement>(null);
  const commitInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [diffViewOptions, setDiffViewOptions] = useDiffViewOptions();

  // Initialize store
  // Use refs to avoid dependency on unstable callbacks and handle StrictMode correctly.
  const initialize = useSetAtom(initializeStoreAtom);
  const cleanup = useSetAtom(cleanupStoreAtom);
  const onNotifyRef = useRef(onNotify);

  // Keep onNotify ref up to date without triggering re-initialization
  useEffect(() => {
    onNotifyRef.current = onNotify;
  }, [onNotify]);

  useEffect(() => {
    // Track if this effect instance is still active (handles StrictMode double-invoke)
    let isActive = true;

    // Wrapper that checks if still mounted before forwarding notifications
    const safeNotify = (notification: GitNotification) => {
      if (isActive && onNotifyRef.current) {
        onNotifyRef.current(notification);
      }
    };

    void initialize({ dir, fs, gitClient, onNotify: safeNotify });

    return () => {
      isActive = false;
      cleanup();
    };
  }, [dir, fs, gitClient, initialize, cleanup]);

  // Read state from atoms
  const branch = useAtomValue(branchAtom);
  const loading = useAtomValue(loadingAtom);
  const error = useAtomValue(errorAtom);
  const actionLoading = useAtomValue(actionLoadingAtom);
  const stagedFiles = useAtomValue(stagedFilesAtom);
  const unstagedFiles = useAtomValue(unstagedFilesAtom);
  const partiallyStagedFiles = useAtomValue(partiallyStagedFilesAtom);
  const hasStaged = useAtomValue(hasStagedAtom);
  const hasChanges = useAtomValue(hasChangesAtom);
  const stashes = useAtomValue(stashesAtom);
  const stashActionLoading = useAtomValue(stashActionLoadingAtom);
  const commits = useAtomValue(commitsAtom);
  const historyLoading = useAtomValue(historyLoadingAtom);
  const hasMore = useAtomValue(commitsHasMoreAtom);
  const focusedSection = useAtomValue(focusedSectionAtom);
  const focusedPath = useAtomValue(focusedPathAtom);
  const setFocusedSection = useSetAtom(focusedSectionAtom);
  const setFocusedIndex = useSetAtom(focusedIndexAtom);

  // Conflicts (managed in local hook, not global store)
  const { conflicts } = useConflicts();

  // Dialog state (managed via atoms for coordination with keyboard shortcuts)
  const [discardPath, setDiscardPath] = useAtom(discardPathAtom);
  const [showUnstageConfirm, setShowUnstageConfirm] = useAtom(showUnstageConfirmAtom);
  const [dropStashIndex, setDropStashIndex] = useAtom(dropStashIndexAtom);

  // File selection state for FileOverview -> Accordion coordination
  const [overviewSelectedFile, setOverviewSelectedFile] = useState<string | null>(null);
  const [overviewSelectedSection, setOverviewSelectedSection] = useState<"staged" | "unstaged">("unstaged");
  const [accordionValue, setAccordionValue] = useState<string[]>([]);

  // Handle file selection from FileOverview - expands the accordion section
  const handleOverviewSelectFile = useCallback(
    (path: string, section: "staged" | "unstaged") => {
      setOverviewSelectedFile(path);
      setOverviewSelectedSection(section);
      // Keep keyboard focus in sync with overview selection.
      const files = section === "staged" ? stagedFiles : unstagedFiles;
      const index = Math.max(0, files.findIndex((file) => file.path === path));
      setFocusedSection(section);
      setFocusedIndex(index);
      // Expand the relevant accordion section
      setAccordionValue((prev) => {
        if (prev.includes(section)) return prev;
        return [...prev, section];
      });
    },
    [stagedFiles, unstagedFiles, setFocusedSection, setFocusedIndex]
  );

  // Handle unstage all with confirmation
  const handleUnstageAll = useCallback(() => {
    setShowUnstageConfirm(true);
  }, [setShowUnstageConfirm]);

  // Actions
  const refresh = useSetAtom(refreshStatusAtom);
  const manualRefresh = useSetAtom(manualRefreshAtom);
  const loadMore = useSetAtom(loadMoreHistoryAtom);
  const stageFile = useSetAtom(stageFileAtom);
  const stageHunks = useSetAtom(stageHunksAtom);
  const stageAll = useSetAtom(stageAllAtom);
  const unstageFile = useSetAtom(unstageFileAtom);
  const unstageHunks = useSetAtom(unstageHunksAtom);
  const unstageAll = useSetAtom(unstageAllAtom);
  const discardFile = useSetAtom(discardFileAtom);
  const saveFile = useSetAtom(saveFileAtom);
  const commit = useSetAtom(commitAtom);
  const dropStash = useSetAtom(dropStashAtom);
  const fetchDiff = useSetAtom(fetchDiffAtom);

  // Event handlers for keyboard navigation
  const handleStageFile = useCallback(
    (path: string) => void stageFile(path),
    [stageFile]
  );

  const handleUnstageFile = useCallback(
    (path: string) => void unstageFile(path),
    [unstageFile]
  );

  const handleFocusCommit = useCallback(() => {
    commitInputRef.current?.focus();
  }, []);

  // Keyboard navigation hook
  useKeyboardNavigation({
    containerRef,
    onStageFile: handleStageFile,
    onUnstageFile: handleUnstageFile,
    onFocusCommit: handleFocusCommit,
    onNotify,
  });

  // Polling and refresh
  useEffect(() => {
    const interval = setInterval(() => {
      void refresh({ type: "interval", minAge: MIN_REFRESH_AGE_MS });
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    const handleFocus = () => void refresh({ type: "focus-gained" });
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refresh]);

  // Diff fetchers for DiffBlock components
  const getWorkingDiff = useCallback(
    async (path: string, options?: { force?: boolean }): Promise<FileDiff | null> => {
      const result = await fetchDiff("working", path, options);
      return result ?? null;
    },
    [fetchDiff]
  );

  const getStagedDiff = useCallback(
    async (path: string, options?: { force?: boolean }): Promise<FileDiff | null> => {
      const result = await fetchDiff("staged", path, options);
      return result ?? null;
    },
    [fetchDiff]
  );

  const getCommitDiff = useCallback(
    async (sha: string, path: string, options?: { force?: boolean }): Promise<FileDiff | null> => {
      const result = await fetchDiff("commit", path, { ...options, sha });
      return result ?? null;
    },
    [fetchDiff]
  );

  const getCommitFiles = useCallback(
    (sha: string) => gitClient.getCommitFiles(dir, sha),
    [dir, gitClient]
  );

  // Action handlers
  const handleStageHunks = useCallback(
    (path: string, hunks: HunkSelection[]) => void stageHunks({ path, hunks }),
    [stageHunks]
  );

  const handleUnstageHunks = useCallback(
    (path: string, hunks: HunkSelection[]) => void unstageHunks({ path, hunks }),
    [unstageHunks]
  );

  const handleStageAll = useCallback(async () => {
    await stageAll(unstagedFiles.map((f) => f.path));
  }, [unstagedFiles, stageAll]);

  const handleUnstageAllConfirm = useCallback(async () => {
    await unstageAll(stagedFiles.map((f) => f.path));
    setShowUnstageConfirm(false);
  }, [stagedFiles, unstageAll, setShowUnstageConfirm]);

  const handleCopyPath = useCallback(
    (path: string) => {
      if (!navigator.clipboard?.writeText) {
        onNotify?.({ type: "error", title: "Clipboard not available" });
        return;
      }
      void navigator.clipboard
        .writeText(path)
        .then(() => onNotify?.({ type: "info", title: "Copied path", description: path }))
        .catch(() => onNotify?.({ type: "error", title: "Failed to copy path" }));
    },
    [onNotify]
  );

  const handleCommit = useCallback(
    async (message: string) => {
      const sha = await commit(message);
      onCommitSuccess?.(sha);
    },
    [commit, onCommitSuccess]
  );

  const handleDiscardConfirm = useCallback(async () => {
    if (discardPath) {
      await discardFile(discardPath);
      setDiscardPath(null);
    }
  }, [discardPath, discardFile, setDiscardPath]);

  const handleDropStashConfirm = useCallback(() => {
    if (dropStashIndex === null) return;
    void dropStash(dropStashIndex)
      .then(() => setDropStashIndex(null))
      .catch(() => setDropStashIndex(null));
  }, [dropStashIndex, dropStash, setDropStashIndex]);

  const dropTarget = dropStashIndex !== null
    ? stashes.find((s) => s.index === dropStashIndex) ?? null
    : null;

  // Loading state
  if (loading && !branch) {
    return <LoadingState size="3" fullHeight />;
  }

  // Error state
  if (error) {
    return (
      <Box p="4">
        <Callout.Root color="red">
          <Callout.Text>Failed to load git status: {error.message}</Callout.Text>
        </Callout.Root>
        <Button size="1" variant="soft" onClick={() => manualRefresh()} mt="2">
          Retry
        </Button>
      </Box>
    );
  }

  return (
    <Flex
      ref={containerRef}
      direction="column"
      height="100%"
      minHeight="0"
      style={{ outline: "none" }}
      tabIndex={0}
      role="application"
      aria-label="Git status manager"
    >
      <GitStatusHeader
        branch={branch}
        onClose={onClose}
        hasStaged={hasStaged}
        loading={actionLoading}
        onRefresh={() => manualRefresh()}
        diffViewOptions={diffViewOptions}
        onDiffViewOptionsChange={setDiffViewOptions}
      />

      {/* File Overview with side-by-side staged/unstaged trees */}
      {(unstagedFiles.length > 0 || stagedFiles.length > 0) && (
        <FileOverview
          stagedFiles={stagedFiles}
          unstagedFiles={unstagedFiles}
          partiallyStagedFiles={partiallyStagedFiles}
          onStageFile={handleStageFile}
          onUnstageFile={handleUnstageFile}
          onStageAll={handleStageAll}
          onUnstageAll={handleUnstageAll}
          onCommit={handleCommit}
          hasStaged={hasStaged}
          commitLoading={actionLoading}
          commitInputRef={commitInputRef}
          onSelectFile={handleOverviewSelectFile}
          selectedFile={overviewSelectedFile}
          selectedSection={overviewSelectedSection}
          actionLoading={actionLoading}
        />
      )}

      <Box flexGrow="1" overflow="hidden">
        <ScrollArea>
          <Box px="1" pb="1">
          <Accordion.Root
            type="multiple"
            value={accordionValue}
            onValueChange={setAccordionValue}
          >
            {/* Unstaged Changes - only show if there are unstaged files */}
            {unstagedFiles.length > 0 && (
              <AccordionItem value="unstaged">
                <AccordionTrigger
                  action={
                    <Button
                      size="1"
                      variant="soft"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleStageAll();
                      }}
                      disabled={actionLoading}
                    >
                      Stage All
                    </Button>
                  }
                >
                  Unstaged ({unstagedFiles.length})
                </AccordionTrigger>
                <AccordionContent>
                  <DiffBlock
                    files={unstagedFiles}
                    getDiff={getWorkingDiff}
                    editable
                    onStageFile={handleStageFile}
                    onStageHunks={handleStageHunks}
                    onDiscardFile={(path) => setDiscardPath(path)}
                    onSaveEdit={saveFile}
                    onCopyPath={handleCopyPath}
                    focusedPath={focusedSection === "unstaged" ? focusedPath : null}
                    partiallyStagedFiles={partiallyStagedFiles}
                    theme={theme}
                    diffType="working"
                    showDiffControls={false}
                    diffViewOptions={diffViewOptions}
                  />
                </AccordionContent>
              </AccordionItem>
            )}

            {/* Staged Changes - only show if there are staged files */}
            {stagedFiles.length > 0 && (
              <AccordionItem value="staged">
                <AccordionTrigger
                  action={
                    <Button
                      size="1"
                      variant="soft"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowUnstageConfirm(true);
                      }}
                      disabled={actionLoading}
                    >
                      Unstage All
                    </Button>
                  }
                >
                  Staged ({stagedFiles.length})
                </AccordionTrigger>
                <AccordionContent>
                  <DiffBlock
                    files={stagedFiles}
                    getDiff={getStagedDiff}
                    onUnstageFile={handleUnstageFile}
                    onUnstageHunks={handleUnstageHunks}
                    onCopyPath={handleCopyPath}
                    focusedPath={focusedSection === "staged" ? focusedPath : null}
                    partiallyStagedFiles={partiallyStagedFiles}
                    theme={theme}
                    diffType="staged"
                    showDiffControls={false}
                    diffViewOptions={diffViewOptions}
                  />
                </AccordionContent>
              </AccordionItem>
            )}

            {/* Stashes - show if there are stashes OR changes that could be stashed */}
            {(stashes.length > 0 || hasChanges) && (
              <AccordionItem value="stashes">
                <AccordionTrigger>Stashes ({stashes.length})</AccordionTrigger>
                <AccordionContent>
                  <StashSection />
                </AccordionContent>
              </AccordionItem>
            )}

            {/* Conflicts - only show if there are conflicts */}
            {conflicts.length > 0 && (
              <AccordionItem value="conflicts">
                <AccordionTrigger>Conflicts ({conflicts.length})</AccordionTrigger>
                <AccordionContent>
                  <ConflictResolutionView theme={theme} />
                </AccordionContent>
              </AccordionItem>
            )}

            {/* History - always show */}
            <AccordionItem value="history">
              <AccordionTrigger>Recent Commits</AccordionTrigger>
              <AccordionContent>
                <CommitHistory
                  commits={commits}
                  loading={historyLoading}
                  hasMore={hasMore}
                  onLoadMore={() => loadMore()}
                  getCommitFiles={getCommitFiles}
                  getCommitDiff={getCommitDiff}
                  theme={theme}
                  showDiffControls={false}
                  diffViewOptions={diffViewOptions}
                />
              </AccordionContent>
            </AccordionItem>
          </Accordion.Root>
          </Box>
        </ScrollArea>
      </Box>

      {/* Dialogs */}
      <DiscardConfirmDialog
        open={discardPath !== null}
        onOpenChange={(open) => !open && setDiscardPath(null)}
        filePath={discardPath ?? ""}
        onConfirm={() => void handleDiscardConfirm()}
        loading={actionLoading}
      />

      <UnstageConfirmDialog
        open={showUnstageConfirm}
        onOpenChange={setShowUnstageConfirm}
        fileCount={stagedFiles.length}
        onConfirm={() => void handleUnstageAllConfirm()}
        loading={actionLoading}
      />

      {dropTarget && (
        <StashDropConfirmDialog
          open={dropStashIndex !== null}
          onOpenChange={(open) => !open && setDropStashIndex(null)}
          stashRef={dropTarget.ref}
          stashMessage={dropTarget.message}
          onConfirm={handleDropStashConfirm}
          loading={stashActionLoading}
        />
      )}
    </Flex>
  );
}

// Accordion styled components

/** Minimal accordion item without Card wrapper */
function AccordionItem({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <Accordion.Item value={value} style={{ borderBottom: "1px solid var(--gray-a5)" }}>
      {children}
    </Accordion.Item>
  );
}

function AccordionTrigger({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Accordion.Header>
      <Flex align="center" justify="between" py="1" px="2" gap="2">
        <Accordion.Trigger asChild>
          <Button
            variant="ghost"
            size="1"
            className="accordion-trigger"
          >
            <ChevronDownIcon
              aria-hidden
              style={{ transition: "transform 150ms ease-out" }}
              className="accordion-chevron"
            />
            {children}
          </Button>
        </Accordion.Trigger>
        <Box flexGrow="1" />
        {action}
      </Flex>
    </Accordion.Header>
  );
}

function AccordionContent({ children }: { children: React.ReactNode }) {
  return <Accordion.Content role="region">{children}</Accordion.Content>;
}
