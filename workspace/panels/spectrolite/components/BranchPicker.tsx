/**
 * Minimal branch picker for the active vault.
 *
 * Reads branches via `listBranches(repoPath)` from `@workspace/runtime`
 * (which talks to the git server's tree manager) and switches via
 * `GitClient.checkout(repoPath, branch)`.
 *
 * Doesn't use `@workspace/git-ui`'s `BranchSelector` because that one
 * relies on a global Jotai store that's initialised by `GitStatusView`,
 * which we don't mount in Spectrolite.
 */

import { useCallback, useEffect, useState } from "react";
import { promises as fs } from "fs";
import { Button, DropdownMenu, Flex, Spinner, Text } from "@radix-ui/themes";
import { ChevronDownIcon, CheckIcon } from "@radix-ui/react-icons";
import { GitClient, type FsPromisesLike } from "@natstack/git";
import { gitConfig, listBranches } from "@workspace/runtime";
import { formatGitError } from "../state/gitErrors";

export interface BranchPickerProps {
  /** Context-fs path of the vault (e.g. `/projects/default`). */
  repoRoot: string;
  /** Bumped externally after commits so the branch list refreshes. */
  refreshNonce?: number;
}

function gitClient(): GitClient | null {
  if (!gitConfig?.serverUrl) return null;
  return new GitClient(fs as unknown as FsPromisesLike, {
    serverUrl: gitConfig.serverUrl,
    token: gitConfig.token,
  });
}

function toRelative(repoRoot: string): string {
  return repoRoot.replace(/^\/+/, "");
}

export function BranchPicker({ repoRoot, refreshNonce = 0 }: BranchPickerProps) {
  const [branches, setBranches] = useState<Array<{ name: string; current: boolean }>>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const rel = toRelative(repoRoot);
    void (async () => {
      try {
        const list = await listBranches(rel);
        if (cancelled) return;
        setBranches(list.map((b) => ({ name: b.name, current: b.current })));
        setError(null);
      } catch (err) {
        if (cancelled) return;
        console.debug("[Spectrolite] listBranches failed:", err);
        setBranches([]);
        setError(formatGitError("branches", err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [repoRoot, refreshNonce]);

  const current = branches.find((b) => b.current)?.name;

  const handleCheckout = useCallback(async (name: string) => {
    if (name === current || busy) return;
    const git = gitClient();
    if (!git) {
      setError("Git server is not available.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const status = await git.status(repoRoot);
      const dirtyFiles = (status.files ?? []).filter((file) => file.status !== "unmodified" && file.status !== "ignored");
      if (dirtyFiles.length > 0) {
        setError("Commit or discard changes before switching branches.");
        return;
      }
      await git.checkout(repoRoot, name, { force: true });
      // Refresh by re-running the effect.
      setBranches((prev) => prev.map((b) => ({ ...b, current: b.name === name })));
    } catch (err) {
      console.warn("[Spectrolite] checkout failed:", err);
      setError(formatGitError("checkout", err));
    } finally {
      setBusy(false);
    }
  }, [busy, current, repoRoot]);

  if (loading) return <Spinner size="1" />;
  if (branches.length === 0) {
    return <Text size="1" color={error ? "red" : "gray"}>{error ? `branches unavailable: ${error}` : "no branches"}</Text>;
  }

  return (
    <Flex align="center" gap="2">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <Button size="1" variant="ghost" color={error ? "red" : "gray"} disabled={busy} data-testid="spectrolite-branch-trigger">
            {current ?? "detached"} <ChevronDownIcon />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
          <DropdownMenu.Label>Branches</DropdownMenu.Label>
          {branches.map((b) => (
            <DropdownMenu.Item
              key={b.name}
              onSelect={() => void handleCheckout(b.name)}
              data-testid={`spectrolite-branch-${b.name}`}
            >
              <Flex align="center" gap="2" style={{ minWidth: 140 }} data-testid={`spectrolite-branch-${b.name}`} data-branch-name={b.name}>
                {b.current ? <CheckIcon /> : <span style={{ width: 16, display: "inline-block" }} />}
                {b.name}
              </Flex>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      {error ? (
        <Text size="1" color="red" title={error} data-testid="spectrolite-branch-error">
          {error}
        </Text>
      ) : null}
    </Flex>
  );
}
