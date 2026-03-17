/**
 * Broadcast + delivery chains for the PubSub Channel DO.
 *
 * WebSocket participants get direct ws.send().
 * DO participants get HTTP POST through the workerd router with per-participant
 * ordering via promise chains.
 */

import type { DurableObjectContext, SqlStorage } from "@workspace/runtime/worker";
import type { ChannelEvent } from "@natstack/harness/types";
import type { ServerMessage, StoredAttachment } from "./types.js";
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

/**
 * Broadcast a persisted or ephemeral message to all participants.
 */
export function broadcast(
  deps: BroadcastDeps,
  msg: ServerMessage,
  channelEvent: ChannelEvent | null,
  senderId: string,
  senderWs: WebSocket | null,
  senderRef?: number,
  attachments?: StoredAttachment[],
): void {
  // ── WebSocket participants ──
  const allWs = deps.ctx.getWebSockets();
  if (attachments && attachments.length > 0) {
    const bufferForOthers = buildBinaryFrame(msg, attachments);
    const bufferForSender = senderRef !== undefined
      ? buildBinaryFrame({ ...msg, ref: senderRef }, attachments)
      : bufferForOthers;

    for (const ws of allWs) {
      const data = ws === senderWs ? bufferForSender : bufferForOthers;
      ws.send(data);
    }
  } else {
    const dataForOthers = JSON.stringify(msg);
    const dataForSender = senderRef !== undefined
      ? JSON.stringify({ ...msg, ref: senderRef })
      : dataForOthers;

    for (const ws of allWs) {
      const data = ws === senderWs ? dataForSender : dataForOthers;
      ws.send(data);
    }
  }

  // ── DO participants (via HTTP POST through router, with delivery chains) ──
  if (!channelEvent) return;

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
      deps.postToDO(doSource, doClass, doKey, "onChannelEvent", deps.objectKey, channelEvent)
        .then(() => {})
        .catch(err => console.error(`[Channel] delivery failed for ${pid}:`, err)),
    );
    deliveryChains.set(pid, next);
  }
}

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
    const data = ws === senderWs ? dataForSender : dataForOthers;
    ws.send(data);
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

/**
 * Build a ChannelEvent from message data.
 * This is the proper format sent to agent DOs — no toChannelEvent() conversion needed.
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

  const senderType = senderMetadata?.["type"] as string | undefined;

  const payloadObj = parsedPayload && typeof parsedPayload === "object"
    ? parsedPayload as Record<string, unknown>
    : null;
  const contentType = payloadObj?.["contentType"] as string | undefined;

  const mappedAttachments = attachments?.map(att => ({
    type: att.mimeType?.startsWith("image/") ? "image" : "file",
    data: att.data,
    mimeType: att.mimeType,
    filename: att.name,
  }));

  return {
    id,
    messageId: messageId || `${id}`,
    type,
    payload: parsedPayload,
    senderId,
    senderType,
    ...(contentType ? { contentType } : {}),
    ts,
    persist,
    ...(mappedAttachments && mappedAttachments.length > 0 ? { attachments: mappedAttachments } : {}),
  };
}

