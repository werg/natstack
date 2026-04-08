/**
 * useChannelEphemeralMessages — React subscription to a channel's ephemeral
 * message stream, filtered by contentType.
 *
 * Used by `usePiSessionSnapshot` and `usePiTextDeltas` to consume the
 * worker's snapshot/text-delta streams. The returned messages are an array
 * with `{ ts, content, contentType }` shape compatible with `parseEphemeralEvent`.
 */

import { useState, useEffect } from "react";
import type { PubSubClient, ParticipantMetadata } from "@natstack/pubsub";

export interface EphemeralWireMessage {
  ts: number;
  content: string;
  contentType?: string;
}

/**
 * Subscribe to a PubSubClient's incoming message stream and collect every
 * ephemeral message whose `contentType` matches `expectedContentType`.
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
        for await (const msg of client.messages()) {
          if (cancelled) break;
          const wire = msg as unknown as {
            kind?: string;
            type?: string;
            payload?: { content?: string; contentType?: string };
            ts?: number;
            contentType?: string;
            content?: string;
          };
          if (wire.kind !== "ephemeral") continue;
          // Pubsub wire shape: payload may carry { content, contentType } or
          // the message may have top-level content/contentType. Try both.
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
