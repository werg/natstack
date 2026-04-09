/**
 * Broadcast + delivery for the PubSub Channel DO.
 *
 * All participants (panels and DOs) receive events via RPC emit.
 * ChannelEvent is the single canonical format. channelEventToWsJson()
 * derives the wire encoding for RPC emit payloads.
 * DO participants additionally receive ChannelEvent via RPC call
 * for ordered delivery with promise chains.
 */

import type { SqlStorage } from "@workspace/runtime/worker";
import type { RpcBridge } from "@natstack/rpc";
import type { ChannelEvent } from "@natstack/harness/types";
import type { BroadcastEnvelope, StoredAttachment, ChannelConfig } from "./types.js";

export interface BroadcastDeps {
  sql: SqlStorage;
  rpc: RpcBridge;
  objectKey: string;
}

/** Delivery chains for ordered DO delivery. Resets on hibernation — safe because
 *  agent DOs handle ordering via their own checkpoints. */
const deliveryChains = new Map<string, Promise<void>>();

/** Clean up delivery chain for a participant that unsubscribed. */
export function cleanupDeliveryChain(participantId: string): void {
  deliveryChains.delete(participantId);
}

// ── Broadcast ────────────────────────────────────────────────────────────────

/**
 * Broadcast a ChannelEvent to all participants via RPC.
 * RPC clients receive the event encoded via channelEventToWsJson().
 * DO clients additionally receive the ChannelEvent via ordered RPC call.
 */
export function broadcast(
  deps: BroadcastDeps,
  event: ChannelEvent,
  envelope: BroadcastEnvelope,
  senderId: string,
): void {
  const participants = deps.sql.exec(
    `SELECT id, transport, do_source, do_class, do_key FROM participants`,
  ).toArray();

  const msg = channelEventToWsJson(event, envelope.kind);

  for (const p of participants) {
    const pid = p["id"] as string;
    const data = pid === senderId && envelope.ref !== undefined
      ? { channelId: deps.objectKey, message: { ...msg, ref: envelope.ref } }
      : { channelId: deps.objectKey, message: msg };

    deps.rpc.emit(pid, "channel:message", data).catch(err => {
      const code = (err as { code?: string })?.code;
      if (code === "TARGET_NOT_REACHABLE" || code === "RECONNECT_GRACE_EXPIRED") {
        // Dead participant — remove from SQL so future broadcasts skip it.
        deps.sql.exec(`DELETE FROM participants WHERE id = ?`, pid);
        cleanupDeliveryChain(pid);
      }
    });

    // For DO participants, also deliver the structured ChannelEvent via RPC call
    // for ordered delivery (agent DOs process these via onChannelEvent)
    if (p["transport"] === "do") {
      const prev = deliveryChains.get(pid) ?? Promise.resolve();
      const next: Promise<void> = prev.then(() =>
        deps.rpc.call(pid, "onChannelEvent", deps.objectKey, event)
          .then(() => {})
          .catch(err => console.error(`[Channel] delivery failed for ${pid}:`, err)),
      );
      deliveryChains.set(pid, next);
    }
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
    `SELECT id, transport, do_source, do_class, do_key FROM participants`,
  ).toArray();

  for (const p of participants) {
    const pid = p["id"] as string;

    // Only include ref for the sender (ack token)
    const outMsg = (pid === senderId && senderRef !== undefined)
      ? { ...msg, ref: senderRef }
      : msg;

    deps.rpc.emit(pid, "channel:message", {
      channelId: deps.objectKey,
      message: outMsg,
    }).catch(err => console.warn(`[Channel] emit failed:`, err));

    // For DO participants, also deliver as a ChannelEvent for ordered processing
    if (p["transport"] === "do") {
      const event: ChannelEvent = {
        id: 0,
        messageId: "",
        type: "config-update",
        payload: config,
        senderId: "",
        ts: Date.now(),
        persist: false,
      };

      const prev = deliveryChains.get(pid) ?? Promise.resolve();
      const next: Promise<void> = prev.then(() =>
        deps.rpc.call(pid, "onChannelEvent", deps.objectKey, event)
          .then(() => {})
          .catch(err => console.error(`[Channel] config-update delivery failed for ${pid}:`, err)),
      );
      deliveryChains.set(pid, next);
    }
  }
}

// ── Ready message ────────────────────────────────────────────────────────────

/**
 * Send a ready message to a single subscriber via RPC event.
 */
export function sendReady(
  deps: BroadcastDeps,
  subscriberId: string,
  sql: SqlStorage,
  contextId: string | null,
  channelConfig: Record<string, unknown> | null,
): void {
  const totalRow = sql.exec(`SELECT COUNT(*) as cnt FROM messages`).toArray();
  const totalCount = (totalRow[0]?.["cnt"] as number) ?? 0;

  const chatRow = sql.exec(`SELECT COUNT(*) as cnt FROM messages WHERE type = 'message'`).toArray();
  const chatMessageCount = (chatRow[0]?.["cnt"] as number) ?? 0;

  const firstRow = sql.exec(`SELECT MIN(id) as mid FROM messages WHERE type = 'message'`).toArray();
  const firstChatMessageId = (firstRow[0]?.["mid"] as number | null) ?? undefined;

  deps.rpc.emit(subscriberId, "channel:message", {
    channelId: deps.objectKey,
    message: {
      kind: "ready",
      contextId: contextId ?? undefined,
      channelConfig: channelConfig ?? undefined,
      totalCount,
      chatMessageCount,
      firstChatMessageId,
    },
  }).catch(err => console.warn(`[Channel] emit failed:`, err));
}

// ── ChannelEvent builders ────────────────────────────────────────────────────

/**
 * Build a ChannelEvent from message data.
 * This is the canonical event format for both RPC emit and DO delivery.
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
 * Convert a ChannelEvent to the wire format for RPC emit / WS send.
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
