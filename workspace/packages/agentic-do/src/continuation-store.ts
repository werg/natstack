/**
 * ContinuationStore — Async call continuations that survive hibernation.
 *
 * Owns the `pending_calls` table. Used for tool approval flows and
 * inter-participant method calls.
 */

import type { SqlStorage } from "@workspace/runtime/worker";

export interface PendingCall {
  callId: string;
  channelId: string;
  type: string;
  context: Record<string, unknown>;
}

export class ContinuationStore {
  constructor(private sql: SqlStorage) {}

  createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_calls (
        call_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        call_type TEXT NOT NULL,
        context TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  }

  store(callId: string, channelId: string, type: string, context: Record<string, unknown>): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO pending_calls (call_id, channel_id, call_type, context, created_at) VALUES (?, ?, ?, ?, ?)`,
      callId, channelId, type, JSON.stringify(context), Date.now(),
    );
  }

  consume(callId: string): PendingCall | null {
    const row = this.sql.exec(
      `SELECT call_id, channel_id, call_type, context FROM pending_calls WHERE call_id = ?`, callId,
    ).toArray();
    if (row.length === 0) return null;
    this.sql.exec(`DELETE FROM pending_calls WHERE call_id = ?`, callId);
    return {
      callId: row[0]!["call_id"] as string,
      channelId: row[0]!["channel_id"] as string,
      type: row[0]!["call_type"] as string,
      context: JSON.parse(row[0]!["context"] as string),
    };
  }

  listForChannel(channelId: string, type?: string): PendingCall[] {
    const query = type
      ? `SELECT call_id, channel_id, call_type, context FROM pending_calls WHERE channel_id = ? AND call_type = ?`
      : `SELECT call_id, channel_id, call_type, context FROM pending_calls WHERE channel_id = ?`;
    const rows = this.sql.exec(query, ...(type ? [channelId, type] : [channelId])).toArray();
    return rows.map(row => ({
      callId: row["call_id"] as string,
      channelId: row["channel_id"] as string,
      type: row["call_type"] as string,
      context: JSON.parse(row["context"] as string),
    }));
  }

  deleteForChannel(channelId: string): void {
    this.sql.exec(`DELETE FROM pending_calls WHERE channel_id = ?`, channelId);
  }

  deleteAll(): void {
    this.sql.exec(`DELETE FROM pending_calls`);
  }

  deleteOne(callId: string): void {
    this.sql.exec(`DELETE FROM pending_calls WHERE call_id = ?`, callId);
  }
}
