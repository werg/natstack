import { Badge, Button, Flex, Text, TextField } from "@radix-ui/themes";
import {
  ArchiveIcon,
  EnvelopeClosedIcon,
  MagnifyingGlassIcon,
  Pencil1Icon,
  ReloadIcon,
} from "@radix-ui/react-icons";
import { useEffect, useState } from "react";

interface GmailActionBarProps {
  chat: {
    callMethodByHandle: (handle: string, method: string, args: unknown) => Promise<unknown>;
  };
}

interface ActionableThread {
  threadId: string;
  subject?: string;
}

export default function GmailActionBar({ chat }: GmailActionBarProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [threads, setThreads] = useState<ActionableThread[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(label: string, method: string, args: unknown = {}, success?: string) {
    setBusy(label);
    setError(null);
    try {
      const result = await chat.callMethodByHandle("gmail", method, args);
      setStatus(success ?? null);
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function refreshQueue(cancelled?: () => boolean) {
    try {
      const result = await chat.callMethodByHandle("gmail", "listActionableThreads", { limit: 3 });
      if (cancelled?.() || !Array.isArray(result)) return;
      setThreads(
        result.filter((item): item is ActionableThread =>
          Boolean(item && typeof item === "object" && "threadId" in item)
        )
      );
    } catch (err) {
      if (!cancelled?.()) setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    let cancelled = false;
    void refreshQueue(() => cancelled).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [chat]);

  return (
    <Flex direction="column" gap="2" p="2">
      <Flex align="center" gap="2" wrap="wrap">
        <Flex align="center" gap="1">
          <EnvelopeClosedIcon />
          <Text size="2" weight="bold">Gmail</Text>
          {threads.length > 0 ? <Badge size="1" color="red">{threads.length}</Badge> : null}
        </Flex>
        <Button
          size="1"
          variant="soft"
          disabled={busy !== null}
          title="Check now"
          onClick={() =>
            void run("check", "checkNow", {}, "Inbox checked").then(() => refreshQueue())
          }
        >
          <ReloadIcon /> {busy === "check" ? "Checking" : "Check"}
        </Button>
        <Button
          size="1"
          variant="soft"
          disabled={busy !== null}
          title="Compose"
          onClick={() => void run("compose", "compose", {}, "Compose card created")}
        >
          <Pencil1Icon /> Compose
        </Button>
        <Flex align="center" gap="1" style={{ minWidth: 220, flex: "1 1 280px" }}>
          <TextField.Root
            size="1"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search mail"
            style={{ flex: 1 }}
          />
          <Button
            size="1"
            disabled={busy !== null || query.trim().length === 0}
            title="Search"
            onClick={() => void run("search", "search", { q: query.trim() }, "Search updated")}
          >
            <MagnifyingGlassIcon /> Search
          </Button>
        </Flex>
      </Flex>
      {threads.length > 0 ? (
        <Flex gap="1" align="center" wrap="wrap">
          <Text size="1" color="gray">Queue</Text>
          {threads.map((thread) => (
            <Button
              key={thread.threadId}
              size="1"
              variant="ghost"
              disabled={busy !== null}
              title={`Draft reply: ${thread.subject ?? thread.threadId}`}
              onClick={() =>
                void run(
                  `draft:${thread.threadId}`,
                  "draftReply",
                  { threadId: thread.threadId },
                  "Reply draft created"
                )
              }
            >
              <Pencil1Icon /> {thread.subject ?? thread.threadId}
            </Button>
          ))}
          <Button
            size="1"
            variant="ghost"
            disabled={busy !== null || threads.length === 0}
            title="Archive first queued thread"
            onClick={() =>
              void run(
                "archive-first",
                "archiveThread",
                { threadId: threads[0]?.threadId },
                "Archived first queued thread"
              ).then(() => refreshQueue())
            }
          >
            <ArchiveIcon /> Archive next
          </Button>
        </Flex>
      ) : null}
      {status && !error ? <Text size="1" color="gray">{status}</Text> : null}
      {error ? <Text size="1" color="red">{error}</Text> : null}
    </Flex>
  );
}
