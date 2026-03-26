/**
 * TurnManager — Turn lifecycle, checkpoints, and fork resolution.
 *
 * Owns: active_turns, in_flight_turns, turn_map, checkpoints tables.
 */

import type { SqlStorage } from "@workspace/runtime/worker";
import type { TurnInput } from "@natstack/harness/types";
import type { PersistedStreamState } from "./stream-writer.js";

export interface ActiveTurn {
  channelId: string;
  replyToId: string;
  turnMessageId: string | null;
  senderParticipantId: string | null;
  typingContent: string;
  streamState: PersistedStreamState;
}

export interface InFlightTurn {
  triggerMessageId: string;
  triggerPubsubId: number;
  turnInput: TurnInput;
}

export interface QueuedTurn {
  channelId: string;
  messageId: string;
  pubsubId: number;
  senderId: string;
  turnInput: TurnInput;
  typingContent: string;
}

export interface TurnRecord {
  turnMessageId: string;
  externalSessionId: string;
}

export class TurnManager {
  constructor(private sql: SqlStorage) {}

  createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS turn_map (
        harness_id TEXT NOT NULL,
        turn_message_id TEXT NOT NULL,
        trigger_pubsub_id INTEGER NOT NULL,
        external_session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (harness_id, turn_message_id)
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_turn_map_pubsub ON turn_map(harness_id, trigger_pubsub_id)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        channel_id TEXT NOT NULL,
        harness_id TEXT,
        last_pubsub_id INTEGER NOT NULL,
        last_filtered_id INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, harness_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS in_flight_turns (
        channel_id TEXT NOT NULL,
        harness_id TEXT NOT NULL,
        trigger_message_id TEXT NOT NULL,
        trigger_pubsub_id INTEGER NOT NULL,
        turn_input TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, harness_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS active_turns (
        harness_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        reply_to_id TEXT NOT NULL,
        turn_message_id TEXT,
        sender_participant_id TEXT,
        stream_state TEXT,
        typing_content TEXT,
        started_at INTEGER NOT NULL,
        last_activity_at INTEGER,
        has_pending_continuation INTEGER DEFAULT 0
      )
    `);
    // Migration: add columns for existing DOs (safe no-op if already present)
    try { this.sql.exec(`ALTER TABLE active_turns ADD COLUMN last_activity_at INTEGER`); } catch { /* already exists */ }
    try { this.sql.exec(`ALTER TABLE active_turns ADD COLUMN has_pending_continuation INTEGER DEFAULT 0`); } catch { /* already exists */ }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS queued_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        harness_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        pubsub_id INTEGER NOT NULL,
        sender_id TEXT NOT NULL,
        turn_input TEXT NOT NULL,
        typing_content TEXT,
        created_at INTEGER NOT NULL
      )
    `);
  }

  // --- Active turns ---

  setActive(harnessId: string, channelId: string, replyToId: string, turnMessageId?: string, senderParticipantId?: string, typingContent?: string): void {
    const initialStreamState: PersistedStreamState = {
      responseMessageId: null,
      thinkingMessageId: null,
      actionMessageId: null,
      typingMessageId: null,
    };
    const now = Date.now();
    this.sql.exec(
      `INSERT OR REPLACE INTO active_turns (harness_id, channel_id, reply_to_id, turn_message_id, sender_participant_id, stream_state, typing_content, started_at, last_activity_at, has_pending_continuation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      harnessId, channelId, replyToId, turnMessageId ?? null, senderParticipantId ?? null, JSON.stringify(initialStreamState), typingContent ?? '', now, now,
    );
  }

  getActive(harnessId: string): ActiveTurn | null {
    const row = this.sql.exec(
      `SELECT channel_id, reply_to_id, turn_message_id, sender_participant_id, stream_state, typing_content FROM active_turns WHERE harness_id = ?`, harnessId,
    ).toArray();
    if (row.length === 0) return null;
    const defaultState: PersistedStreamState = { responseMessageId: null, thinkingMessageId: null, actionMessageId: null, typingMessageId: null };
    const turnMsgId = row[0]!["turn_message_id"] as string | null;
    const streamState: PersistedStreamState = row[0]!["stream_state"]
      ? JSON.parse(row[0]!["stream_state"] as string)
      : { ...defaultState, responseMessageId: turnMsgId };
    return {
      channelId: row[0]!["channel_id"] as string,
      replyToId: row[0]!["reply_to_id"] as string,
      turnMessageId: turnMsgId,
      senderParticipantId: row[0]!["sender_participant_id"] as string | null,
      typingContent: (row[0]!["typing_content"] as string) ?? '',
      streamState,
    };
  }

  updateActiveMessageId(harnessId: string, turnMessageId: string): void {
    this.sql.exec(`UPDATE active_turns SET turn_message_id = ? WHERE harness_id = ?`, turnMessageId, harnessId);
  }

  clearActive(harnessId: string): void {
    this.sql.exec(`DELETE FROM active_turns WHERE harness_id = ?`, harnessId);
  }

  clearAllActive(): void {
    this.sql.exec(`DELETE FROM active_turns`);
  }

  /** Phase 1B: Update activity timestamp for watchdog. */
  touchActive(harnessId: string): void {
    this.sql.exec(
      `UPDATE active_turns SET last_activity_at = ? WHERE harness_id = ?`,
      Date.now(), harnessId,
    );
  }

  /** Phase 1B: Set pending continuation flag (waiting for tool result/approval). */
  setPendingContinuation(harnessId: string, pending: boolean): void {
    this.sql.exec(
      `UPDATE active_turns SET has_pending_continuation = ? WHERE harness_id = ?`,
      pending ? 1 : 0, harnessId,
    );
  }

  /** Phase 1B: Find turns that appear stalled (no activity and no pending continuation). */
  getStaleActiveTurns(maxIdleMs: number): Array<{ harnessId: string; channelId: string; replyToId: string; typingContent: string; streamState: PersistedStreamState }> {
    const cutoff = Date.now() - maxIdleMs;
    const rows = this.sql.exec(
      `SELECT harness_id, channel_id, reply_to_id, typing_content, stream_state
       FROM active_turns
       WHERE (last_activity_at IS NULL OR last_activity_at < ?)
         AND has_pending_continuation = 0`,
      cutoff,
    ).toArray();
    const defaultState: PersistedStreamState = { responseMessageId: null, thinkingMessageId: null, actionMessageId: null, typingMessageId: null };
    return rows.map(r => ({
      harnessId: r["harness_id"] as string,
      channelId: r["channel_id"] as string,
      replyToId: r["reply_to_id"] as string,
      typingContent: (r["typing_content"] as string) ?? '',
      streamState: r["stream_state"] ? JSON.parse(r["stream_state"] as string) : { ...defaultState },
    }));
  }

  // --- In-flight turns ---

  setInFlight(channelId: string, harnessId: string, messageId: string, pubsubId: number, input: TurnInput): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO in_flight_turns (channel_id, harness_id, trigger_message_id, trigger_pubsub_id, turn_input, started_at) VALUES (?, ?, ?, ?, ?, ?)`,
      channelId, harnessId, messageId, pubsubId, JSON.stringify(input), Date.now(),
    );
  }

  getInFlight(channelId: string, harnessId: string): InFlightTurn | null {
    const row = this.sql.exec(
      `SELECT trigger_message_id, trigger_pubsub_id, turn_input FROM in_flight_turns WHERE channel_id = ? AND harness_id = ?`,
      channelId, harnessId,
    ).toArray();
    if (row.length === 0) return null;
    return {
      triggerMessageId: row[0]!["trigger_message_id"] as string,
      triggerPubsubId: row[0]!["trigger_pubsub_id"] as number,
      turnInput: JSON.parse(row[0]!["turn_input"] as string),
    };
  }

  clearInFlight(channelId: string, harnessId: string): void {
    this.sql.exec(`DELETE FROM in_flight_turns WHERE channel_id = ? AND harness_id = ?`, channelId, harnessId);
  }

  clearAllInFlight(): void {
    this.sql.exec(`DELETE FROM in_flight_turns`);
  }

  // --- Checkpoints ---

  advanceCheckpoint(channelId: string, harnessId: string | null, pubsubId: number): void {
    const hid = harnessId ?? '';
    this.sql.exec(
      `INSERT OR REPLACE INTO checkpoints (channel_id, harness_id, last_pubsub_id, updated_at) VALUES (?, NULLIF(?, ''), ?, ?)`,
      channelId, hid, pubsubId, Date.now(),
    );
  }

  getCheckpoint(channelId: string, harnessId: string | null): number | null {
    const row = this.sql.exec(
      harnessId
        ? `SELECT last_pubsub_id FROM checkpoints WHERE channel_id = ? AND harness_id = ?`
        : `SELECT last_pubsub_id FROM checkpoints WHERE channel_id = ? AND harness_id IS NULL`,
      ...(harnessId ? [channelId, harnessId] : [channelId]),
    ).toArray();
    if (row.length === 0) return null;
    return row[0]!["last_pubsub_id"] as number;
  }

  // --- Turn recording ---

  recordTurn(harnessId: string, messageId: string, triggerPubsubId: number, sessionId: string): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO turn_map (harness_id, turn_message_id, trigger_pubsub_id, external_session_id, created_at) VALUES (?, ?, ?, ?, ?)`,
      harnessId, messageId, triggerPubsubId, sessionId, Date.now(),
    );
    // NOTE: caller is responsible for updating harnesses.external_session_id
    // via HarnessManager — TurnManager does not own the harnesses table.
  }

  // --- Fork resolution ---

  getTurnAtOrBefore(harnessId: string, pubsubId: number): TurnRecord | null {
    const row = this.sql.exec(
      `SELECT turn_message_id, external_session_id FROM turn_map WHERE harness_id = ? AND trigger_pubsub_id <= ? ORDER BY trigger_pubsub_id DESC LIMIT 1`,
      harnessId, pubsubId,
    ).toArray();
    if (row.length === 0) return null;
    return {
      turnMessageId: row[0]!["turn_message_id"] as string,
      externalSessionId: row[0]!["external_session_id"] as string,
    };
  }

  getLatestTurn(harnessId: string): TurnRecord | null {
    const row = this.sql.exec(
      `SELECT turn_message_id, external_session_id FROM turn_map WHERE harness_id = ? ORDER BY trigger_pubsub_id DESC LIMIT 1`,
      harnessId,
    ).toArray();
    if (row.length === 0) return null;
    return {
      turnMessageId: row[0]!["turn_message_id"] as string,
      externalSessionId: row[0]!["external_session_id"] as string,
    };
  }

  getResumeSessionId(harnessId: string): string | undefined {
    return this.getLatestTurn(harnessId)?.externalSessionId;
  }

  /** Find the most recent session ID for a given harness ID list (single query). */
  getResumeSessionIdForHarnesses(harnessIds: string[]): string | undefined {
    if (harnessIds.length === 0) return undefined;
    const placeholders = harnessIds.map(() => '?').join(',');
    const row = this.sql.exec(
      `SELECT external_session_id FROM turn_map WHERE harness_id IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`,
      ...harnessIds,
    ).toArray();
    return row.length > 0 ? (row[0]!["external_session_id"] as string) : undefined;
  }

  // --- Persistence helpers ---

  persistStreamState(harnessId: string, streamState: PersistedStreamState): void {
    this.sql.exec(
      `UPDATE active_turns SET stream_state = ?, turn_message_id = COALESCE(?, turn_message_id) WHERE harness_id = ?`,
      JSON.stringify(streamState),
      streamState.responseMessageId,
      harnessId,
    );
  }

  // --- Queued turns ---

  enqueue(channelId: string, harnessId: string, messageId: string, pubsubId: number, senderId: string, input: TurnInput, typingContent?: string): void {
    this.sql.exec(
      `INSERT INTO queued_turns (channel_id, harness_id, message_id, pubsub_id, sender_id, turn_input, typing_content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      channelId, harnessId, messageId, pubsubId, senderId, JSON.stringify(input), typingContent ?? '', Date.now(),
    );
  }

  dequeue(harnessId: string): QueuedTurn | null {
    const row = this.sql.exec(
      `SELECT id, channel_id, message_id, pubsub_id, sender_id, turn_input, typing_content FROM queued_turns WHERE harness_id = ? ORDER BY id ASC LIMIT 1`,
      harnessId,
    ).toArray();
    if (row.length === 0) return null;
    const id = row[0]!["id"] as number;
    this.sql.exec(`DELETE FROM queued_turns WHERE id = ?`, id);
    return {
      channelId: row[0]!["channel_id"] as string,
      messageId: row[0]!["message_id"] as string,
      pubsubId: row[0]!["pubsub_id"] as number,
      senderId: row[0]!["sender_id"] as string,
      turnInput: JSON.parse(row[0]!["turn_input"] as string),
      typingContent: (row[0]!["typing_content"] as string) ?? '',
    };
  }

  clearQueueForHarness(harnessId: string): void {
    this.sql.exec(`DELETE FROM queued_turns WHERE harness_id = ?`, harnessId);
  }

  clearAllQueued(): void {
    this.sql.exec(`DELETE FROM queued_turns`);
  }

  // --- Cleanup for channel unsubscribe ---

  deleteForHarness(harnessId: string): void {
    this.sql.exec(`DELETE FROM active_turns WHERE harness_id = ?`, harnessId);
    this.sql.exec(`DELETE FROM in_flight_turns WHERE harness_id = ?`, harnessId);
    this.sql.exec(`DELETE FROM queued_turns WHERE harness_id = ?`, harnessId);
    this.sql.exec(`DELETE FROM turn_map WHERE harness_id = ?`, harnessId);
    this.sql.exec(`DELETE FROM checkpoints WHERE harness_id = ?`, harnessId);
  }

  deleteCheckpointsForChannel(channelId: string): void {
    this.sql.exec(`DELETE FROM checkpoints WHERE channel_id = ? AND harness_id IS NULL`, channelId);
  }
}
