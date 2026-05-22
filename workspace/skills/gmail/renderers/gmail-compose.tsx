import { Badge, Button, Flex, Text, TextArea, TextField } from "@radix-ui/themes";
import { useState } from "react";

interface GmailComposeState {
  to?: string;
  subject?: string;
  body?: string;
  threadId?: string;
  sourceThreadId?: string;
  status?: "draft" | "sending" | "sent" | "error";
  error?: string;
}

export function reduce(state: GmailComposeState, update: Partial<GmailComposeState>): GmailComposeState {
  return { ...state, ...update };
}

export function Pill({ state }: { state: GmailComposeState }) {
  return (
    <Flex align="center" gap="1">
      <Text size="1" weight="medium">Compose</Text>
      <Text size="1" color="gray">{state.subject || "(no subject)"}</Text>
      {state.status ? <Badge size="1" color={state.status === "sent" ? "green" : "gray"}>{state.status}</Badge> : null}
    </Flex>
  );
}

export default function GmailCompose({ state, expanded, messageId, chat }: {
  state: GmailComposeState;
  expanded: boolean;
  messageId: string;
  chat: { callMethodByHandle: (handle: string, method: string, args: unknown) => Promise<unknown> };
}) {
  const [to, setTo] = useState(state.to ?? "");
  const [subject, setSubject] = useState(state.subject ?? "");
  const [body, setBody] = useState(state.body ?? "");

  if (!expanded) {
    return <Pill state={{ ...state, subject }} />;
  }

  return (
    <Flex direction="column" gap="2">
      <Flex align="center" justify="between">
        <Text size="3" weight="bold">Compose</Text>
        {state.status ? <Badge color={state.status === "sent" ? "green" : "gray"}>{state.status}</Badge> : null}
      </Flex>
      <TextField.Root value={to} onChange={(event) => setTo(event.target.value)} placeholder="To" />
      <TextField.Root value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Subject" />
      <TextArea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Body" style={{ minHeight: 140 }} />
      <Flex gap="2">
        <Button
          size="1"
          disabled={!to.trim() || !subject.trim() || !body.trim()}
          onClick={() => chat.callMethodByHandle("gmail", "send", {
            messageId,
            to,
            subject,
            body,
            threadId: state.threadId,
            sourceThreadId: state.sourceThreadId,
          })}
        >
          Send
        </Button>
      </Flex>
    </Flex>
  );
}
