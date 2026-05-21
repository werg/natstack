/**
 * Minimal chat drawer for talking to resident agents OUTSIDE the document.
 *
 * Spectrolite's primary surface is the editor; this drawer is a small
 * collapsible strip at the bottom for free-form requests (e.g. "summarise
 * the doc", "what changed last hour") and for receiving brief agent
 * replies. Most of the back-and-forth happens via `kb.user_edit` messages
 * and agent file edits — this drawer is the escape hatch.
 *
 * Subscribes directly to the PubSubClient's event stream rather than going
 * through `useChannelMessages` from `@workspace/agentic-chat` because that
 * hook isn't exposed at the package root. The drawer only renders plain
 * text messages — custom messages (kb.user_edit / kb.commit) show up in
 * proper chat panels that observe this channel.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { PubSubClient } from "@workspace/pubsub";
import { Box, Button, Card, Flex, ScrollArea, Text, TextArea } from "@radix-ui/themes";
import { ChevronUpIcon, ChevronDownIcon, PaperPlaneIcon } from "@radix-ui/react-icons";

interface DrawerMessage {
  id: string;
  senderId: string;
  senderHandle?: string;
  senderName?: string;
  content: string;
  ts: number;
}

const MAX_DRAWER_MESSAGES = 50;

function readContent(payload: unknown): string | null {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (typeof p["content"] === "string") return p["content"] as string;
    if (typeof p["text"] === "string") return p["text"] as string;
  }
  return null;
}

export interface ChannelDrawerProps {
  client: PubSubClient | null;
  onSend?: (content: string) => void;
}

export function ChannelDrawer({ client, onSend }: ChannelDrawerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [messages, setMessages] = useState<DrawerMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    (async () => {
      try {
        for await (const event of client.events({ includeReplay: true, includeSignals: false })) {
          if (cancelled) return;
          const wire = event as unknown as {
            messageId?: string;
            type?: string;
            senderId?: string;
            senderMetadata?: { handle?: string; name?: string };
            ts?: number;
            payload?: unknown;
          };
          if (wire.type !== "message" && wire.type !== "agentic.trajectory.v1/event") continue;
          const content = readContent(wire.payload);
          if (!content) continue;
          const id = wire.messageId ?? `${wire.senderId ?? "?"}-${wire.ts ?? Date.now()}`;
          setMessages((prev) => {
            if (prev.some((m) => m.id === id)) return prev;
            const next = [...prev, {
              id,
              senderId: wire.senderId ?? "?",
              senderHandle: wire.senderMetadata?.handle,
              senderName: wire.senderMetadata?.name,
              content,
              ts: wire.ts ?? Date.now(),
            }];
            return next.slice(-MAX_DRAWER_MESSAGES);
          });
        }
      } catch (err) {
        if (!cancelled) console.warn("[Spectrolite] channel event stream ended:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [client]);

  const recent = useMemo(() => messages.slice(-MAX_DRAWER_MESSAGES), [messages]);

  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, recent.length]);

  const send = async () => {
    const content = draft.trim();
    if (!content || !client) return;
    setSending(true);
    try {
      await client.send(content);
      setDraft("");
      onSend?.(content);
    } catch (err) {
      console.warn("[Spectrolite] send failed:", err);
    } finally {
      setSending(false);
    }
  };

  return (
    <Box
      style={{
        borderTop: "1px solid var(--gray-5)",
        background: "var(--color-panel-translucent)",
        flexShrink: 0,
      }}
    >
      <Flex
        align="center"
        justify="between"
        gap="2"
        px="3"
        py="1"
        style={{ cursor: "pointer", borderBottom: open ? "1px solid var(--gray-5)" : "none" }}
        onClick={() => setOpen((v) => !v)}
      >
        <Flex align="center" gap="2">
          {open ? <ChevronDownIcon /> : <ChevronUpIcon />}
          <Text size="1" color="gray" weight="medium">Channel</Text>
          {!open && recent.length > 0 ? (
            <Text size="1" color="gray">· {recent.length} messages</Text>
          ) : null}
        </Flex>
      </Flex>
      {open ? (
        <Flex direction="column" gap="2" p="2" style={{ maxHeight: "30vh" }}>
          <Box ref={scrollRef} style={{ maxHeight: "20vh", overflowY: "auto" }}>
            <ScrollArea>
              <Flex direction="column" gap="1">
                {recent.length === 0 ? (
                  <Text size="1" color="gray">No messages yet.</Text>
                ) : (
                  recent.map((m) => (
                    <Card key={m.id} size="1">
                      <Flex direction="column" gap="1">
                        <Text size="1" color="gray" weight="medium">
                          @{m.senderHandle ?? m.senderName ?? m.senderId}
                        </Text>
                        <Text size="1" style={{ whiteSpace: "pre-wrap" }}>{m.content}</Text>
                      </Flex>
                    </Card>
                  ))
                )}
              </Flex>
            </ScrollArea>
          </Box>
          <Flex gap="1" align="end">
            <TextArea
              size="1"
              placeholder="Talk to the agents…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
              }}
              style={{ flex: 1 }}
              rows={2}
            />
            <Button size="1" variant="soft" disabled={!draft.trim() || sending || !client} onClick={() => void send()}>
              <PaperPlaneIcon />
            </Button>
          </Flex>
        </Flex>
      ) : null}
    </Box>
  );
}
