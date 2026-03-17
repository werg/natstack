/**
 * Replay logic — sends historical messages to a newly connected WebSocket client.
 */

import type { SqlStorage } from "@workspace/runtime/worker";
import type { ServerMessage, StoredAttachment } from "./types.js";
import { sendJson, buildBinaryFrame } from "./ws-protocol.js";

/**
 * Replay roster-ops (presence events) from the beginning.
 * These are replayed separately to reconstruct the full roster history.
 */
export function replayRosterOps(ws: WebSocket, sql: SqlStorage): void {
  const rows = sql.exec(
    `SELECT id, type, content, sender_id, ts, sender_metadata FROM messages WHERE type = 'presence' ORDER BY id ASC`,
  ).toArray();

  for (const row of rows) {
    let payload: unknown;
    try { payload = JSON.parse(row["content"] as string); } catch { payload = row["content"]; }
    let senderMetadata: Record<string, unknown> | undefined;
    if (row["sender_metadata"]) {
      try { senderMetadata = JSON.parse(row["sender_metadata"] as string); } catch { /* ignore */ }
    }

    sendJson(ws, {
      kind: "replay",
      id: row["id"] as number,
      type: row["type"] as string,
      payload,
      senderId: row["sender_id"] as string,
      ts: row["ts"] as number,
      senderMetadata,
    });
  }
}

/**
 * Replay messages since sinceId (exclusive), excluding presence events.
 * Presence is handled separately by replayRosterOps.
 */
export function replayMessages(ws: WebSocket, sql: SqlStorage, sinceId: number): void {
  const rows = sql.exec(
    `SELECT id, type, content, sender_id, ts, sender_metadata, attachments
     FROM messages WHERE id > ? AND type != 'presence' ORDER BY id ASC`,
    sinceId,
  ).toArray();

  for (const row of rows) {
    sendMessage(ws, row, "replay");
  }
}

/**
 * Replay with an anchored limit: find the Nth-from-last "message" type row
 * and replay from there.
 */
export function replayAnchored(ws: WebSocket, sql: SqlStorage, limit: number): void {
  // Find the anchor: Nth-from-last message-type row
  const anchorRows = sql.exec(
    `SELECT id FROM messages WHERE type = 'message' ORDER BY id DESC LIMIT 1 OFFSET ?`,
    limit - 1,
  ).toArray();

  if (anchorRows.length > 0) {
    const anchorId = anchorRows[0]!["id"] as number;
    // Replay from just before the anchor (replayMessages uses id > sinceId)
    replayMessages(ws, sql, anchorId - 1);
  } else {
    // Fewer than N chat messages exist — full replay
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
): { messages: ServerMessage["messages"]; hasMore: boolean; trailingUpdates: ServerMessage["trailingUpdates"] } {
  const effectiveLimit = Math.min(limit, 500);
  const rows = sql.exec(
    `SELECT id, type, content, sender_id, ts, sender_metadata, attachments
     FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?`,
    beforeId, effectiveLimit + 1,
  ).toArray();

  const hasMore = rows.length > effectiveLimit;
  const rowsToReturn = hasMore ? rows.slice(0, effectiveLimit) : rows;

  // Reverse to chronological order
  rowsToReturn.reverse();

  const messages = rowsToReturn.map(parseMessageRow);

  // Fetch trailing updates for boundary messages
  const messageUuids: string[] = [];
  const highestRowId = rowsToReturn.length > 0 ? rowsToReturn[rowsToReturn.length - 1]!["id"] as number : 0;
  for (const msg of messages) {
    if (msg.type === "message" && typeof msg.payload === "object" && msg.payload !== null) {
      const uuid = (msg.payload as { id?: string }).id;
      if (uuid) messageUuids.push(uuid);
    }
  }

  let trailingUpdates: ServerMessage["trailingUpdates"] = [];
  if (messageUuids.length > 0 && highestRowId > 0) {
    // Find update-message and error events that reference these message UUIDs
    // and have id > highestRowId
    const placeholders = messageUuids.map(() => "?").join(",");
    const trailingRows = sql.exec(
      `SELECT id, type, content, sender_id, ts, sender_metadata
       FROM messages WHERE id > ? AND type IN ('update-message', 'error')
       AND json_extract(content, '$.id') IN (${placeholders})
       ORDER BY id ASC`,
      highestRowId, ...messageUuids,
    ).toArray();

    trailingUpdates = trailingRows.map(row => {
      let payload: unknown;
      try { payload = JSON.parse(row["content"] as string); } catch { payload = row["content"]; }
      let senderMetadata: Record<string, unknown> | undefined;
      if (row["sender_metadata"]) {
        try { senderMetadata = JSON.parse(row["sender_metadata"] as string); } catch { /* ignore */ }
      }
      return {
        id: row["id"] as number,
        type: row["type"] as string,
        payload,
        senderId: row["sender_id"] as string,
        ts: row["ts"] as number,
        senderMetadata,
      };
    });
  }

  return { messages, hasMore, trailingUpdates };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseMessageRow(row: Record<string, unknown>): NonNullable<ServerMessage["messages"]>[number] {
  let payload: unknown;
  try { payload = JSON.parse(row["content"] as string); } catch { payload = row["content"]; }
  let senderMetadata: Record<string, unknown> | undefined;
  if (row["sender_metadata"]) {
    try { senderMetadata = JSON.parse(row["sender_metadata"] as string); } catch { /* ignore */ }
  }
  let attachments: StoredAttachment[] | undefined;
  if (row["attachments"]) {
    try { attachments = JSON.parse(row["attachments"] as string); } catch { /* ignore */ }
  }
  return {
    id: row["id"] as number,
    type: row["type"] as string,
    payload,
    senderId: row["sender_id"] as string,
    ts: row["ts"] as number,
    senderMetadata,
    attachments,
  };
}

function sendMessage(ws: WebSocket, row: Record<string, unknown>, kind: "replay" | "persisted" | "ephemeral"): void {
  let payload: unknown;
  try { payload = JSON.parse(row["content"] as string); } catch { payload = row["content"]; }
  let senderMetadata: Record<string, unknown> | undefined;
  if (row["sender_metadata"]) {
    try { senderMetadata = JSON.parse(row["sender_metadata"] as string); } catch { /* ignore */ }
  }
  let attachments: StoredAttachment[] | undefined;
  if (row["attachments"]) {
    try { attachments = JSON.parse(row["attachments"] as string); } catch { /* ignore */ }
  }

  const msg: ServerMessage = {
    kind,
    id: row["id"] as number,
    type: row["type"] as string,
    payload,
    senderId: row["sender_id"] as string,
    ts: row["ts"] as number,
    senderMetadata,
  };

  if (attachments && attachments.length > 0) {
    ws.send(buildBinaryFrame(msg, attachments));
  } else {
    sendJson(ws, msg);
  }
}
