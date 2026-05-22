import { Box, Button, Flex, Text, TextField } from "@radix-ui/themes";
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

  async function run(label: string, method: string, args: unknown = {}) {
    setBusy(label);
    try {
      return await chat.callMethodByHandle("gmail", method, args);
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void chat.callMethodByHandle("gmail", "listActionableThreads", { limit: 4 })
      .then((result) => {
        if (cancelled || !Array.isArray(result)) return;
        setThreads(result.filter((item): item is ActionableThread =>
          Boolean(item && typeof item === "object" && "threadId" in item)
        ));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [chat]);

  return (
    <Flex direction="column" gap="2" p="2">
      <Flex align="center" gap="2" wrap="wrap">
        <Text size="2" weight="bold">Gmail</Text>
        <Button size="1" variant="soft" disabled={busy !== null} onClick={() => run("check", "checkNow")}>
          {busy === "check" ? "Checking..." : "Check now"}
        </Button>
        <Button size="1" variant="soft" disabled={busy !== null} onClick={() => run("compose", "compose")}>
          Compose
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
            onClick={() => run("search", "search", { q: query.trim() })}
          >
            Search
          </Button>
        </Flex>
      </Flex>
      {threads.length > 0 ? (
        <Flex gap="1" wrap="wrap">
          <Text size="1" color="gray">Quick reply</Text>
          {threads.map((thread) => (
            <Button
              key={thread.threadId}
              size="1"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => run(thread.threadId, "draftReply", { threadId: thread.threadId })}
            >
              {busy === thread.threadId ? "Drafting..." : thread.subject ?? thread.threadId}
            </Button>
          ))}
        </Flex>
      ) : (
        <Box />
      )}
    </Flex>
  );
}
