import { Badge, Button, Callout, Flex, Text, TextArea, TextField } from "@radix-ui/themes";
import { ExclamationTriangleIcon, PaperPlaneIcon } from "@radix-ui/react-icons";
import { useEffect, useState } from "react";
import type { GmailComposeCardState } from "@workspace/gmail/card-types";

type GmailComposeState = Partial<GmailComposeCardState>;

export function reduce(state: GmailComposeState, update: Partial<GmailComposeState>): GmailComposeState {
  return { ...state, ...update };
}

export function Pill({ state }: { state: GmailComposeState }) {
  return (
    <Flex align="center" gap="1">
      <Text size="1" weight="medium">Compose</Text>
      <Text size="1" color="gray">{state.subject || "(no subject)"}</Text>
      {state.status ? <StatusBadge status={state.status} /> : null}
    </Flex>
  );
}

export default function GmailCompose({
  state,
  expanded,
  messageId,
  chat,
}: {
  state: GmailComposeState;
  expanded: boolean;
  messageId: string;
  chat: { callMethodByHandle: (handle: string, method: string, args: unknown) => Promise<unknown> };
}) {
  const [to, setTo] = useState(state.to ?? "");
  const [cc, setCc] = useState(state.cc ?? "");
  const [bcc, setBcc] = useState(state.bcc ?? "");
  const [subject, setSubject] = useState(state.subject ?? "");
  const [body, setBody] = useState(state.body ?? "");
  const [reviewingSend, setReviewingSend] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setTo(state.to ?? "");
    setCc(state.cc ?? "");
    setBcc(state.bcc ?? "");
    setSubject(state.subject ?? "");
    setBody(state.body ?? "");
  }, [state.to, state.cc, state.bcc, state.subject, state.body]);

  if (!expanded) return <Pill state={{ ...state, subject }} />;

  const disabled =
    busy !== null ||
    state.status === "sending" ||
    state.status === "sent" ||
    state.status === "discarded";

  const payload = {
    messageId,
    to,
    cc,
    bcc,
    subject,
    body,
    threadId: state.threadId,
    sourceThreadId: state.sourceThreadId,
  };

  async function call(method: string, args: unknown, label: string) {
    setBusy(label);
    setLocalError(null);
    try {
      await chat.callMethodByHandle("gmail", method, args);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Flex direction="column" gap="2">
      <Flex align="center" justify="between" gap="2">
        <Text size="3" weight="bold">{state.threadId ? "Reply" : "Compose"}</Text>
        {state.status ? <StatusBadge status={state.status} /> : null}
      </Flex>
      {state.status === "review" ? (
        <Callout.Root color="amber" size="1">
          <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
          <Callout.Text>
            Agent-drafted mail — review the recipient, subject, and body before sending. Nothing
            is sent until you click Send.
          </Callout.Text>
        </Callout.Root>
      ) : null}
      {state.error || localError ? (
        <Callout.Root color="red" size="1">
          <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
          <Callout.Text>{state.error ?? localError}</Callout.Text>
        </Callout.Root>
      ) : null}
      <TextField.Root
        value={to}
        onChange={(event) => setTo(event.target.value)}
        placeholder="To"
        disabled={disabled}
      />
      <Flex gap="2" wrap="wrap">
        <TextField.Root
          value={cc}
          onChange={(event) => setCc(event.target.value)}
          placeholder="Cc"
          disabled={disabled}
          style={{ flex: "1 1 180px" }}
        />
        <TextField.Root
          value={bcc}
          onChange={(event) => setBcc(event.target.value)}
          placeholder="Bcc"
          disabled={disabled}
          style={{ flex: "1 1 180px" }}
        />
      </Flex>
      <TextField.Root
        value={subject}
        onChange={(event) => setSubject(event.target.value)}
        placeholder="Subject"
        disabled={disabled}
      />
      <TextArea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Body"
        disabled={disabled}
        style={{ minHeight: 160 }}
      />
      <Flex gap="2" wrap="wrap">
        {reviewingSend ? (
          <Callout.Root color="amber" size="1" style={{ width: "100%" }}>
            <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
            <Callout.Text>
              Sending to {to || "(missing recipient)"} with subject {subject || "(no subject)"}.
            </Callout.Text>
          </Callout.Root>
        ) : null}
        <Button
          size="1"
          disabled={disabled || !to.trim() || !subject.trim() || !body.trim()}
          title="Send"
          onClick={() => {
            // A review-state card is already the review step; Send is the
            // user's authorization. Manual composes keep the two-click confirm.
            if (state.status !== "review" && !reviewingSend) {
              setReviewingSend(true);
              return;
            }
            void call("send", payload, "send");
          }}
        >
          <PaperPlaneIcon />{" "}
          {busy === "send" || state.status === "sending"
            ? "Sending"
            : state.status === "review"
              ? "Send"
              : reviewingSend
                ? "Confirm send"
                : "Review send"}
        </Button>
        <Button
          size="1"
          variant="soft"
          disabled={disabled || !to.trim() || !subject.trim() || !body.trim()}
          onClick={() => void call("saveDraft", payload, "draft")}
        >
          {busy === "draft" ? "Saving" : state.status === "saved" ? "Saved" : "Save draft"}
        </Button>
        <Button
          size="1"
          variant="ghost"
          color="red"
          disabled={disabled}
          onClick={() => void call("discardCompose", { messageId }, "discard")}
        >
          Discard
        </Button>
      </Flex>
    </Flex>
  );
}

function StatusBadge({ status }: { status: NonNullable<GmailComposeState["status"]> }) {
  const color =
    status === "sent" || status === "saved"
      ? "green"
      : status === "error"
        ? "red"
        : status === "discarded"
          ? "gray"
          : "gray";
  return <Badge color={color}>{status}</Badge>;
}
