/**
 * useChannelEphemeralMessages — React subscription to a channel's ephemeral
 * message stream, filtered by contentType.
 *
 * Used for ephemeral channel events (notifications, ext-status, ext-widget,
 * ext-working). The returned messages are an array with
 * `{ ts, content, contentType }` shape compatible with `parseEphemeralEvent`.
 *
 * Uses `client.events({ includeEphemeral: true })` instead of
 * `client.messages()` because `messages()` is a single-consumer async
 * generator — multiple hooks calling it race on a shared queue and lose
 * messages. `events()` uses a fanout that supports multiple subscribers.
 */

import { useState, useEffect } from "react";
import type { PubSubClient, ParticipantMetadata } from "@natstack/pubsub";

export interface EphemeralWireMessage {
  ts: number;
  content: string;
  contentType?: string;
}

/**
 * Subscribe to a PubSubClient's event stream and collect every ephemeral
 * event whose `contentType` matches `expectedContentType`.
 * Returns a growing array as new messages arrive.
 *
 * The hook keeps the last 200 matching messages to avoid unbounded growth.
 */
export function useChannelEphemeralMessages<T extends ParticipantMetadata = ParticipantMetadata>(
  client: PubSubClient<T> | null,
  expectedContentType: string,
): ReadonlyArray<EphemeralWireMessage> {
  const [messages, setMessages] = useState<EphemeralWireMessage[]>([]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const consume = async () => {
      try {
        // Use events() with includeEphemeral so we get ephemerals via the
        // fanout (supports multiple concurrent subscribers).
        for await (const event of client.events({ includeEphemeral: true })) {
          if (cancelled) break;
          const wire = event as unknown as {
            kind?: string;
            type?: string;
            payload?: { content?: string; contentType?: string };
            ts?: number;
            contentType?: string;
            content?: string;
          };
          if (wire.kind !== "ephemeral") continue;
          // Pubsub wire shape: IncomingNewMessage has top-level
          // content/contentType; raw protocol may nest them in payload.
          const content =
            wire.content ?? wire.payload?.content ?? "";
          const contentType =
            wire.contentType ?? wire.payload?.contentType;
          if (contentType !== expectedContentType) continue;
          if (!content) continue;
          const ts = wire.ts ?? Date.now();
          setMessages((prev) => {
            const next = [...prev, { ts, content, contentType }];
            // Cap at 200 to avoid unbounded growth.
            if (next.length > 200) next.shift();
            return next;
          });
        }
      } catch (err) {
        if (!cancelled) console.error("[useChannelEphemeralMessages]", err);
      }
    };
    void consume();
    return () => {
      cancelled = true;
    };
  }, [client, expectedContentType]);

  return messages;
}
