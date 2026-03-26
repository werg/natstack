/**
 * Replay logic — shared helpers for message history queries.
 * Uses parseRowToChannelEvent() as the single row parser.
 */

import type { SqlStorage } from "@workspace/runtime/worker";
import type { WsMessageEntry } from "@natstack/pubsub";
import { parseRowToChannelEvent } from "./broadcast.js";

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
