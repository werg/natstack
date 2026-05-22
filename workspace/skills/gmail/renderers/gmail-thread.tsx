import { Badge, Button, Flex, Text, TextArea } from "@radix-ui/themes";
import { useState } from "react";
import { reduce, type GmailThreadState } from "@workspace/gmail/renderers/gmail-thread.reducer";

export { reduce };

interface ThreadBody {
  messages: Array<{ id: string; from?: string; date?: string; snippet?: string; bodyText?: string }>;
}

export function Pill({ state }: { state: GmailThreadState }) {
  return (
    <Flex align="center" gap="1">
      <Text size="1" weight="medium">{state.subject}</Text>
      <Text size="1" color="gray">{state.lastSnippet}</Text>
      {state.unreadCount > 0 ? <Badge size="1" color="blue">{state.unreadCount}</Badge> : null}
    </Flex>
  );
}

export default function GmailThread({ state, expanded, chat }: {
  state: GmailThreadState;
  expanded: boolean;
  chat: { callMethodByHandle: (handle: string, method: string, args: unknown) => Promise<unknown> };
}) {
  const [thread, setThread] = useState<ThreadBody | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);

  async function loadThread() {
    if (thread || loading) return;
    setLoading(true);
    try {
      const result = await chat.callMethodByHandle("gmail", "getThread", { threadId: state.threadId });
      if (result && typeof result === "object" && Array.isArray((result as ThreadBody).messages)) {
        setThread(result as ThreadBody);
      }
    } finally {
      setLoading(false);
    }
  }

  if (!expanded) {
    return <Pill state={state} />;
  }

  return (
    <Flex direction="column" gap="2" onClick={() => void loadThread()}>
      <Flex align="center" justify="between" gap="2">
        <Text size="3" weight="bold">{state.subject}</Text>
        <Badge color={state.status === "archived" ? "gray" : "blue"}>{state.status}</Badge>
      </Flex>
      <Text size="2" color="gray">{state.participants.join(", ")}</Text>
      {thread ? (
        <Flex direction="column" gap="2">
          {thread.messages.map((message) => (
            <Flex key={message.id} direction="column" gap="1">
              <Text size="1" color="gray">{message.from} {message.date}</Text>
              <Text size="2">{message.bodyText ?? message.snippet}</Text>
            </Flex>
          ))}
        </Flex>
      ) : (
        <Text size="2" color="gray">{loading ? "Loading thread..." : state.lastSnippet}</Text>
      )}
      <TextArea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Draft reply" />
      <Flex gap="2" wrap="wrap">
        <Button size="1" onClick={() => chat.callMethodByHandle("gmail", "draftReply", { threadId: state.threadId })}>
          AI draft
        </Button>
        <Button size="1" variant="soft" disabled={!draft.trim()} onClick={() => chat.callMethodByHandle("gmail", "send", {
          threadId: state.threadId,
          body: draft,
        })}>
          Send
        </Button>
        <Button size="1" variant="ghost" onClick={() => setDraft("")}>Discard</Button>
      </Flex>
    </Flex>
  );
}
