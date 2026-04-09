/**
 * useChannelMessages — React subscription to ALL channel messages (persisted + replay).
 *
 * Replaces the Pi-snapshot-derived message path. The agent worker publishes
 * Pi events as real channel messages (text, thinking, action, image, inline_ui,
 * feedback_form, feedback_custom). This hook consumes them via `client.events()`
 * and builds the flat `ChatMessage[]` array for component rendering.
 *
 * Handles both replay (historical messages on connect) and live streaming:
 * - `type: "message"` → create a new ChatMessage
 * - `type: "update-message"` → update content / mark complete
 *
 * Message mapping is based on `contentType`:
 * - No contentType (regular text) → `{ kind: "message", content }`
 * - `"thinking"` → `{ contentType: "thinking", content }`
 * - `"action"` → `{ contentType: "action", content }` (ActionData JSON)
 * - `"image"` → `{ kind: "message", contentType: "image", attachments }`
 * - `"inline_ui"` → `{ contentType: "inline_ui", content }`
 * - `"feedback_form"` / `"feedback_custom"` → existing feedback rendering
 */

import { useState, useEffect } from "react";
import type { PubSubClient, ParticipantMetadata, Attachment } from "@natstack/pubsub";
import type { ChatMessage } from "@workspace/agentic-core";

/**
 * Subscribe to a PubSubClient's event stream and build `ChatMessage[]` from
 * all persisted + replayed channel messages.
 */
export function useChannelMessages<T extends ParticipantMetadata = ParticipantMetadata>(
  client: PubSubClient<T> | null,
  selfId: string | null,
): ChatMessage[] {
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;

    // Internal state: ordered message map.
    const byId = new Map<string, ChatMessage>();
    const order: string[] = [];

    const flush = () => {
      if (cancelled) return;
      setMessages(order.map((id) => byId.get(id)!));
    };

    const consume = async () => {
      try {
        for await (const event of client.events({ includeReplay: true, includeEphemeral: false })) {
          if (cancelled) break;

          const wire = event as unknown as {
            type?: string;
            kind?: string;
            id?: string;
            senderId?: string;
            content?: string;
            contentType?: string;
            complete?: boolean;
            attachments?: Attachment[];
            senderMetadata?: { name?: string; type?: string; handle?: string };
          };

          if (wire.type === "message" && wire.id) {
            // Determine completeness: replay messages are final state.
            const isReplay = wire.kind === "replay";
            const msg: ChatMessage = {
              id: wire.id,
              senderId: wire.senderId ?? "unknown",
              content: wire.content ?? "",
              contentType: wire.contentType,
              kind: "message",
              complete: isReplay ? true : false,
              attachments: wire.attachments,
              senderMetadata: wire.senderMetadata,
            };

            if (!byId.has(wire.id)) {
              order.push(wire.id);
            }
            byId.set(wire.id, msg);
            flush();
          } else if (wire.type === "update-message" && wire.id) {
            const existing = byId.get(wire.id);
            if (existing) {
              const updated = { ...existing };
              if (wire.content !== undefined) {
                // Text messages (no contentType) use delta-append protocol.
                // Structured messages (action, etc.) use full-replacement updates.
                if (!existing.contentType) {
                  updated.content = (existing.content ?? "") + wire.content;
                } else {
                  updated.content = wire.content;
                }
              }
              if (wire.complete !== undefined) updated.complete = wire.complete;
              if (wire.attachments) updated.attachments = wire.attachments;
              byId.set(wire.id, updated);
              flush();
            }
          }
        }
      } catch (err) {
        if (!cancelled) console.error("[useChannelMessages]", err);
      }
    };
    void consume();
    return () => {
      cancelled = true;
    };
  }, [client, selfId]);

  return messages;
}
