import { Badge, Button, Flex, Text, TextArea } from "@radix-ui/themes";
import { useState } from "react";
import type {
  GmailThreadState,
  GmailThreadUpdate,
} from "@workspace/gmail/renderers/gmail-thread.reducer";

// Inlined copy of @workspace/gmail's gmail-thread reducer. Sandbox renderers
// must be self-contained at runtime: a value import of a workspace package
// forces a build-service round trip on every card compile (type-only imports
// are erased and free). Keep in sync with
// packages/gmail/src/renderers/gmail-thread.reducer.ts — GMAIL_THREAD_UPDATE_SCHEMA
// validates the update shapes on both sides.
export function reduce(state: GmailThreadState, update: GmailThreadUpdate): GmailThreadState {
  if (!("kind" in update) || typeof update.kind !== "string") {
    return { ...state, ...update };
  }
  switch (update.kind) {
    case "newMessage": {
      const messages = [...(state.messages ?? []), update.message];
      return {
        ...state,
        messages,
        lastSnippet: update.lastSnippet ?? update.message.snippet ?? state.lastSnippet,
        unreadCount: update.unreadCount ?? state.unreadCount + 1,
        status: state.status === "archived" ? "open" : state.status,
      };
    }
    case "labelChange":
      return {
        ...state,
        labelIds: update.labelIds,
        unreadCount: update.unreadCount ?? state.unreadCount,
        category: update.category ?? state.category,
      };
    case "draftSet":
      return {
        ...state,
        hasDraft: Boolean(update.draftBody),
      };
    case "statusChange":
      return {
        ...state,
        status: update.status,
      };
    default:
      return state;
  }
}

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
  const [busy, setBusy] = useState<string | null>(null);
  const [reviewingSend, setReviewingSend] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadThread() {
    if (thread || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await chat.callMethodByHandle("gmail", "getThread", { threadId: state.threadId });
      if (result && typeof result === "object" && Array.isArray((result as ThreadBody).messages)) {
        setThread(result as ThreadBody);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function call(method: string, args: unknown, label: string) {
    setBusy(label);
    setError(null);
    try {
      await chat.callMethodByHandle("gmail", method, args);
      if (method === "send") setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (!expanded) {
    return <Pill state={state} />;
  }

  return (
    <Flex direction="column" gap="2">
      <Flex align="center" justify="between" gap="2">
        <Text size="3" weight="bold">{state.subject}</Text>
        <Badge color={state.status === "archived" ? "gray" : "blue"}>{state.status}</Badge>
      </Flex>
      <Text size="2" color="gray">{state.participants.join(", ")}</Text>
      {error ? <Text size="1" color="red">{error}</Text> : null}
      {thread ? (
        <Flex direction="column" gap="2">
          {thread.messages.map((message) => (
            <Flex key={message.id} direction="column" gap="1">
              <Text size="1" color="gray">{message.from} {message.date}</Text>
              <Text size="2" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {message.bodyText ?? message.snippet}
              </Text>
            </Flex>
          ))}
        </Flex>
      ) : (
        <Text size="2" color="gray">{loading ? "Loading thread..." : state.lastSnippet}</Text>
      )}
      <TextArea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Draft reply" />
      <Flex gap="2" wrap="wrap">
        <Button size="1" variant="soft" disabled={loading || busy !== null} onClick={() => void loadThread()}>
          {loading ? "Loading" : thread ? "Refresh thread" : "Load thread"}
        </Button>
        <Button
          size="1"
          disabled={busy !== null}
          onClick={() => void call("draftReply", { threadId: state.threadId }, "draft")}
        >
          {busy === "draft" ? "Drafting" : "AI draft"}
        </Button>
        <Button
          size="1"
          variant="soft"
          disabled={!draft.trim() || busy !== null}
          onClick={() => {
            if (!reviewingSend) {
              setReviewingSend(true);
              return;
            }
            void call("send", { threadId: state.threadId, body: draft }, "send");
          }}
        >
          {busy === "send" ? "Sending" : reviewingSend ? "Confirm send" : "Review send"}
        </Button>
        <Button
          size="1"
          variant="ghost"
          disabled={busy !== null}
          onClick={() => void call("markRead", { threadId: state.threadId }, "read")}
        >
          Mark read
        </Button>
        <Button
          size="1"
          variant="ghost"
          disabled={busy !== null}
          onClick={() => void call("archiveThread", { threadId: state.threadId }, "archive")}
        >
          Archive
        </Button>
        <Button size="1" variant="ghost" onClick={() => setDraft("")}>Discard</Button>
      </Flex>
    </Flex>
  );
}
