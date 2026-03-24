/**
 * Broadcast + delivery chains for the PubSub Channel DO.
 *
 * ChannelEvent is the single canonical format. broadcast() derives the WS wire
 * encoding via channelEventToWsJson(). DO participants receive the event directly.
 */

import type { DurableObjectContext, SqlStorage } from "@workspace/runtime/worker";
import type { ChannelEvent } from "@natstack/harness/types";
import type { WsEventMessage } from "@natstack/pubsub";
import type { BroadcastEnvelope, StoredAttachment } from "./types.js";
import { sendJson, buildBinaryFrame } from "./ws-protocol.js";

export interface BroadcastDeps {
  ctx: DurableObjectContext;
  sql: SqlStorage;
  postToDO: (source: string, cls: string, key: string, method: string, ...args: unknown[]) => Promise<unknown>;
  objectKey: string;
}

/** Delivery chains for ordered DO delivery. Resets on hibernation — safe because
 *  agent DOs handle ordering via their own checkpoints. */
const deliveryChains = new Map<string, Promise<void>>();

// ── Broadcast ────────────────────────────────────────────────────────────────

/**
 * Broadcast a ChannelEvent to all participants.
 * WS clients receive the event encoded as WsEventMessage JSON (or binary frame for attachments).
 * DO clients receive the ChannelEvent directly via HTTP POST.
 */
export function broadcast(
  deps: BroadcastDeps,
  event: ChannelEvent,
  envelope: BroadcastEnvelope,
  senderId: string,
  senderWs: WebSocket | null,
): void {
  // ── WebSocket participants ──
  const wsMsg = channelEventToWsJson(event, envelope.kind);
  const allWs = deps.ctx.getWebSockets();

  const hasAttachments = event.attachments && event.attachments.length > 0;

  if (hasAttachments) {
    const stored: StoredAttachment[] = event.attachments!
      .map(a => ({ id: a.id, data: a.data, mimeType: a.mimeType, name: a.filename, size: a.size }));

    // Strip attachments from WS JSON metadata — they're sent as raw bytes in the binary frame.
    // Without this, base64 data would be duplicated in both the JSON metadata and the binary payload.
    const { attachments: _drop, ...wsMsgNoAttachments } = wsMsg;
    const bufferForOthers = buildBinaryFrame(wsMsgNoAttachments, stored);
    const bufferForSender = envelope.ref !== undefined
      ? buildBinaryFrame({ ...wsMsgNoAttachments, ref: envelope.ref }, stored)
      : bufferForOthers;

    for (const ws of allWs) {
      ws.send(ws === senderWs ? bufferForSender : bufferForOthers);
    }
  } else {
    const dataForOthers = JSON.stringify(wsMsg);
    const dataForSender = envelope.ref !== undefined
      ? JSON.stringify({ ...wsMsg, ref: envelope.ref })
      : dataForOthers;

    for (const ws of allWs) {
      ws.send(ws === senderWs ? dataForSender : dataForOthers);
    }
  }

  // ── DO participants (via HTTP POST through router, with delivery chains) ──
  const doParticipants = deps.sql.exec(
    `SELECT id, do_source, do_class, do_key FROM participants WHERE transport = 'do'`,
  ).toArray();

  for (const p of doParticipants) {
    const pid = p["id"] as string;
    if (pid === senderId) continue;

    const doSource = p["do_source"] as string;
    const doClass = p["do_class"] as string;
    const doKey = p["do_key"] as string;

    const prev = deliveryChains.get(pid) ?? Promise.resolve();
    const next: Promise<void> = prev.then(() =>
      deps.postToDO(doSource, doClass, doKey, "onChannelEvent", deps.objectKey, event)
        .then(() => {})
        .catch(err => console.error(`[Channel] delivery failed for ${pid}:`, err)),
    );
    deliveryChains.set(pid, next);
  }
}

// ── Config update broadcast ──────────────────────────────────────────────────

/**
 * Broadcast a config update to all participants.
 */
export function broadcastConfigUpdate(
  deps: BroadcastDeps,
  config: Record<string, unknown>,
  senderWs: WebSocket | null,
  senderRef?: number,
): void {
  const msg = { kind: "config-update" as const, channelConfig: config };

  const allWs = deps.ctx.getWebSockets();
  const dataForOthers = JSON.stringify(msg);
  const dataForSender = senderRef !== undefined
    ? JSON.stringify({ ...msg, ref: senderRef })
    : dataForOthers;

  for (const ws of allWs) {
    ws.send(ws === senderWs ? dataForSender : dataForOthers);
  }

  // Notify DO participants
  const doParticipants = deps.sql.exec(
    `SELECT id, do_source, do_class, do_key FROM participants WHERE transport = 'do'`,
  ).toArray();

  const event: ChannelEvent = {
    id: 0,
    messageId: "",
    type: "config-update",
    payload: config,
    senderId: "",
    ts: Date.now(),
    persist: false,
  };

  for (const p of doParticipants) {
    const doSource = p["do_source"] as string;
    const doClass = p["do_class"] as string;
    const doKey = p["do_key"] as string;

    const pid = p["id"] as string;
    const prev = deliveryChains.get(pid) ?? Promise.resolve();
    const next: Promise<void> = prev.then(() =>
      deps.postToDO(doSource, doClass, doKey, "onChannelEvent", deps.objectKey, event)
        .then(() => {})
        .catch(err => console.error(`[Channel] config-update delivery failed for ${pid}:`, err)),
    );
    deliveryChains.set(pid, next);
  }
}

// ── Ready message ────────────────────────────────────────────────────────────

/**
 * Send a ready message to a single WebSocket client.
 */
export function sendReady(
  ws: WebSocket,
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

  sendJson(ws, {
    kind: "ready",
    contextId: contextId ?? undefined,
    channelConfig: channelConfig ?? undefined,
    totalCount,
    chatMessageCount,
    firstChatMessageId,
  });
}

// ── ChannelEvent builders ────────────────────────────────────────────────────

/**
 * Build a ChannelEvent from message data.
 * This is the canonical event format for both WS and DO delivery.
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
  attachments?: StoredAttachment[],
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

// ── WS encoding ──────────────────────────────────────────────────────────────

/**
 * Convert a ChannelEvent to the WS wire format (WsEventMessage).
 * This is the thin transport layer — the only place WS-specific encoding lives.
 */
export function channelEventToWsJson(
  event: ChannelEvent,
  kind: "replay" | "persisted" | "ephemeral",
  ref?: number,
): WsEventMessage {
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

/**
 * Send a ChannelEvent to a single WS client (for replay).
 * Handles binary frame encoding for events with attachments.
 */
export function sendWsEvent(
  ws: WebSocket,
  event: ChannelEvent,
  kind: "replay" | "persisted" | "ephemeral",
): void {
  const wsMsg = channelEventToWsJson(event, kind);

  if (event.attachments && event.attachments.length > 0) {
    const stored: StoredAttachment[] = event.attachments
      .map(a => ({ id: a.id, data: a.data, mimeType: a.mimeType, name: a.filename, size: a.size }));
    const { attachments: _drop, ...wsMsgNoAttachments } = wsMsg;
    ws.send(buildBinaryFrame(wsMsgNoAttachments, stored));
  } else {
    sendJson(ws, wsMsg);
  }
}
