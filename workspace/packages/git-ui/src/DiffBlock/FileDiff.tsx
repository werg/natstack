import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { Box, Text, Flex, Button, Separator } from "@radix-ui/themes";
import { DiffEditorDirect } from "./DiffEditorDirect";
import { FileDiffHeader } from "./FileDiffHeader";
import { HunkHeader } from "./HunkHeader";
import { LineSelectionOverlay } from "./LineSelectionOverlay";
import { BinaryFileDiff } from "./BinaryFileDiff";
import { FileContentView } from "./FileContentView";
import { UnsavedChangesDialog } from "../UnsavedChangesDialog";
import { MonacoErrorBoundary } from "../MonacoErrorBoundary";
import { useHunkSelection } from "../hooks/useHunkSelection";
import type { DiffViewOptions, FileChange, FileDiff as FileDiffType, HunkSelection } from "./types";
import {
  MIN_EDITOR_HEIGHT,
  MAX_EDITOR_HEIGHT,
  EDITOR_LINE_HEIGHT_PX,
  FILE_EXTENSION_LANGUAGE_MAP,
  DEFAULT_DIFF_VIEW_OPTIONS,
} from "../constants";
import { computeDiffStats } from "../store/selectors";

interface FileDiffProps {
  file: FileChange;
  diff: FileDiffType;
  onStageFile?: (path: string) => void;
  onStageHunks?: (path: string, hunks: HunkSelection[]) => void;
  onUnstageFile?: (path: string) => void;
  onUnstageHunks?: (path: string, hunks: HunkSelection[]) => void;
  onDiscardFile?: (path: string) => void;
  editable: boolean;
  onSaveEdit?: (path: string, content: string) => Promise<void>;
  partiallyStaged?: boolean;
  theme?: "light" | "dark";
  diffViewOptions?: DiffViewOptions;
}

function getLanguageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return FILE_EXTENSION_LANGUAGE_MAP[ext || ""] || "plaintext";
}

export function FileDiff({
  file,
  diff,
  onStageFile,
  onStageHunks,
  onUnstageFile,
  onUnstageHunks,
  onDiscardFile,
  editable,
  onSaveEdit,
  partiallyStaged,
  theme,
  diffViewOptions,
}: FileDiffProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [pendingAction, setPendingAction] = useState<"cancel" | "discard" | null>(null);
  const isEditingRef = useRef(isEditing);

  // Use shared hook for hunk/line selection
  const {
    selectionMode,
    setSelectionMode,
    selectedHunks,
    hunkChangeIndices,
    toggleHunkSelection,
    toggleLineSelection,
    buildSelections,
    clearSelections,
  } = useHunkSelection({ hunks: diff.hunks, diffPath: diff.path });

  const canEdit = editable && file.status !== "deleted";
  // Track actual changes - not just whether we're in edit mode
  const hasUnsavedChanges = editedContent !== null && editedContent !== diff.newContent;
  const viewOptions: DiffViewOptions = diffViewOptions ?? DEFAULT_DIFF_VIEW_OPTIONS;

  useEffect(() => {
    isEditingRef.current = isEditing;
  }, [isEditing]);

  useEffect(() => {
    if (isEditing && editedContent === null) {
      setEditedContent(diff.newContent);
    }
  }, [isEditing, editedContent, diff.newContent]);

  const diffStats = useMemo(() => computeDiffStats(diff.hunks), [diff.hunks]);

  // Exit selection mode when entering edit mode
  useEffect(() => {
    if (isEditing && selectionMode) {
      setSelectionMode(false);
    }
  }, [isEditing, selectionMode, setSelectionMode]);

  const handleSave = useCallback(async () => {
    if (editedContent === null || !onSaveEdit || isSaving) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await onSaveEdit(file.path, editedContent);
      setIsEditing(false);
      setEditedContent(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      // Don't re-throw - error state is set and UI will display it
    } finally {
      setIsSaving(false);
    }
  }, [file.path, editedContent, onSaveEdit, isSaving]);

  const handleStageSelection = useCallback(() => {
    if (!onStageHunks) return;
    const selections = buildSelections();
    if (selections.length === 0) return;
    onStageHunks(file.path, selections);
    clearSelections();
  }, [onStageHunks, buildSelections, file.path, clearSelections]);

  const handleUnstageSelection = useCallback(() => {
    if (!onUnstageHunks) return;
    const selections = buildSelections();
    if (selections.length === 0) return;
    onUnstageHunks(file.path, selections);
    clearSelections();
  }, [onUnstageHunks, buildSelections, file.path, clearSelections]);

  const handleModifiedChange = useCallback((value: string | undefined) => {
    if (!isEditingRef.current) return;
    setEditedContent(value ?? null);
  }, []);

  const handleToggleEdit = useCallback(() => {
    if (isEditing && hasUnsavedChanges) {
      setPendingAction("cancel");
      setShowUnsavedDialog(true);
      return;
    }
    if (isEditing) {
      setIsEditing(false);
      setEditedContent(null);
    } else {
      setIsEditing(true);
      setEditedContent(diff.newContent);
    }
  }, [isEditing, hasUnsavedChanges, diff.newContent]);

  const handleDiscard = useCallback(() => {
    if (isEditing && hasUnsavedChanges) {
      setPendingAction("discard");
      setShowUnsavedDialog(true);
      return;
    }
    onDiscardFile?.(file.path);
  }, [isEditing, hasUnsavedChanges, file.path, onDiscardFile]);

  const handleDialogDiscard = useCallback(() => {
    setShowUnsavedDialog(false);
    if (pendingAction === "cancel") {
      setIsEditing(false);
      setEditedContent(null);
    } else if (pendingAction === "discard") {
      setIsEditing(false);
      setEditedContent(null);
      onDiscardFile?.(file.path);
    }
    setPendingAction(null);
  }, [pendingAction, file.path, onDiscardFile]);

  const handleDialogSave = useCallback(() => {
    setShowUnsavedDialog(false);
    // Save the user's edits - don't discard afterward even if pendingAction was "discard"
    // The user chose "Save" to preserve their work
    void handleSave();
    setPendingAction(null);
  }, [handleSave]);

  // Store keyboard-related values in a ref to avoid listener churn.
  // The listener is only added/removed when isEditing changes.
  const keyboardStateRef = useRef({ handleSave, handleToggleEdit, hasUnsavedChanges });
  useEffect(() => {
    keyboardStateRef.current = { handleSave, handleToggleEdit, hasUnsavedChanges };
  });

  useEffect(() => {
    if (!isEditing) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const { handleSave, handleToggleEdit, hasUnsavedChanges } = keyboardStateRef.current;
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        e.stopPropagation();
        if (hasUnsavedChanges) {
          void handleSave();
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handleToggleEdit();
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [isEditing]);

  const editorHeight = useMemo(() => {
    const lineCount = Math.max(
      diff.oldContent.split("\n").length,
      diff.newContent.split("\n").length
    );
    return Math.min(
      Math.max(lineCount * EDITOR_LINE_HEIGHT_PX, MIN_EDITOR_HEIGHT),
      MAX_EDITOR_HEIGHT
    );
  }, [diff]);

  // For unmodified files, show simple file viewer (no diff to display)
  if (file.status === "unmodified") {
    return (
      <FileContentView
        file={file}
        content={diff.newContent || diff.oldContent}
        theme={theme}
      />
    );
  }

  if (diff.binary) {
    return (
      <Box>
        <FileDiffHeader
          file={file}
          onStageFile={onStageFile}
          onUnstageFile={onUnstageFile}
          onDiscardFile={onDiscardFile}
          partiallyStaged={partiallyStaged}
        />
        <BinaryFileDiff diff={diff} />
      </Box>
    );
  }

  return (
    <Box>
      <FileDiffHeader
        file={file}
        onStageFile={onStageFile}
        onUnstageFile={onUnstageFile}
        onDiscardFile={onDiscardFile ? handleDiscard : undefined}
        stats={diffStats}
        editable={canEdit}
        isEditing={isEditing}
        onToggleEdit={handleToggleEdit}
        onSave={() => void handleSave()}
        hasChanges={hasUnsavedChanges}
        saving={isSaving}
        partiallyStaged={partiallyStaged}
        onToggleSelection={
          diff.hunks.length > 0 && (onStageHunks || onUnstageHunks)
            ? () => setSelectionMode((prev) => !prev)
            : undefined
        }
        selectionMode={selectionMode}
      />

      {selectionMode && (onStageHunks || onUnstageHunks) ? (
        <Box>
          <Flex align="center" gap="2" p="2">
            {onStageHunks && (
              <Button size="1" variant="soft" onClick={handleStageSelection} disabled={selectedHunks.size === 0}>
                Stage selected
              </Button>
            )}
            {onUnstageHunks && (
              <Button size="1" variant="soft" onClick={handleUnstageSelection} disabled={selectedHunks.size === 0}>
                Unstage selected
              </Button>
            )}
            <Button size="1" variant="ghost" onClick={clearSelections} disabled={selectedHunks.size === 0}>
              Clear
            </Button>
          </Flex>
          {diff.hunks.map((hunk, hunkIndex) => {
            const selection = selectedHunks.get(hunkIndex);
            const changeIndices = hunkChangeIndices[hunkIndex] ?? [];
            const selectedCount = selection === null ? changeIndices.length : selection?.size ?? 0;
            const indeterminate = selectedCount > 0 && selectedCount < changeIndices.length;
            const additions = hunk.lines.filter((line) => line.type === "add").length;
            const deletions = hunk.lines.filter((line) => line.type === "delete").length;

            return (
              <Box key={hunk.header}>
                <Separator size="4" />
                <HunkHeader
                  hunk={hunk}
                  selected={selectedCount === changeIndices.length && changeIndices.length > 0}
                  indeterminate={indeterminate}
                  additions={additions}
                  deletions={deletions}
                  onToggle={() => toggleHunkSelection(hunkIndex)}
                  onStage={onStageHunks ? () => onStageHunks(file.path, [{ hunkIndex }]) : undefined}
                  onUnstage={onUnstageHunks ? () => onUnstageHunks(file.path, [{ hunkIndex }]) : undefined}
                />
                <LineSelectionOverlay
                  hunk={hunk}
                  hunkIndex={hunkIndex}
                  selectedLines={selection}
                  onToggleLine={toggleLineSelection}
                />
              </Box>
            );
          })}
        </Box>
      ) : (
        <Box style={{ height: editorHeight }}>
          <MonacoErrorBoundary fallbackHeight={Math.max(editorHeight, MIN_EDITOR_HEIGHT)}>
            <>
              <DiffEditorDirect
                original={diff.oldContent}
                modified={isEditing ? editedContent ?? diff.newContent : diff.newContent}
                language={getLanguageFromPath(file.path)}
                theme={theme === "dark" ? "vs-dark" : "light"}
                onModifiedChange={isEditing ? handleModifiedChange : undefined}
                options={{
                  readOnly: !isEditing,
                  originalEditable: false,
                  minimap: { enabled: false },
                  scrollbar: { verticalScrollbarSize: 6 },
                  overviewRulerLanes: 2,
                  lineNumbers: "on",
                  scrollBeyondLastLine: false,
                  renderSideBySide: viewOptions.viewMode === "split",
                  enableSplitViewResizing: true,
                  diffAlgorithm: viewOptions.wordDiff ? "advanced" : "legacy",
                  renderWhitespace: viewOptions.showWhitespace ? "all" : "none",
                  ignoreTrimWhitespace: !viewOptions.showWhitespace,
                  hideUnchangedRegions: {
                    enabled: true,
                    contextLineCount: viewOptions.contextLines,
                    minimumLineCount: 2,
                    revealLineCount: 4,
                  },
                }}
              />
              {isEditing && (
                <Box p="1">
                  <Text size="1" color="gray">
                    Ctrl+S to save · ESC to exit
                  </Text>
                </Box>
              )}
            </>
          </MonacoErrorBoundary>
        </Box>
      )}

      {saveError && (
        <Box p="2">
          <Text size="1" color="red">
            Failed to save: {saveError}
          </Text>
        </Box>
      )}

      <UnsavedChangesDialog
        open={showUnsavedDialog}
        onOpenChange={setShowUnsavedDialog}
        onDiscard={handleDialogDiscard}
        onSave={hasUnsavedChanges ? handleDialogSave : undefined}
      />
    </Box>
  );
}
