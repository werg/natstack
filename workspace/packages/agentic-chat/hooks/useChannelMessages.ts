/**
 * useChannelMessages — React subscription to ALL channel messages (persisted + replay).
 *
 * Replaces the Pi-snapshot-derived message path. The agent worker publishes
 * Pi events as real channel messages (text, thinking, action, image, inline_ui,
 * feedback_form, feedback_custom). This hook consumes them via `client.events()`
 * and builds the flat `ChatMessage[]` array for component rendering.
 *
 * Handles both replay and live streaming:
 * - `type: "message"` → create a new ChatMessage
 * - `type: "update-message"` → update content / mark complete
 * - `type: "error"` → mark message as errored + complete
 * - `type: "execution-pause"` → mark streaming message as complete
 *
 * Supports pagination: caps visible messages at MAX_VISIBLE. When the user
 * scrolls up and requests earlier messages, fetches them via
 * `client.getMessagesBefore()` and prepends to the visible window.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { PubSubClient, ParticipantMetadata, Attachment } from "@natstack/pubsub";
import { isClientParticipantType, CONTENT_TYPE_TYPING } from "@natstack/pubsub";
import type { ChatMessage } from "@workspace/agentic-core";

/** Maximum messages in the visible window. New messages push oldest out. */
const MAX_VISIBLE = 500;
/** How many messages to fetch per pagination request. */
const PAGE_SIZE = 100;

export interface UseChannelMessagesResult {
  messages: ChatMessage[];
  hasMoreHistory: boolean;
  loadingMore: boolean;
  loadEarlierMessages: () => Promise<void>;
}

/**
 * Subscribe to a PubSubClient's event stream and build `ChatMessage[]` from
 * all persisted + replayed channel messages. Supports windowed pagination.
 */
export function useChannelMessages<T extends ParticipantMetadata = ParticipantMetadata>(
  client: PubSubClient<T> | null,
  selfId: string | null,
): UseChannelMessagesResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Refs for internal state shared between the event consumer and pagination.
  const byIdRef = useRef(new Map<string, ChatMessage>());
  const orderRef = useRef<string[]>([]);
  const cancelledRef = useRef(false);
  // Track the lowest pubsubId we've seen (for pagination anchor).
  const lowestPubsubIdRef = useRef<number | null>(null);
  // Track whether replay indicated there's more history.
  const replayTrimmedRef = useRef(false);
  const clientRef = useRef(client);
  clientRef.current = client;

  /**
   * Sync React state from internal order/byId.
   * @param trimTail When true, trim from the END (used after prepending older
   *   history so the newly loaded messages survive). Default: trim from the
   *   FRONT (used for live messages appended at the end).
   */
  const flush = useCallback((trimTail = false) => {
    if (cancelledRef.current) return;
    const byId = byIdRef.current;
    const order = orderRef.current;
    if (order.length > MAX_VISIBLE) {
      if (trimTail) {
        // Prepend path: keep the first MAX_VISIBLE (older messages stay).
        const trimmed = order.splice(MAX_VISIBLE);
        for (const id of trimmed) byId.delete(id);
      } else {
        // Append path: keep the last MAX_VISIBLE (newest messages stay).
        const trimmed = order.splice(0, order.length - MAX_VISIBLE);
        for (const id of trimmed) byId.delete(id);
      }
      setHasMoreHistory(true);
    }
    setMessages(order.map((id) => byId.get(id)!));
  }, []);

  useEffect(() => {
    if (!client) return;
    cancelledRef.current = false;
    const byId = new Map<string, ChatMessage>();
    const order: string[] = [];
    byIdRef.current = byId;
    orderRef.current = order;
    lowestPubsubIdRef.current = null;
    replayTrimmedRef.current = false;

    const consume = async () => {
      try {
        // includeEphemeral: true so we receive typing indicators from other
        // participants (contentType: "typing", persist: false).
        for await (const event of client.events({ includeReplay: true, includeEphemeral: true })) {
          if (cancelledRef.current) break;

          const wire = event as unknown as {
            type?: string;
            kind?: string;
            id?: string;
            messageId?: string;
            senderId?: string;
            content?: string;
            contentType?: string;
            replyTo?: string;
            complete?: boolean;
            error?: string;
            pubsubId?: number;
            status?: unknown;
            attachments?: Attachment[];
            senderMetadata?: { name?: string; type?: string; handle?: string };
          };

          if (wire.type === "message" && wire.id) {
            const isReplay = wire.kind === "replay";
            const isEphemeral = wire.kind === "ephemeral";
            const isFromClient = isClientParticipantType(wire.senderMetadata?.type);
            const isTyping = wire.contentType === CONTENT_TYPE_TYPING;

            // Only allow typing indicators from the ephemeral stream.
            // Worker-side notifications (notify:*, natstack-ext-status,
            // natstack-ext-widget, natstack-ext-working) are handled by
            // separate ephemeral hooks and must not leak into the transcript.
            if (isEphemeral && !isTyping) continue;
            const msg: ChatMessage = {
              id: wire.id,
              pubsubId: wire.pubsubId,
              senderId: wire.senderId ?? "unknown",
              content: wire.content ?? "",
              contentType: wire.contentType,
              replyTo: wire.replyTo,
              kind: "message",
              // Typing indicators start incomplete (stopped via update with complete:true).
              // Ephemeral messages don't replay, so they're always "live".
              // Client one-shot messages are immediately complete.
              complete: isTyping ? false : (isReplay || isFromClient),
              attachments: wire.attachments,
              senderMetadata: wire.senderMetadata,
            };

            if (!byId.has(wire.id)) {
              order.push(wire.id);
            }
            byId.set(wire.id, msg);

            // Track lowest pubsubId for pagination anchor.
            if (wire.pubsubId !== undefined) {
              if (lowestPubsubIdRef.current === null || wire.pubsubId < lowestPubsubIdRef.current) {
                lowestPubsubIdRef.current = wire.pubsubId;
              }
            }

            flush();
          } else if (wire.type === "update-message" && wire.id) {
            const existing = byId.get(wire.id);
            if (existing) {
              const updated = { ...existing };
              if (wire.content !== undefined) {
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
          } else if (wire.type === "error" && wire.id) {
            const existing = byId.get(wire.id);
            if (existing) {
              byId.set(wire.id, { ...existing, complete: true, error: wire.error ?? "Unknown error" });
              flush();
            }
          } else if (wire.type === "execution-pause") {
            const targetId = wire.messageId ?? wire.id;
            if (targetId) {
              const existing = byId.get(targetId);
              if (existing && !existing.complete) {
                byId.set(targetId, { ...existing, complete: true });
                flush();
              }
            } else {
              for (let i = order.length - 1; i >= 0; i--) {
                const msg = byId.get(order[i]!);
                if (msg && !msg.complete) {
                  byId.set(order[i]!, { ...msg, complete: true });
                  flush();
                  break;
                }
              }
            }
          }
        }
      } catch (err) {
        if (!cancelledRef.current) console.error("[useChannelMessages]", err);
      }
    };
    void consume();
    return () => {
      cancelledRef.current = true;
    };
  }, [client, selfId, flush]);

  // --- Pagination: load earlier messages ---
  const loadEarlierMessages = useCallback(async () => {
    const c = clientRef.current;
    if (!c || loadingMore) return;
    const anchor = lowestPubsubIdRef.current;
    if (anchor === null || anchor <= 1) {
      setHasMoreHistory(false);
      return;
    }

    setLoadingMore(true);
    try {
      const result = await (c as unknown as {
        getMessagesBefore: (beforeId: number, limit: number) => Promise<{
          messages: Array<{ id: number; type: string; payload: unknown; senderId: string; ts: number; senderMetadata?: Record<string, unknown>; attachments?: Attachment[] }>;
          trailingUpdates?: Array<{ id: number; type: string; payload: unknown; senderId: string; ts: number; attachments?: Attachment[] }>;
          hasMore: boolean;
        }>;
      }).getMessagesBefore(anchor, PAGE_SIZE);

      setHasMoreHistory(result.hasMore);

      const byId = byIdRef.current;
      const order = orderRef.current;

      // Parse older messages and prepend.
      const prepend: string[] = [];
      for (const raw of result.messages) {
        const payload = raw.payload as Record<string, unknown> | undefined;
        if (raw.type !== "message" || !payload) continue;
        const msgId = (payload["id"] as string) ?? `pubsub-${raw.id}`;
        if (byId.has(msgId)) continue; // dedup

        const msg: ChatMessage = {
          id: msgId,
          pubsubId: raw.id,
          senderId: raw.senderId,
          content: (payload["content"] as string) ?? "",
          contentType: payload["contentType"] as string | undefined,
          replyTo: payload["replyTo"] as string | undefined,
          kind: "message",
          complete: true,
          attachments: raw.attachments as Attachment[] | undefined,
          senderMetadata: raw.senderMetadata as ChatMessage["senderMetadata"],
        };

        // Apply trailing updates (content appended, complete flag, errors).
        if (result.trailingUpdates) {
          for (const upd of result.trailingUpdates) {
            const updPayload = upd.payload as Record<string, unknown> | undefined;
            if (!updPayload || (updPayload["id"] as string) !== msgId) continue;
            if (updPayload["content"] !== undefined) {
              if (!msg.contentType) {
                msg.content += updPayload["content"] as string;
              } else {
                msg.content = updPayload["content"] as string;
              }
            }
            if (updPayload["complete"] !== undefined) msg.complete = updPayload["complete"] as boolean;
            if (updPayload["error"] !== undefined) msg.error = updPayload["error"] as string;
          }
        }

        byId.set(msgId, msg);
        prepend.push(msgId);

        if (raw.id < (lowestPubsubIdRef.current ?? Infinity)) {
          lowestPubsubIdRef.current = raw.id;
        }
      }

      if (prepend.length > 0) {
        orderRef.current = [...prepend, ...order];
        flush(true); // trimTail: keep older messages, trim newest if over limit
      }
    } catch (err) {
      console.error("[useChannelMessages] loadEarlierMessages failed:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, flush]);

  return { messages, hasMoreHistory, loadingMore, loadEarlierMessages };
}
