/**
 * Broadcast + delivery for the PubSub Channel DO.
 *
 * All participants (panels and DOs) receive events via RPC emit.
 * DO participants additionally receive ChannelEvent via RPC call
 * for ordered delivery with promise chains.
 */

import type { SqlStorage } from "@workspace/runtime/worker";
import type { RpcBridge } from "@natstack/rpc";
import type { ChannelEvent } from "@natstack/harness/types";
import type { ServerMessage, ChannelConfig } from "./types.js";

export interface BroadcastDeps {
  sql: SqlStorage;
  rpc: RpcBridge;
  objectKey: string;
}

/** Delivery chains for ordered DO delivery. Resets on hibernation — safe because
 *  agent DOs handle ordering via their own checkpoints. */
const deliveryChains = new Map<string, Promise<void>>();

/**
 * Broadcast a persisted or ephemeral message to all participants via RPC events.
 */
export function broadcast(
  deps: BroadcastDeps,
  msg: ServerMessage,
  channelEvent: ChannelEvent | null,
  senderId: string,
  senderRef?: number,
): void {
  const participants = deps.sql.exec(
    `SELECT id, transport, do_source, do_class, do_key FROM participants`,
  ).toArray();

  for (const p of participants) {
    const pid = p["id"] as string;
    if (pid === senderId) {
      // Send back to sender with ref for ack
      if (senderRef !== undefined) {
        deps.rpc.emit(pid, "channel:message", {
          channelId: deps.objectKey,
          message: { ...msg, ref: senderRef },
        }).catch(err => console.warn(`[Channel] emit failed:`, err));
      } else {
        deps.rpc.emit(pid, "channel:message", {
          channelId: deps.objectKey,
          message: msg,
        }).catch(err => console.warn(`[Channel] emit failed:`, err));
      }
      continue;
    }

    // Emit the ServerMessage to all participants via RPC
    deps.rpc.emit(pid, "channel:message", {
      channelId: deps.objectKey,
      message: msg,
    }).catch(err => console.warn(`[Channel] emit failed:`, err));

    // For DO participants, also deliver the structured ChannelEvent via RPC call
    // for ordered delivery (agent DOs process these via onChannelEvent)
    if (channelEvent && p["transport"] === "do") {
      const prev = deliveryChains.get(pid) ?? Promise.resolve();
      const next: Promise<void> = prev.then(() =>
        deps.rpc.call(pid, "onChannelEvent", deps.objectKey, channelEvent)
          .then(() => {})
          .catch(err => console.error(`[Channel] delivery failed for ${pid}:`, err)),
      );
      deliveryChains.set(pid, next);
    }
  }
}

/**
 * Broadcast a config update to all participants.
 */
export function broadcastConfigUpdate(
  deps: BroadcastDeps,
  config: Record<string, unknown>,
  senderId?: string,
  senderRef?: number,
): void {
  const msg: ServerMessage = { kind: "config-update" as const, channelConfig: config as ChannelConfig };

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
  attachments?: Array<{ id: string; data: string; mimeType: string; name?: string; size: number }>,
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
