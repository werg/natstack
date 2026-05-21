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
import { Button, Code, Flex, Text, TextField } from "@radix-ui/themes";
import { CommitIcon, MagicWandIcon } from "@radix-ui/react-icons";
import { GitClient, type FsPromisesLike } from "@natstack/git";
import { gitConfig, contextId as runtimeContextId } from "@workspace/runtime";
import type { PubSubClient } from "@workspace/pubsub";
import { KB_COMMIT_TYPE } from "../messages/register";

export interface CommitStripProps {
  repoRoot: string;
  /** PubSub client for publishing kb.commit + sending suggestion prompts. */
  client: PubSubClient | null;
  /** Handle of the resident agent we ask for a commit message. */
  primaryAgentHandle?: string;
  /** Bumped after every successful commit so consumers can refresh status. */
  onCommitted?: (sha: string) => void;
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

export function CommitStrip({ repoRoot, client, primaryAgentHandle, onCommitted }: CommitStripProps) {
  const [status, setStatus] = useState<DirtyStatus>({ dirty: [], branch: undefined });
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
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
      } catch (err) {
        if (!cancelled) console.debug("[Spectrolite] git status failed:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [repoRoot, nonce]);

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
    const subject = message.split("\n", 1)[0]?.trim();
    if (!subject) return;
    setCommitting(true);
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
      setMessage("");
      setNonce((n) => n + 1);
      onCommitted?.(shaStr);
    } catch (err) {
      console.warn("[Spectrolite] commit failed:", err);
    } finally {
      setCommitting(false);
    }
  }, [client, message, repoRoot, status.dirty, onCommitted]);

  return (
    <Flex
      align="center"
      gap="2"
      px="3"
      py="1"
      style={{ borderTop: "1px solid var(--gray-5)", background: "var(--color-panel)" }}
    >
      <Code size="1" variant="ghost">{status.branch ?? "(no branch)"}</Code>
      <Text size="1" color="gray">·</Text>
      <Text size="1" color={status.dirty.length > 0 ? "amber" : "gray"}>
        {status.dirty.length} dirty
      </Text>
      <Button size="1" variant="ghost" color="gray" onClick={() => void handleSuggest()} disabled={!client || status.dirty.length === 0}>
        <MagicWandIcon /> Suggest message
      </Button>
      <TextField.Root
        size="1"
        placeholder="commit subject — newline + body optional"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        style={{ flex: 1 }}
      />
      <Button size="1" variant="soft" disabled={!message.trim() || committing || status.dirty.length === 0} onClick={() => void handleCommit()}>
        <CommitIcon /> Commit
      </Button>
    </Flex>
  );
}
