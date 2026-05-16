/**
 * Broadcast + delivery for the PubSub Channel DO.
 *
 * All participants receive events through runtime RPC events.
 * ChannelEvent is the single canonical format. channelEventToWsJson()
 * derives the inbox payload sent to subscribers.
 */

import type { SqlStorage } from "@workspace/runtime/worker";
import type { ChannelEvent } from "@natstack/harness/types";
import type { BroadcastEnvelope, StoredAttachment, ChannelConfig } from "./types.js";

export interface BroadcastDeps {
  sql: SqlStorage;
  objectKey: string;
  emit(targetId: string, event: string, payload: unknown): Promise<void>;
}

/** Per-subscriber delivery chains for FIFO RPC event delivery. */
const deliveryChains = new Map<string, Promise<void>>();

/**
 * Queue an RPC event to `subscriberId` behind previously queued deliveries to
 * the same subscriber. Returns the tail of the chain for callers that want to
 * wait until every enqueued delivery has drained.
 */
export function queueDelivery(
  deps: BroadcastDeps,
  subscriberId: string,
  payload: unknown,
  onFatalDelivery?: (err: { code?: string }) => void,
): Promise<void> {
  const prev = deliveryChains.get(subscriberId) ?? Promise.resolve();
  const next = prev.then(() =>
    emitDelivery(deps, subscriberId, payload).catch((err) => {
      onFatalDelivery?.(err as { code?: string });
    }),
  );
  deliveryChains.set(subscriberId, next);
  void next.finally(() => {
    if (deliveryChains.get(subscriberId) === next) {
      deliveryChains.delete(subscriberId);
    }
  });
  return next;
}

/** Clean up delivery chain for a participant that unsubscribed. */
export function cleanupDeliveryChain(participantId: string): void {
  deliveryChains.delete(participantId);
}

export function resetDeliveryChainsForTest(): void {
  deliveryChains.clear();
}

async function emitDelivery(
  deps: BroadcastDeps,
  subscriberId: string,
  payload: unknown,
): Promise<void> {
  try {
    await deps.emit(subscriberId, "channel:message", {
      channelId: deps.objectKey,
      message: payload,
    });
  } catch (error) {
    deps.sql.exec(`DELETE FROM participants WHERE id = ?`, subscriberId);
    cleanupDeliveryChain(subscriberId);
    const err = error instanceof Error ? error : new Error(String(error));
    (err as { code?: string }).code = "TARGET_NOT_REACHABLE";
    throw err;
  }
}

// ── Broadcast ────────────────────────────────────────────────────────────────

/**
 * Broadcast a ChannelEvent to all participants via runtime RPC.
 */
export function broadcast(
  deps: BroadcastDeps,
  event: ChannelEvent,
  envelope: BroadcastEnvelope,
  senderId: string,
): void {
  const participants = deps.sql.exec(
    `SELECT id FROM participants`,
  ).toArray();

  const msg = channelEventToWsJson(event, envelope.kind);

  for (const p of participants) {
    const pid = p["id"] as string;
    const data = pid === senderId && envelope.ref !== undefined
      ? { channelId: deps.objectKey, message: { ...msg, ref: envelope.ref } }
      : { channelId: deps.objectKey, message: msg };

    // Route through the per-subscriber delivery chain so replay events queued
    // during a concurrent subscribe stay ahead of live broadcasts.
    void queueDelivery(deps, pid, data.message, (err) => {
      const code = err?.code;
      if (code === "TARGET_NOT_REACHABLE" || code === "RECONNECT_GRACE_EXPIRED") {
        deps.sql.exec(`DELETE FROM participants WHERE id = ?`, pid);
        cleanupDeliveryChain(pid);
      }
    });
  }
}

// ── Config update broadcast ──────────────────────────────────────────────────

/**
 * Broadcast a config update to all participants.
 */
export function broadcastConfigUpdate(
  deps: BroadcastDeps,
  config: Record<string, unknown>,
  senderId?: string,
  senderRef?: number,
): void {
  const msg = { kind: "config-update" as const, channelConfig: config as ChannelConfig };

  const participants = deps.sql.exec(
    `SELECT id FROM participants`,
  ).toArray();

  for (const p of participants) {
    const pid = p["id"] as string;

    // Only include ref for the sender's publish acknowledgment.
    const outMsg = (pid === senderId && senderRef !== undefined)
      ? { ...msg, ref: senderRef }
      : msg;

    void queueDelivery(deps, pid, outMsg, (err) => {
      const code = err?.code;
      if (code === "TARGET_NOT_REACHABLE" || code === "RECONNECT_GRACE_EXPIRED") {
        deps.sql.exec(`DELETE FROM participants WHERE id = ?`, pid);
        cleanupDeliveryChain(pid);
      } else {
        console.warn(`[Channel] config update delivery failed:`, err);
      }
    });
  }
}

// ── Ready message ────────────────────────────────────────────────────────────

/**
 * Send a ready message to a single subscriber via runtime RPC.
 */
export function sendReady(
  deps: BroadcastDeps,
  subscriberId: string,
  sql: SqlStorage,
  contextId: string | null,
  channelConfig: Record<string, unknown> | null,
): {
  contextId?: string;
  channelConfig?: Record<string, unknown>;
  totalCount: number;
  chatMessageCount: number;
  firstChatMessageId?: number;
} {
  const totalRow = sql.exec(`SELECT COUNT(*) as cnt FROM messages`).toArray();
  const totalCount = (totalRow[0]?.["cnt"] as number) ?? 0;

  const chatRow = sql.exec(`SELECT COUNT(*) as cnt FROM messages WHERE type = 'message'`).toArray();
  const chatMessageCount = (chatRow[0]?.["cnt"] as number) ?? 0;

  const firstRow = sql.exec(`SELECT MIN(id) as mid FROM messages WHERE type = 'message'`).toArray();
  const firstChatMessageId = (firstRow[0]?.["mid"] as number | null) ?? undefined;
  const ready = {
    contextId: contextId ?? undefined,
    channelConfig: channelConfig ?? undefined,
    totalCount,
    chatMessageCount,
    firstChatMessageId,
  };

  void queueDelivery(deps, subscriberId, {
    kind: "ready",
    ...ready,
  });
  return ready;
}

// ── ChannelEvent builders ────────────────────────────────────────────────────

/**
 * Build a ChannelEvent from message data.
 * This is the canonical event format before inbox wire encoding.
 */
export function buildChannelEvent(
  id: number,
  messageId: string,
  type: string,
  content: string,
  senderId: string,
  senderMetadata: Record<string, unknown> | undefined,
  ts: number,
  persist: boolean,
  attachments?: Array<{ id: string; data: string; mimeType: string; name?: string; size: number }>,
): ChannelEvent {
  let parsedPayload: unknown;
  try { parsedPayload = JSON.parse(content); } catch { parsedPayload = content; }

  const payloadObj = parsedPayload && typeof parsedPayload === "object"
    ? parsedPayload as Record<string, unknown>
    : null;
  const contentType = payloadObj?.["contentType"] as string | undefined;

  const mappedAttachments = attachments?.map(att => ({
    id: att.id,
    type: att.mimeType?.startsWith("image/") ? "image" : "file",
    data: att.data,
    mimeType: att.mimeType,
    filename: att.name,
    size: att.size,
  }));

  return {
    id,
    messageId: messageId || `${id}`,
    type,
    payload: parsedPayload,
    senderId,
    senderMetadata,
    ...(contentType ? { contentType } : {}),
    ts,
    persist,
    ...(mappedAttachments && mappedAttachments.length > 0 ? { attachments: mappedAttachments } : {}),
  };
}

/**
 * Parse a SQL message row into a ChannelEvent.
 * Shared by replay, subscribe, and pagination.
 */
export function parseRowToChannelEvent(row: Record<string, unknown>): ChannelEvent {
  let senderMetadata: Record<string, unknown> | undefined;
  if (row["sender_metadata"]) {
    try { senderMetadata = JSON.parse(row["sender_metadata"] as string); } catch { /* skip */ }
  }
  let attachments: StoredAttachment[] | undefined;
  if (row["attachments"]) {
    try { attachments = JSON.parse(row["attachments"] as string); } catch { /* skip */ }
  }
  return buildChannelEvent(
    row["id"] as number,
    (row["message_id"] as string) ?? "",
    row["type"] as string,
    row["content"] as string,
    row["sender_id"] as string,
    senderMetadata,
    row["ts"] as number,
    true,
    attachments,
  );
}

// ── Wire encoding ────────────────────────────────────────────────────────────

/**
 * Convert a ChannelEvent to the wire format posted to subscriber inboxes.
 * This is the thin transport layer — the only place wire-specific encoding lives.
 */
export function channelEventToWsJson(
  event: ChannelEvent,
  kind: "replay" | "persisted" | "ephemeral",
  ref?: number,
): Record<string, unknown> {
  return {
    kind,
    id: event.id || undefined,
    type: event.type,
    payload: event.payload,
    senderId: event.senderId,
    ts: event.ts,
    senderMetadata: event.senderMetadata,
    ...(ref !== undefined ? { ref } : {}),
    ...(event.attachments && event.attachments.length > 0 ? { attachments: event.attachments } : {}),
  };
}
