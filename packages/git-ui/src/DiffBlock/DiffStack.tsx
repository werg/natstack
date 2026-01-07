import React, { useRef, useEffect, useCallback } from "react";
import { useAtomValue } from "jotai";
import { Box, Callout, Flex, Text, Separator, Button, Spinner, Card } from "@radix-ui/themes";
import { ExclamationTriangleIcon, ReloadIcon, CheckCircledIcon } from "@radix-ui/react-icons";
import type { HunkSelection } from "@natstack/git";
import { FileDiff } from "./FileDiff";
import { LargeDiffGuard } from "./LargeDiffGuard";
import { DiffViewControls } from "./DiffViewControls";
import { diffsAtom, diffErrorsAtom, loadingDiffsAtom } from "../store";
import { useDiffViewOptions } from "../hooks/useDiffViewOptions";
import type { DiffViewOptions, FileChange, FileDiff as FileDiffType } from "./types";

interface DiffStackProps {
  files: FileChange[];
  getDiff: (path: string, options?: { force?: boolean }) => Promise<FileDiffType | null>;
  refreshId?: number;
  selectedFile: string | null;
  expandedFiles: Set<string>;
  onToggleExpand: (path: string) => void;
  largeDiffThreshold: number;
  onStageFile?: (path: string) => void;
  onStageHunks?: (path: string, hunks: HunkSelection[]) => void;
  onUnstageFile?: (path: string) => void;
  onUnstageHunks?: (path: string, hunks: HunkSelection[]) => void;
  onDiscardFile?: (path: string) => void;
  editable: boolean;
  onSaveEdit?: (path: string, content: string) => Promise<void>;
  partiallyStagedFiles?: Set<string>;
  focusedFile?: string | null;
  theme?: "light" | "dark";
  /** Whether this is staged or working diff (for cache key lookup) */
  diffType?: "staged" | "working";
  /** Optional cache key override */
  diffKey?: (path: string) => string;
  /** Whether to show diff view controls */
  showControls?: boolean;
  diffViewOptions?: DiffViewOptions;
  onDiffViewOptionsChange?: (options: DiffViewOptions) => void;
}

/** Shared header for skeleton and error states */
function FileHeader({ path }: { path: string }) {
  return (
    <Box px="3" py="2">
      <Text size="2" weight="medium">
        {path}
      </Text>
    </Box>
  );
}

function FileDiffSkeleton({ file }: { file: FileChange }) {
  return (
    <Card size="2">
      <FileHeader path={file.path} />
      <Separator size="4" />
      <Flex align="center" justify="center" p="4" gap="2">
        <Spinner size="2" />
        <Text size="2" color="gray">Loading diff...</Text>
      </Flex>
    </Card>
  );
}

function FileDiffError({
  file,
  error,
  onRetry,
}: {
  file: FileChange;
  error: string;
  onRetry: () => void;
}) {
  return (
    <Card size="2">
      <FileHeader path={file.path} />
      <Separator size="4" />
      <Flex direction="column" align="center" justify="center" p="4" gap="3">
        <Flex align="center" gap="2">
          <Text color="red">
            <ExclamationTriangleIcon />
          </Text>
          <Text color="red" size="2">
            Failed to load diff
          </Text>
        </Flex>
        <Text size="1" color="gray">
          {error}
        </Text>
        <Button size="1" variant="soft" onClick={onRetry}>
          <ReloadIcon />
          Retry
        </Button>
      </Flex>
    </Card>
  );
}

function EmptyState() {
  return (
    <Box p="4">
      <Callout.Root size="2" color="green" variant="soft">
        <Callout.Icon>
          <CheckCircledIcon />
        </Callout.Icon>
        <Callout.Text>
          No changes to display. Your working tree is clean.
        </Callout.Text>
      </Callout.Root>
    </Box>
  );
}

function countDiffLines(diff: FileDiffType): number {
  return diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
}

interface FileDiffContainerProps {
  file: FileChange;
  diff: FileDiffType | undefined;
  error: string | undefined;
  isLoading: boolean;
  isLarge: boolean;
  isExpanded: boolean;
  /** Called with file path when expand is toggled - parent passes stable callback */
  onToggleExpand: (path: string) => void;
  /** Called with file path to reload diff - parent passes stable callback */
  onLoadDiff: (path: string) => void;
  onStageFile?: (path: string) => void;
  onStageHunks?: (path: string, hunks: HunkSelection[]) => void;
  onUnstageFile?: (path: string) => void;
  onUnstageHunks?: (path: string, hunks: HunkSelection[]) => void;
  onDiscardFile?: (path: string) => void;
  editable: boolean;
  onSaveEdit?: (path: string, content: string) => Promise<void>;
  partiallyStaged?: boolean;
  theme?: "light" | "dark";
  diffViewOptions: DiffViewOptions;
}

/**
 * Memoized container to prevent unnecessary re-renders.
 * Uses default shallow comparison - ensure callback props are stable (useCallback).
 * Callbacks take path as parameter so parent can pass stable functions.
 */
const FileDiffContainer = React.memo(function FileDiffContainer({
  file,
  diff,
  error,
  isLoading,
  isLarge,
  isExpanded,
  onToggleExpand,
  onLoadDiff,
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
}: FileDiffContainerProps) {
  // Create stable callbacks that include the file path
  const handleRetry = useCallback(() => onLoadDiff(file.path), [onLoadDiff, file.path]);
  const handleExpand = useCallback(() => onToggleExpand(file.path), [onToggleExpand, file.path]);

  if (error) {
    return <FileDiffError file={file} error={error} onRetry={handleRetry} />;
  }

  // Show skeleton when loading or when diff hasn't been fetched yet
  if (isLoading || !diff) {
    return <FileDiffSkeleton file={file} />;
  }

  if (isLarge && !isExpanded) {
    return (
      <LargeDiffGuard
        file={file}
        diff={diff}
        onExpand={handleExpand}
        onStageFile={onStageFile}
        onUnstageFile={onUnstageFile}
        onDiscardFile={onDiscardFile}
      />
    );
  }

  return (
    <FileDiff
      file={file}
      diff={diff}
      onStageFile={onStageFile}
      onStageHunks={onStageHunks}
      onUnstageFile={onUnstageFile}
      onUnstageHunks={onUnstageHunks}
      onDiscardFile={onDiscardFile}
      editable={editable}
      onSaveEdit={onSaveEdit}
      partiallyStaged={partiallyStaged}
      theme={theme}
      diffViewOptions={diffViewOptions}
    />
  );
});

export function DiffStack({
  files,
  getDiff,
  refreshId,
  selectedFile,
  expandedFiles,
  onToggleExpand,
  largeDiffThreshold,
  onStageFile,
  onStageHunks,
  onUnstageFile,
  onUnstageHunks,
  onDiscardFile,
  editable,
  onSaveEdit,
  partiallyStagedFiles,
  focusedFile,
  theme,
  diffType = "working",
  diffKey,
  showControls = true,
  diffViewOptions,
  onDiffViewOptionsChange,
}: DiffStackProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const prevRefreshIdRef = useRef<number | undefined>(undefined);
  const prevFilesRef = useRef<Set<string>>(new Set(files.map((file) => file.path)));
  // Ref to hold the latest loadDiff function - prevents stale closure in observer
  const loadDiffRef = useRef<(path: string, options?: { force?: boolean }) => void>(() => {});

  // Read from store's diff cache (getDiff stores results here via fetchDiffAtom)
  const storeDiffs = useAtomValue(diffsAtom);
  const diffErrors = useAtomValue(diffErrorsAtom);
  const loadingDiffs = useAtomValue(loadingDiffsAtom);

  const cacheKeyFor = useCallback(
    (path: string) => (diffKey ? diffKey(path) : `${diffType}:${path}`),
    [diffKey, diffType]
  );

  // Get diff from store cache
  const getCachedEntry = useCallback((path: string) => {
    const cacheKey = cacheKeyFor(path);
    return storeDiffs.get(cacheKey);
  }, [storeDiffs, cacheKeyFor]);

  // Scroll to selected file
  useEffect(() => {
    if (selectedFile && fileRefs.current.has(selectedFile)) {
      fileRefs.current.get(selectedFile)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  }, [selectedFile]);

  // Cleanup refs on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      fileRefs.current.clear();
    };
  }, []);

  // Load diff for a file (getDiff caches result in store via fetchDiffAtom)
  // Note: We don't depend on storeDiffs/loadingDiffs to prevent effect cascades.
  // fetchDiffAtom handles caching and deduplication internally.
  const loadDiff = useCallback(
    (path: string, options?: { force?: boolean }) => {
      // getDiff is backed by fetchDiffAtom which handles caching and deduplication
      void getDiff(path, options);
    },
    [getDiff]
  );

  // Keep the ref updated with the latest loadDiff function
  useEffect(() => {
    loadDiffRef.current = loadDiff;
  }, [loadDiff]);

  // Stable callback for force-reloading a diff (used by retry button)
  const forceLoadDiff = useCallback(
    (path: string) => loadDiff(path, { force: true }),
    [loadDiff]
  );

  // Load selected file diff
  useEffect(() => {
    if (selectedFile) {
      loadDiff(selectedFile);
    }
  }, [selectedFile, loadDiff]);

  // Force-refresh visible diffs when refreshId changes
  useEffect(() => {
    if (refreshId === undefined) return;
    if (prevRefreshIdRef.current === undefined) {
      // First mount - just record the initial value
      prevRefreshIdRef.current = refreshId;
      return;
    }
    if (prevRefreshIdRef.current !== refreshId) {
      prevRefreshIdRef.current = refreshId;
      // Force reload all diffs
      for (const file of files) {
        loadDiff(file.path, { force: true });
      }
    }
  }, [refreshId, files, loadDiff]);

  // Ensure newly added files load a diff at least once.
  useEffect(() => {
    const prev = prevFilesRef.current;
    const next = new Set<string>();

    for (const file of files) {
      next.add(file.path);
      if (!prev.has(file.path)) {
        loadDiff(file.path);
      }
    }

    prevFilesRef.current = next;
  }, [files, loadDiff]);

  // Lazy-load diffs when they scroll into view.
  // Note: Observer is created once on mount. New elements are observed via registerRef.
  // We don't depend on `files` or `loadDiff` to avoid recreating the observer.
  // Instead, we use loadDiffRef to always call the latest version.
  //
  // React Strict Mode compatibility: In development, effects run twice. This is handled
  // correctly because we disconnect any existing observer before creating a new one,
  // and the cleanup function properly disconnects and nulls the ref.
  useEffect(() => {
    const viewport = containerRef.current?.closest(
      "[data-radix-scroll-area-viewport]"
    ) as HTMLElement | null;

    // Disconnect any existing observer (handles Strict Mode double-invocation)
    observerRef.current?.disconnect();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          const path = el.dataset["path"];
          if (path) {
            // Use ref to avoid stale closure - always calls latest loadDiff
            loadDiffRef.current(path);
          }
        }
      },
      { root: viewport ?? null, rootMargin: "200px 0px", threshold: 0.01 }
    );

    observerRef.current = observer;

    // Observe any elements that were registered before this effect ran
    for (const el of fileRefs.current.values()) {
      observer.observe(el);
    }

    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, []); // Empty deps - observer is stable, uses ref for latest loadDiff

  // Register file ref for scroll targeting
  const registerRef = useCallback(
    (path: string, el: HTMLDivElement | null) => {
      if (el) {
        fileRefs.current.set(path, el);
        observerRef.current?.observe(el);
      } else {
        const prev = fileRefs.current.get(path);
        if (prev) {
          observerRef.current?.unobserve(prev);
        }
        fileRefs.current.delete(path);
      }
    },
    []
  );

  const [localOptions, setLocalOptions] = useDiffViewOptions();
  const viewOptions = diffViewOptions ?? localOptions;
  const setViewOptions = onDiffViewOptionsChange ?? setLocalOptions;

  if (files.length === 0) {
    return <EmptyState />;
  }

  return (
    <Box ref={containerRef} p="3">
      {showControls && (
        <DiffViewControls options={viewOptions} onChange={setViewOptions} />
      )}
      {files.map((file, index) => {
        const cacheEntry = getCachedEntry(file.path);
        const diff = cacheEntry?.diff;
        const cacheKey = cacheKeyFor(file.path);
        const error = diffErrors.get(cacheKey);
        const isLoading = loadingDiffs.has(cacheKey);
        const isLarge = diff !== undefined && countDiffLines(diff) > largeDiffThreshold;
        const isExpanded = expandedFiles.has(file.path);
        const partiallyStaged = partiallyStagedFiles?.has(file.path) ?? false;

        return (
          <Box
            key={`${diffType}:${file.path}`}
            ref={(el) => registerRef(file.path, el)}
            mb="4"
            data-path={file.path}
            data-focused={focusedFile === file.path || undefined}
          >
            {index > 0 && <Separator size="4" mb="4" />}

            <FileDiffContainer
              file={file}
              diff={diff}
              error={error}
              isLoading={isLoading}
              isLarge={isLarge}
              isExpanded={isExpanded}
              onToggleExpand={onToggleExpand}
              onLoadDiff={forceLoadDiff}
              onStageFile={onStageFile}
              onStageHunks={onStageHunks}
              onUnstageFile={onUnstageFile}
              onUnstageHunks={onUnstageHunks}
              onDiscardFile={onDiscardFile}
              editable={editable}
              onSaveEdit={onSaveEdit}
              partiallyStaged={partiallyStaged}
              theme={theme}
              diffViewOptions={viewOptions}
            />
          </Box>
        );
      })}
    </Box>
  );
}
