/**
 * Compact commit strip — single row at the bottom of the editor pane.
 *
 * Uses `@natstack/git`'s GitClient directly so the panel owns the commit
 * boundary (rather than delegating it to the agent). The "Suggest message"
 * button sends a templated prompt to the resident agent via the channel; the
 * agent replies in the ChannelDrawer with subject + body, the user copies it
 * into the commit message field and commits.
 *
 * Publishes a `kb.commit` custom message on success so chat-side observers
 * see the commit in their transcript.
 */

import { useCallback, useEffect, useState } from "react";
import { promises as fs } from "fs";
import { Button, Callout, Code, Flex, Text, TextArea } from "@radix-ui/themes";
import { CommitIcon, MagicWandIcon } from "@radix-ui/react-icons";
import { GitClient, type FsPromisesLike } from "@natstack/git";
import { gitConfig, contextId as runtimeContextId } from "@workspace/runtime";
import { useIsMobile } from "@workspace/react";
import type { PubSubClient } from "@workspace/pubsub";
import { KB_COMMIT_TYPE } from "../messages/register";
import { formatGitError } from "../state/gitErrors";

export interface CommitStripProps {
  repoRoot: string;
  /** PubSub client for publishing kb.commit + sending suggestion prompts. */
  client: PubSubClient | null;
  /** Bumped when editor flushes or external workspace state changes. */
  refreshNonce?: number;
  /** Handle of the resident agent we ask for a commit message. */
  primaryAgentHandle?: string;
  /** Bumped after every successful commit so consumers can refresh status. */
  onCommitted?: (sha: string) => void;
  /** External setter for the message field — lets the drawer's "Use as commit msg" land here. */
  message: string;
  onMessageChange: (next: string) => void;
}

interface DirtyStatus {
  dirty: string[];
  branch: string | undefined;
}

function makeClient(): GitClient {
  return new GitClient(fs as unknown as FsPromisesLike, {
    serverUrl: gitConfig?.serverUrl,
    token: gitConfig?.token,
  });
}

function commitSubject(message: string): string {
  return message.split("\n", 1)[0]?.trim() ?? "";
}

export function CommitStrip({ repoRoot, client, refreshNonce = 0, primaryAgentHandle, onCommitted, message, onMessageChange }: CommitStripProps) {
  const isMobile = useIsMobile();
  const [status, setStatus] = useState<DirtyStatus>({ dirty: [], branch: undefined });
  const [committing, setCommitting] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const git = makeClient();
        const s = await git.status(repoRoot);
        if (cancelled) return;
        const dirtyFiles = (s.files ?? [])
          .filter((f) => f.status !== "unmodified" && f.status !== "ignored")
          .map((f) => f.path);
        setStatus({ dirty: dirtyFiles, branch: s.branch ?? undefined });
        setStatusError(null);
      } catch (err) {
        if (!cancelled) {
          console.debug("[Spectrolite] git status failed:", err);
          setStatusError(formatGitError("status", err));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [repoRoot, nonce, refreshNonce]);

  const handleSuggest = useCallback(async () => {
    if (!client) return;
    const handle = primaryAgentHandle ?? "agent";
    const filesList = status.dirty.length > 0 ? status.dirty.join(", ") : "(no dirty files)";
    const prompt = [
      `@${handle} Please look at the staged + unstaged changes in \`${repoRoot}\``,
      `(files: ${filesList}) and propose a concise commit message. Reply with`,
      `the subject line, then a blank line, then the body. No preamble.`,
    ].join(" ");
    try {
      await client.send(prompt, { mentions: [handle] });
    } catch (err) {
      console.warn("[Spectrolite] suggest send failed:", err);
    }
  }, [client, primaryAgentHandle, repoRoot, status.dirty]);

  const handleCommit = useCallback(async () => {
    const subject = commitSubject(message);
    if (!subject) return;
    setCommitting(true);
    setCommitError(null);
    try {
      const git = makeClient();
      await git.addAll(repoRoot);
      const shaStr = await git.commit({ dir: repoRoot, message });
      if (client && shaStr) {
        await client.publishCustomMessage({
          typeId: KB_COMMIT_TYPE,
          initialState: {
            sha: shaStr,
            subject,
            body: message.slice(subject.length).trim(),
            files: status.dirty,
            at: Date.now(),
            editorContextId: runtimeContextId,
          },
          displayMode: "row",
        }).catch((err) => console.warn("[Spectrolite] kb.commit publish failed:", err));
      }
      onMessageChange("");
      setNonce((n) => n + 1);
      onCommitted?.(shaStr);
    } catch (err) {
      console.warn("[Spectrolite] commit failed:", err);
      setCommitError(formatGitError("commit", err));
    } finally {
      setCommitting(false);
    }
  }, [client, message, repoRoot, status.dirty, onCommitted]);

  const subject = commitSubject(message);

  // Compact horizontal strip on desktop; stacked form on mobile so the
  // message field gets its full width and the buttons are touch-sized.
  if (isMobile) {
    return (
      <Flex direction="column" gap="3">
        {statusError ? <InlineGitError kind="status" message={`Git status failed: ${statusError}`} /> : null}
        {commitError ? <InlineGitError kind="commit" message={`Commit failed: ${commitError}`} /> : null}
        <Flex align="center" gap="2" wrap="wrap">
          <Code size="2" variant="ghost">{status.branch ?? "(no branch)"}</Code>
          <Text size="2" color={status.dirty.length > 0 ? "amber" : "gray"} data-testid="spectrolite-dirty-count">
            {status.dirty.length} dirty file{status.dirty.length === 1 ? "" : "s"}
          </Text>
        </Flex>
        <TextArea
          size="3"
          placeholder="commit subject — blank line + body optional"
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          rows={4}
          aria-label="Commit message"
        />
        <Flex gap="2" wrap="wrap">
          <Button
            size="3"
            variant="soft"
            color="gray"
            onClick={() => void handleSuggest()}
            disabled={!client || status.dirty.length === 0}
            style={{ flex: 1, minHeight: 44 }}
          >
            <MagicWandIcon /> Suggest message
          </Button>
          <Button
            size="3"
            variant="solid"
            disabled={!subject || committing || status.dirty.length === 0}
            onClick={() => void handleCommit()}
            data-testid="spectrolite-commit-button"
            style={{ flex: 1, minHeight: 44 }}
          >
            <CommitIcon /> Commit
          </Button>
        </Flex>
      </Flex>
    );
  }

  return (
    <Flex
      direction="column"
      gap="1"
      px="3"
      py="1"
      style={{ borderTop: "1px solid var(--gray-5)", background: "var(--color-panel)" }}
    >
      {statusError ? <InlineGitError kind="status" message={`Git status failed: ${statusError}`} /> : null}
      {commitError ? <InlineGitError kind="commit" message={`Commit failed: ${commitError}`} /> : null}
      <Flex align="center" gap="2">
        <Code size="1" variant="ghost">{status.branch ?? "(no branch)"}</Code>
        <Text size="1" color="gray">·</Text>
        <Text size="1" color={status.dirty.length > 0 ? "amber" : "gray"} data-testid="spectrolite-dirty-count">
          {status.dirty.length} dirty
        </Text>
        <Button size="1" variant="ghost" color="gray" onClick={() => void handleSuggest()} disabled={!client || status.dirty.length === 0}>
          <MagicWandIcon /> Suggest message
        </Button>
        <TextArea
          size="1"
          placeholder="commit subject — newline + body optional"
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          rows={1}
          style={{ flex: 1 }}
          aria-label="Commit message"
        />
        <Button size="1" variant="soft" disabled={!subject || committing || status.dirty.length === 0} onClick={() => void handleCommit()} data-testid="spectrolite-commit-button">
          <CommitIcon /> Commit
        </Button>
      </Flex>
    </Flex>
  );
}

function InlineGitError({ kind, message }: { kind: string; message: string }) {
  return (
    <Callout.Root size="1" color="red" variant="soft" data-testid={`spectrolite-${kind}-error`}>
      <Callout.Text size="1">{message}</Callout.Text>
    </Callout.Root>
  );
}
