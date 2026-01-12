/**
 * DirtyRepoView - Git UI wrapper for dirty panel builds.
 *
 * Shows the git-ui GitStatusView when a panel has uncommitted changes,
 * with a build-specific header and "Continue Build" button.
 */

import { useMemo, useCallback, useState, useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { Flex, Button, Tooltip, Callout } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { GitStatusView, useGitStatus, type GitNotification } from "@natstack/git-ui";
import { GitClient } from "@natstack/git";
import * as fs from "fs/promises";
import { effectiveThemeAtom } from "../state/themeAtoms";

export interface DirtyRepoViewProps {
  panelId: string;
  repoPath: string;
  onRetryBuild: () => void;
  /** Optional notification handler - if not provided, notifications are silently ignored */
  onNotify?: (notification: GitNotification) => void;
}

export function DirtyRepoView({ repoPath, onRetryBuild, onNotify }: DirtyRepoViewProps) {
  // Create GitClient with direct Node.js fs access.
  // Note: Empty serverUrl/token means remote operations (push/pull/fetch) are unavailable.
  // This is intentional - DirtyRepoView is for local operations only (stage, commit, discard).
  // Remote operations would fail with auth errors if attempted.
  const gitClient = useMemo(
    () => new GitClient(fs, { serverUrl: "", token: "" }),
    []
  );
  const [isRetrying, setIsRetrying] = useState(false);
  const hasAutoRetried = useRef(false);
  const theme = useAtomValue(effectiveThemeAtom);

  // Use the git status hook to track if repo is clean
  // The hook includes `initialized` to handle the case where GitStatusView hasn't mounted yet
  const { stagedFiles, unstagedFiles, loading, initialized } = useGitStatus();

  // Only consider clean when we have initialized data
  const isClean = useMemo(() => {
    if (!initialized) return false; // Don't allow retry before store is initialized
    return stagedFiles.length === 0 && unstagedFiles.length === 0;
  }, [initialized, stagedFiles.length, unstagedFiles.length]);

  // Reset isRetrying when loading completes, allowing the user to try again
  // if the repo is still dirty after the build attempt
  useEffect(() => {
    if (!loading && isRetrying) {
      setIsRetrying(false);
    }
  }, [loading, isRetrying]);

  const handleRetryBuild = useCallback(() => {
    setIsRetrying(true);
    onRetryBuild();
  }, [onRetryBuild]);

  // Auto-retry build when repo becomes clean (only once per dirty->clean transition)
  // Wait until loading is complete to avoid flickering during initial status fetch
  useEffect(() => {
    if (isClean && initialized && !loading && !hasAutoRetried.current) {
      hasAutoRetried.current = true;
      handleRetryBuild();
    }
  }, [isClean, initialized, loading, handleRetryBuild]);

  // Reset auto-retry flag when repo becomes dirty again
  useEffect(() => {
    if (!isClean && !loading) {
      hasAutoRetried.current = false;
    }
  }, [isClean, loading]);

  // Forward notifications to parent if handler provided, otherwise silently ignore
  const handleNotify = useCallback((notification: GitNotification) => {
    onNotify?.(notification);
  }, [onNotify]);

  return (
    <Flex direction="column" style={{ height: "100%", minHeight: 0 }}>
      {/* Build-specific header with Continue button */}
      <Flex align="center" justify="between" gap="3" p="2">
        <Callout.Root color="orange" size="1" style={{ flex: 1 }}>
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>
            Uncommitted changes must be resolved before building
          </Callout.Text>
        </Callout.Root>
        <Tooltip
          content={
            !initialized
              ? "Loading git status..."
              : isClean
              ? "Proceed with build"
              : `Commit or discard all changes first (${stagedFiles.length} staged, ${unstagedFiles.length} unstaged)`
          }
        >
          <Button
            onClick={handleRetryBuild}
            disabled={!isClean || isRetrying || loading || !initialized}
            size="2"
          >
            {isRetrying ? "Retrying..." : "Continue Build"}
          </Button>
        </Tooltip>
      </Flex>

      {/* General-purpose git UI */}
      <Flex direction="column" style={{ flex: 1, minHeight: 0 }}>
        <GitStatusView
          dir={repoPath}
          fs={fs}
          gitClient={gitClient}
          onNotify={handleNotify}
          theme={theme}
        />
      </Flex>
    </Flex>
  );
}
