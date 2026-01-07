import React, { useState, useCallback, useRef } from "react";
import { Flex, Text, Button, Box, Spinner } from "@radix-ui/themes";
import * as Accordion from "@radix-ui/react-accordion";
import { CommitIcon, ChevronRightIcon } from "@radix-ui/react-icons";
import type { CommitEntry } from "./store";
import type { FileDiff } from "@natstack/git";
import { DiffBlock } from "./DiffBlock";
import type { DiffViewOptions, FileChange } from "./DiffBlock/types";
import { formatRelativeTime } from "./utils";
import { MAX_CACHED_COMMITS } from "./constants";

/** Animated chevron that rotates when expanded */
function ExpandChevron({ expanded }: { expanded?: boolean }) {
  return (
    <ChevronRightIcon
      style={{
        transition: "transform 150ms ease-out",
        transform: expanded ? "rotate(90deg)" : undefined,
      }}
    />
  );
}

export interface CommitHistoryProps {
  commits: CommitEntry[];
  loading?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  getCommitFiles?: (sha: string) => Promise<Array<{ path: string; status: "added" | "modified" | "deleted" }>>;
  getCommitDiff?: (sha: string, path: string, options?: { force?: boolean }) => Promise<FileDiff | null>;
  theme?: "light" | "dark";
  diffViewOptions?: DiffViewOptions;
  showDiffControls?: boolean;
}

/**
 * List of commit entries with expandable inline diffs
 */
export function CommitHistory({
  commits,
  loading,
  hasMore,
  onLoadMore,
  getCommitFiles,
  getCommitDiff,
  theme,
  diffViewOptions,
  showDiffControls = true,
}: CommitHistoryProps) {
  const [expandedCommits, setExpandedCommits] = useState<string[]>([]);
  const [commitFiles, setCommitFiles] = useState<Map<string, FileChange[]>>(new Map());
  const [errorCommits, setErrorCommits] = useState<Set<string>>(new Set());

  // Track in-flight requests using ref for synchronous deduplication guard
  // and state for UI updates. Both are needed because:
  // - Ref: Provides immediate synchronous check to prevent duplicate requests
  // - State: Triggers re-render to show loading UI
  const inFlightRef = useRef<Set<string>>(new Set());
  const [loadingFiles, setLoadingFiles] = useState<Set<string>>(new Set());

  const loadCommitFiles = useCallback(
    async (commitOid: string) => {
      if (!getCommitFiles || inFlightRef.current.has(commitOid)) return;

      // Mark as loading (ref for guard, state for UI)
      inFlightRef.current.add(commitOid);
      setLoadingFiles((prev) => new Set(prev).add(commitOid));
      setErrorCommits((prev) => {
        if (!prev.has(commitOid)) return prev;
        const next = new Set(prev);
        next.delete(commitOid);
        return next;
      });

      try {
        const files = await getCommitFiles(commitOid);
        const fileChanges: FileChange[] = files.map((f) => ({
          path: f.path,
          status: f.status,
          staged: true,
          additions: 0,
          deletions: 0,
        }));
        setCommitFiles((prev) => {
          const next = new Map(prev).set(commitOid, fileChanges);
          // LRU pruning: keep only MAX_CACHED_COMMITS entries
          if (next.size > MAX_CACHED_COMMITS) {
            const keysToDelete = Array.from(next.keys()).slice(0, next.size - MAX_CACHED_COMMITS);
            for (const key of keysToDelete) {
              next.delete(key);
            }
          }
          return next;
        });
      } catch {
        setErrorCommits((prev) => new Set(prev).add(commitOid));
      } finally {
        inFlightRef.current.delete(commitOid);
        setLoadingFiles((prev) => {
          const next = new Set(prev);
          next.delete(commitOid);
          return next;
        });
      }
    },
    [getCommitFiles]
  );

  const handleCommitExpand = useCallback(
    (values: string[]) => {
      // Find newly expanded commit (if any)
      const newlyExpanded = values.find((v) => !expandedCommits.includes(v));
      setExpandedCommits(values);

      // Load files for newly expanded commit if not already cached
      if (newlyExpanded && !commitFiles.has(newlyExpanded)) {
        void loadCommitFiles(newlyExpanded);
      }
    },
    [expandedCommits, commitFiles, loadCommitFiles]
  );

  // Dedicated retry function that doesn't depend on expansion state
  const retryLoadCommit = useCallback(
    (commitOid: string) => {
      void loadCommitFiles(commitOid);
    },
    [loadCommitFiles]
  );

  if (loading && commits.length === 0) {
    return (
      <Flex align="center" justify="center" py="4">
        <Spinner size="2" />
      </Flex>
    );
  }

  if (commits.length === 0 && !loading) {
    return (
      <Flex direction="column" align="center" justify="center" py="4" gap="1">
        <Text size="2" color="gray">
          No commits yet
        </Text>
        <Text size="1" color="gray">
          Stage and commit changes to see history
        </Text>
      </Flex>
    );
  }

  const canExpand = !!getCommitFiles && !!getCommitDiff;

  return (
    <Flex direction="column">
      {canExpand ? (
        <Accordion.Root
          type="multiple"
          value={expandedCommits}
          onValueChange={handleCommitExpand}
        >
          {commits.map((commit) => (
            <Accordion.Item key={commit.oid} value={commit.oid}>
              <Accordion.Trigger asChild>
                <CommitRow commit={commit} expandable expanded={expandedCommits.includes(commit.oid)} />
              </Accordion.Trigger>
              <Accordion.Content>
                {loadingFiles.has(commit.oid) ? (
                  <Flex align="center" justify="center" py="3">
                    <Spinner size="2" />
                  </Flex>
                ) : errorCommits.has(commit.oid) ? (
                  <Flex align="center" justify="center" py="3" gap="2">
                    <Text size="2" color="red">Failed to load commit files</Text>
                    <Button
                      size="1"
                      variant="soft"
                      onClick={() => retryLoadCommit(commit.oid)}
                    >
                      Retry
                    </Button>
                  </Flex>
                ) : (() => {
                  // Use IIFE to safely extract files with proper null narrowing
                  const files = commitFiles.get(commit.oid);
                  if (!files) return null;
                  return (
                    <DiffBlock
                      files={files}
                      getDiff={(path, options) => getCommitDiff!(commit.oid, path, options)}
                      diffKey={(path) => `commit:${commit.oid}:${path}`}
                      theme={theme}
                      showDiffControls={showDiffControls}
                      diffViewOptions={diffViewOptions}
                    />
                  );
                })()}
              </Accordion.Content>
            </Accordion.Item>
          ))}
        </Accordion.Root>
      ) : (
        commits.map((commit) => <CommitRow key={commit.oid} commit={commit} />)
      )}

      {hasMore && (
        <Flex justify="center" py="2">
          <Button
            size="1"
            variant="ghost"
            onClick={onLoadMore}
            disabled={loading}
          >
            {loading ? "Loading..." : "Load more"}
          </Button>
        </Flex>
      )}
    </Flex>
  );
}

interface CommitRowProps extends React.HTMLAttributes<HTMLDivElement> {
  commit: CommitEntry;
  expandable?: boolean;
  expanded?: boolean;
}

const CommitRow = React.forwardRef<HTMLDivElement, CommitRowProps>(
  function CommitRow(
    { commit, expandable, expanded, className, style, onClick, ...rest },
    ref
  ) {
    const shortSha = commit.oid.slice(0, 7);
    const firstLine = commit.message.split("\n")[0];
    const date = new Date(commit.author.timestamp * 1000);
    const relativeTime = formatRelativeTime(date);

    return (
      <Box
        ref={ref}
        p="2"
        className={className}
        style={{ cursor: expandable ? "pointer" : undefined, ...style }}
        onClick={onClick}
        {...rest}
      >
        <Flex align="center" gap="2">
          {expandable && <ExpandChevron expanded={expanded} />}
          <CommitIcon />
          <Text size="1" color="gray">
            {shortSha}
          </Text>
          <Text size="2" truncate>
            {firstLine}
          </Text>
          <Text size="1" color="gray">
            {relativeTime}
          </Text>
        </Flex>
        <Flex pt="1">
          <Text size="1" color="gray">
            {commit.author.name}
          </Text>
        </Flex>
      </Box>
    );
  }
);
