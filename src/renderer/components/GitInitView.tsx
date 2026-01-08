/**
 * GitInitView - Git initialization UI for non-repo panel folders.
 *
 * Shows instructions and a git initialization interface when a panel folder
 * is not a git repository, with a "Continue Build" button that becomes
 * enabled after successful initialization.
 */

import { useMemo, useCallback, useState, useEffect } from "react";
import { useAtomValue } from "jotai";
import { Flex, Button, Tooltip, Callout, Text, Code, Card } from "@radix-ui/themes";
import { ExclamationTriangleIcon, CheckCircledIcon } from "@radix-ui/react-icons";
import { GitStatusView, useGitStatus, type GitNotification } from "@natstack/git-ui";
import { GitClient } from "@natstack/git";
import * as fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { effectiveThemeAtom } from "../state/themeAtoms";

const execFileAsync = promisify(execFile);

export interface GitInitViewProps {
  panelId: string;
  repoPath: string;
  onContinueBuild: () => void;
  /** Optional notification handler */
  onNotify?: (notification: GitNotification) => void;
}

export function GitInitView({ repoPath, onContinueBuild, onNotify }: GitInitViewProps) {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [isContinuing, setIsContinuing] = useState(false);
  const theme = useAtomValue(effectiveThemeAtom);

  // GitClient for showing git UI after initialization
  const gitClient = useMemo(
    () => new GitClient(fs, { serverUrl: "", token: "" }),
    []
  );

  // Use git status hook to track if repo is clean after initialization
  const { stagedFiles, unstagedFiles, loading, initialized } = useGitStatus();

  // Only consider clean when initialized and no changes
  const isClean = useMemo(() => {
    if (!isInitialized || !initialized) return false;
    return stagedFiles.length === 0 && unstagedFiles.length === 0;
  }, [isInitialized, initialized, stagedFiles.length, unstagedFiles.length]);

  // Reset isContinuing when loading completes
  useEffect(() => {
    if (!loading && isContinuing) {
      setIsContinuing(false);
    }
  }, [loading, isContinuing]);

  const handleInitialize = useCallback(async () => {
    setIsInitializing(true);
    setInitError(null);

    try {
      // Run git init in the panel directory
      await execFileAsync("git", ["init"], { cwd: repoPath });

      // Verify it worked by checking for .git directory
      const gitDir = `${repoPath}/.git`;
      try {
        await fs.access(gitDir);
        setIsInitialized(true);
      } catch {
        throw new Error("Git initialization succeeded but .git directory not found");
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      setInitError(errorMsg);
    } finally {
      setIsInitializing(false);
    }
  }, [repoPath]);

  const handleContinueBuild = useCallback(() => {
    setIsContinuing(true);
    onContinueBuild();
  }, [onContinueBuild]);

  const handleNotify = useCallback(
    (notification: GitNotification) => {
      onNotify?.(notification);
    },
    [onNotify]
  );

  return (
    <Flex direction="column" style={{ height: "100%", minHeight: 0 }}>
      {/* Header with status and action button */}
      <Flex align="center" justify="between" gap="3" p="2">
        <Callout.Root
          color={isInitialized ? "green" : "orange"}
          size="1"
          style={{ flex: 1 }}
        >
          <Callout.Icon>
            {isInitialized ? <CheckCircledIcon /> : <ExclamationTriangleIcon />}
          </Callout.Icon>
          <Callout.Text>
            {isInitialized
              ? "Git repository initialized - commit changes to continue"
              : "Panel folder must be a git repository"}
          </Callout.Text>
        </Callout.Root>

        {isInitialized ? (
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
              onClick={handleContinueBuild}
              disabled={!isClean || isContinuing || loading || !initialized}
              size="2"
            >
              {isContinuing ? "Building..." : "Continue Build"}
            </Button>
          </Tooltip>
        ) : (
          <Button onClick={handleInitialize} disabled={isInitializing} size="2">
            {isInitializing ? "Initializing..." : "Initialize Git Repository"}
          </Button>
        )}
      </Flex>

      {/* Main content area */}
      <Flex direction="column" style={{ flex: 1, minHeight: 0 }} p="3" gap="3">
        {!isInitialized ? (
          // Show initialization instructions
          <Card>
            <Flex direction="column" gap="3">
              <Text size="3" weight="bold">
                Why is this required?
              </Text>
              <Text size="2">
                Natstack requires each panel folder to be the root of its own git repository
                (not just a subfolder within a larger repo) to ensure:
              </Text>
              <Flex direction="column" gap="2" ml="3">
                <Text size="2">• Version control and change tracking per panel</Text>
                <Text size="2">• Build reproducibility from committed state</Text>
                <Text size="2">• Protection against building with uncommitted changes</Text>
                <Text size="2">• Independent panel versioning and history</Text>
              </Flex>

              <Text size="3" weight="bold" mt="2">
                What happens when you click "Initialize Git Repository"?
              </Text>
              <Text size="2">
                This will run <Code>git init</Code> in the panel folder:
              </Text>
              <Code size="2" style={{ padding: "8px", display: "block" }}>
                {repoPath}
              </Code>

              {initError && (
                <Callout.Root color="red" size="1" mt="2">
                  <Callout.Icon>
                    <ExclamationTriangleIcon />
                  </Callout.Icon>
                  <Callout.Text>Initialization failed: {initError}</Callout.Text>
                </Callout.Root>
              )}
            </Flex>
          </Card>
        ) : (
          // Show git UI after initialization
          <GitStatusView
            dir={repoPath}
            fs={fs}
            gitClient={gitClient}
            onNotify={handleNotify}
            theme={theme}
          />
        )}
      </Flex>
    </Flex>
  );
}
