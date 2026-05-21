/**
 * useChannelMessages — React subscription to transcript channel messages.
 *
 * Consumes canonical agentic trajectory events from opaque channel envelopes
 * and reduces them into the flat ChatMessage[] array used by the transcript UI.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { PubSubClient, ParticipantMetadata } from "@workspace/pubsub";
import {
  actionBarPayloadFromChannelView,
  type ActionBarPayload,
  type ChatMessage,
  chatMessagesFromChannelView,
} from "@workspace/agentic-core";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  createInitialChannelViewState,
  reduceChannelView,
  type AgenticEvent,
  type ChannelEnvelope,
  type ChannelViewState,
} from "@workspace/agentic-protocol";

/** Maximum messages in the visible window. New messages push oldest out. */
const MAX_VISIBLE = 500;
/** How many messages to fetch per pagination request. */
const PAGE_SIZE = 100;

export interface UseChannelMessagesResult {
  messages: ChatMessage[];
  actionBar: ActionBarPayload | null;
  hasMoreHistory: boolean;
  loadingMore: boolean;
  loadEarlierMessages: () => Promise<void>;
  backfillAfterLocalPublish: (pubsubId: number | undefined) => Promise<void>;
}

/**
 * Subscribe to a PubSubClient's event stream and build `ChatMessage[]` from
 * all durable + replayed channel messages. Supports windowed pagination.
 */
export function useChannelMessages<T extends ParticipantMetadata = ParticipantMetadata>(
  client: PubSubClient<T> | null,
): UseChannelMessagesResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [actionBar, setActionBar] = useState<ActionBarPayload | null>(null);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Refs for internal state shared between the event consumer and pagination.
  const byIdRef = useRef(new Map<string, ChatMessage>());
  const orderRef = useRef<string[]>([]);
  const cancelledRef = useRef(false);
  // Track the lowest pubsubId we've seen (for pagination anchor).
  const oldestRootIdRef = useRef<number | null>(null);
  const clientRef = useRef(client);
  const channelStateRef = useRef<ChannelViewState>(createInitialChannelViewState());
  const agenticMessageIdsRef = useRef(new Set<string>());
  const newestSeqRef = useRef<number | null>(null);
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
    setActionBar(actionBarPayloadFromChannelView(channelStateRef.current));
  }, []);

  const rebuildFromChannelState = useCallback((trimTail = false) => {
    const byId = byIdRef.current;
    const order = orderRef.current;
    for (const id of agenticMessageIdsRef.current) {
      byId.delete(id);
      const index = order.indexOf(id);
      if (index >= 0) order.splice(index, 1);
    }
    agenticMessageIdsRef.current.clear();
    for (const msg of chatMessagesFromChannelView(channelStateRef.current)) {
      if (!byId.has(msg.id)) order.push(msg.id);
      byId.set(msg.id, msg);
      agenticMessageIdsRef.current.add(msg.id);
    }
    flush(trimTail);
  }, [flush]);

  useEffect(() => {
    if (!client) return;
    cancelledRef.current = false;
    const byId = new Map<string, ChatMessage>();
    const order: string[] = [];
    byIdRef.current = byId;
    orderRef.current = order;
    oldestRootIdRef.current = null;
    newestSeqRef.current = null;
    channelStateRef.current = createInitialChannelViewState();
    agenticMessageIdsRef.current = new Set();
    setHasMoreHistory(Boolean(client.hasMoreBefore));

    const consume = async () => {
      try {
        for await (const event of client.events({ includeReplay: true, includeSignals: true })) {
          if (cancelledRef.current) break;

          const wire = event as unknown as {
            type?: string;
            delivery?: "log" | "signal";
            phase?: "replay" | "live";
            senderId?: string;
            pubsubId?: number;
            senderMetadata?: { name?: string; type?: string; handle?: string };
            ts?: number;
            payload?: AgenticEvent;
          };

          if (wire.type === AGENTIC_EVENT_PAYLOAD_KIND && wire.payload) {
            const envelope = pubsubAgenticEventToEnvelope(client.channelId, {
              pubsubId: wire.pubsubId,
              senderId: wire.senderId,
              ts: wire.ts,
              senderMetadata: wire.senderMetadata,
              payload: wire.payload,
            });
            channelStateRef.current = reduceChannelView(channelStateRef.current, envelope);
            if (wire.pubsubId !== undefined) {
              if (oldestRootIdRef.current === null || wire.pubsubId < oldestRootIdRef.current) {
                oldestRootIdRef.current = wire.pubsubId;
              }
              if (newestSeqRef.current === null || wire.pubsubId > newestSeqRef.current) {
                newestSeqRef.current = wire.pubsubId;
              }
            }
            rebuildFromChannelState();
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
  }, [client, rebuildFromChannelState]);

  // --- Pagination: load earlier messages ---
  const loadEarlierMessages = useCallback(async () => {
    const c = clientRef.current;
    if (!c || loadingMore) return;
    const anchor = oldestRootIdRef.current;
    if (anchor === null || anchor <= 1) {
      setHasMoreHistory(false);
      return;
    }

    setLoadingMore(true);
    try {
      const result = await c.getReplayBefore(anchor, PAGE_SIZE);

      setHasMoreHistory(Boolean(result.ready.hasMoreBefore));

      for (const raw of result.logEvents) {
        const payload = raw.payload as Record<string, unknown> | undefined;
        if (!payload) continue;

        if (raw.type === AGENTIC_EVENT_PAYLOAD_KIND && payload) {
          const envelope = pubsubAgenticEventToEnvelope(c.channelId, {
            pubsubId: raw.id,
            senderId: raw.senderId,
            ts: raw.ts,
            senderMetadata: raw.senderMetadata as { name?: string; type?: string; handle?: string } | undefined,
            payload: payload as unknown as AgenticEvent,
          });
          channelStateRef.current = reduceChannelView(channelStateRef.current, envelope);
          if (raw.id < (oldestRootIdRef.current ?? Infinity)) oldestRootIdRef.current = raw.id;
          if (newestSeqRef.current === null || raw.id > newestSeqRef.current) newestSeqRef.current = raw.id;
        }
      }

      rebuildFromChannelState(true);
    } catch (err) {
      console.error("[useChannelMessages] loadEarlierMessages failed:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, rebuildFromChannelState]);

  const backfillAfterLocalPublish = useCallback(async (pubsubId: number | undefined) => {
    const c = clientRef.current;
    if (!c || pubsubId === undefined) return;
    const cursor = newestSeqRef.current ?? 0;
    if (cursor >= pubsubId) return;
    try {
      const result = await c.getReplayAfter(cursor);
      for (const raw of result.logEvents) {
        const payload = raw.payload as Record<string, unknown> | undefined;
        if (raw.type !== AGENTIC_EVENT_PAYLOAD_KIND || !payload) continue;
        const envelope = pubsubAgenticEventToEnvelope(c.channelId, {
          pubsubId: raw.id,
          senderId: raw.senderId,
          ts: raw.ts,
          senderMetadata: raw.senderMetadata as { name?: string; type?: string; handle?: string } | undefined,
          payload: payload as unknown as AgenticEvent,
        });
        channelStateRef.current = reduceChannelView(channelStateRef.current, envelope);
        if (raw.id < (oldestRootIdRef.current ?? Infinity)) oldestRootIdRef.current = raw.id;
        if (newestSeqRef.current === null || raw.id > newestSeqRef.current) newestSeqRef.current = raw.id;
      }
      rebuildFromChannelState();
    } catch (err) {
      console.error("[useChannelMessages] backfillAfterLocalPublish failed:", err);
    }
  }, [rebuildFromChannelState]);

  return { messages, actionBar, hasMoreHistory, loadingMore, loadEarlierMessages, backfillAfterLocalPublish };
}

function pubsubAgenticEventToEnvelope(
  channelId: string,
  wire: {
    pubsubId?: number;
    senderId?: string;
    ts?: number;
    senderMetadata?: { name?: string; type?: string; handle?: string };
    payload: AgenticEvent;
  },
): ChannelEnvelope<AgenticEvent> {
  const participantId = wire.senderId ?? wire.payload.actor.id;
  const metadata = wire.senderMetadata;
  return {
    envelopeId: `pubsub:${wire.pubsubId ?? crypto.randomUUID()}` as never,
    channelId: channelId as never,
    seq: wire.pubsubId ?? 0,
    from: {
      kind: participantKind(metadata?.type),
      id: participantId,
      displayName: metadata?.name,
      participantId,
      metadata,
    },
    payload: wire.payload,
    payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
    publishedAt: new Date(wire.ts ?? Date.now()).toISOString(),
  };
}

function participantKind(type: string | undefined): "user" | "agent" | "panel" | "external" {
  if (type === "agent") return "agent";
  if (type === "panel" || type === "client") return "panel";
  if (type === "headless") return "user";
  return "external";
}
