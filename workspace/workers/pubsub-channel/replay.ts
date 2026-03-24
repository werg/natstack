/**
 * Replay logic — sends historical messages to newly connected participants.
 * Uses parseRowToChannelEvent() as the single row parser for all paths.
 */

import type { SqlStorage } from "@workspace/runtime/worker";
import type { WsMessageEntry } from "@natstack/pubsub";
import { parseRowToChannelEvent, channelEventToWsJson, sendWsEvent } from "./broadcast.js";
import { sendJson } from "./ws-protocol.js";

/**
 * Replay roster-ops (presence events) from the beginning.
 * These are replayed separately to reconstruct the full roster history.
 */
export function replayRosterOps(ws: WebSocket, sql: SqlStorage): void {
  const rows = sql.exec(
    `SELECT id, message_id, type, content, sender_id, ts, sender_metadata FROM messages WHERE type = 'presence' ORDER BY id ASC`,
  ).toArray();

  for (const row of rows) {
    const event = parseRowToChannelEvent(row);
    sendWsEvent(ws, event, "replay");
  }
}

/**
 * Replay messages since sinceId (exclusive), excluding presence events.
 * Presence is handled separately by replayRosterOps.
 */
export function replayMessages(ws: WebSocket, sql: SqlStorage, sinceId: number): void {
  const rows = sql.exec(
    `SELECT id, message_id, type, content, sender_id, ts, sender_metadata, attachments
     FROM messages WHERE id > ? AND type != 'presence' ORDER BY id ASC`,
    sinceId,
  ).toArray();

  for (const row of rows) {
    const event = parseRowToChannelEvent(row);
    sendWsEvent(ws, event, "replay");
  }
}

/**
 * Replay with an anchored limit: find the Nth-from-last "message" type row
 * and replay from there.
 */
export function replayAnchored(ws: WebSocket, sql: SqlStorage, limit: number): void {
  const anchorRows = sql.exec(
    `SELECT id FROM messages WHERE type = 'message' ORDER BY id DESC LIMIT 1 OFFSET ?`,
    limit - 1,
  ).toArray();

  if (anchorRows.length > 0) {
    const anchorId = anchorRows[0]!["id"] as number;
    replayMessages(ws, sql, anchorId - 1);
  } else {
    replayMessages(ws, sql, 0);
  }
}

/**
 * Get messages before a given ID (for pagination).
 */
export function getMessagesBefore(
  sql: SqlStorage,
  beforeId: number,
  limit: number,
): { messages: WsMessageEntry[]; hasMore: boolean; trailingUpdates: WsMessageEntry[] } {
  const effectiveLimit = Math.min(limit, 500);
  const rows = sql.exec(
    `SELECT id, message_id, type, content, sender_id, ts, sender_metadata, attachments
     FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?`,
    beforeId, effectiveLimit + 1,
  ).toArray();

  const hasMore = rows.length > effectiveLimit;
  const rowsToReturn = hasMore ? rows.slice(0, effectiveLimit) : rows;

  // Reverse to chronological order
  rowsToReturn.reverse();

  const messages: WsMessageEntry[] = rowsToReturn.map((row) => {
    const event = parseRowToChannelEvent(row);
    return {
      id: event.id,
      type: event.type,
      payload: event.payload,
      senderId: event.senderId,
      ts: event.ts,
      senderMetadata: event.senderMetadata,
      attachments: event.attachments,
    };
  });

  // Fetch trailing updates for boundary messages
  const messageUuids: string[] = [];
  const highestRowId = rowsToReturn.length > 0 ? rowsToReturn[rowsToReturn.length - 1]!["id"] as number : 0;
  for (const msg of messages) {
    if (msg.type === "message" && typeof msg.payload === "object" && msg.payload !== null) {
      const uuid = (msg.payload as { id?: string }).id;
      if (uuid) messageUuids.push(uuid);
    }
  }

  let trailingUpdates: WsMessageEntry[] = [];
  if (messageUuids.length > 0 && highestRowId > 0) {
    const placeholders = messageUuids.map(() => "?").join(",");
    const trailingRows = sql.exec(
      `SELECT id, message_id, type, content, sender_id, ts, sender_metadata
       FROM messages WHERE id > ? AND type IN ('update-message', 'error')
       AND json_extract(content, '$.id') IN (${placeholders})
       ORDER BY id ASC`,
      highestRowId, ...messageUuids,
    ).toArray();

    trailingUpdates = trailingRows.map((row) => {
      const event = parseRowToChannelEvent(row);
      return {
        id: event.id,
        type: event.type,
        payload: event.payload,
        senderId: event.senderId,
        ts: event.ts,
        senderMetadata: event.senderMetadata,
      };
    });
  }

  return { messages, hasMore, trailingUpdates };
}
