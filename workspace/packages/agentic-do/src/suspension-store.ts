/**
 * SuspensionStore — the single durable spine for "a turn paused waiting for an
 * external event."
 *
 * Before this, the concept lived in ~7 partial, mostly-ephemeral places
 * (a thrown error + string sentinel, a `message.failed`, the dispatcher's
 * in-memory `parkedTurnId`, a `model_credential_interruptions` row, the
 * `waiting_external` ledger status, the separate `agent_method_suspensions`
 * store, and the server's in-memory deferral registry). This table is the
 * authoritative source of truth from which all of those are derived.
 *
 * A suspension is keyed by `id` — the reason-specific natural identity
 * (e.g. `credential:{channelId}:{providerId}`), of which there is at most one
 * live instance. `request_id` is the (nullable) deferred-call correlation id:
 * set when the wait is fronted by a deferred RPC (so an inbound `onDeferredResult`
 * can find the row), absent for waits resumed by another signal (e.g. a UI
 * "credential connected" callback keyed by channel+provider).
 *
 * Resume is an ATOMIC CLAIM: `claimResume` does a synchronous SELECT→UPDATE with
 * no `await` between, so under the workerd input-gate model the first caller to
 * flip `suspended`→`resuming` wins and every later/concurrent caller gets
 * `false`. That makes resume idempotent by construction — no double-resume, no
 * racy second writer.
 */

import type { SqlStorage } from "@workspace/runtime/worker";

export type SuspensionReason = "credential";

export type SuspensionStatus = "suspended" | "resuming";

export interface SuspensionRecordInput {
  /** Reason-specific natural identity; the unique key and claim key. */
  id: string;
  channelId: string;
  turnId: string;
  reason: SuspensionReason;
  /** Deferred-call correlation id, when the wait is fronted by a deferred RPC. */
  requestId?: string;
  idempotencyKey?: string;
  /** Cursor for the resume (e.g. message count to slice back to). */
  resumeCount?: number;
  /** Reason-specific payload (e.g. { providerId, modelBaseUrl }). */
  payload?: Record<string, unknown>;
  /**
   * Absolute expiry timestamp (ms). After this, `expireOverdue` claims the
   * suspension and the vessel fails the wait with a clear diagnostic instead
   * of letting the turn hang forever.
   */
  expiresAt?: number;
}

export interface SuspensionRow {
  id: string;
  channelId: string;
  turnId: string;
  reason: SuspensionReason;
  requestId: string | null;
  idempotencyKey: string | null;
  status: SuspensionStatus;
  resumeCount: number;
  payload: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

export class SuspensionStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly now: () => number = () => Date.now()
  ) {}

  createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS suspensions (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        request_id TEXT,
        idempotency_key TEXT,
        status TEXT NOT NULL,
        resume_count INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_suspensions_request ON suspensions(request_id)`);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_suspensions_channel_turn ON suspensions(channel_id, turn_id)`
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_suspensions_status ON suspensions(status)`);
  }

  /**
   * Record (or replace) a suspension as `suspended`. Written once, synchronously,
   * at park time — there is no detached second writer, so a resume delivery that
   * races in always finds a complete row.
   */
  record(input: SuspensionRecordInput): void {
    const ts = this.now();
    this.sql.exec(
      `INSERT OR REPLACE INTO suspensions
        (id, channel_id, turn_id, reason, request_id, idempotency_key,
         status, resume_count, payload_json, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'suspended', ?, ?, ?, ?, ?)`,
      input.id,
      input.channelId,
      input.turnId,
      input.reason,
      input.requestId ?? null,
      input.idempotencyKey ?? null,
      input.resumeCount ?? 0,
      input.payload ? JSON.stringify(input.payload) : null,
      ts,
      ts,
      input.expiresAt ?? null
    );
  }

  /**
   * Atomically claim every overdue suspension (suspended past its expires_at)
   * and return the claimed rows. The claim uses the same `suspended`→`resuming`
   * transition as a normal resume, so an expiry can never race a real resume —
   * whichever flips the status first wins.
   */
  expireOverdue(now: number = this.now()): SuspensionRow[] {
    const rows = this.sql
      .exec(
        `SELECT * FROM suspensions
         WHERE status = 'suspended' AND expires_at IS NOT NULL AND expires_at <= ?`,
        now
      )
      .toArray();
    const claimed: SuspensionRow[] = [];
    for (const raw of rows) {
      const row = this.toRow(raw);
      if (this.claimResume(row.id)) claimed.push(row);
    }
    return claimed;
  }

  /** Soonest expires_at across still-suspended rows, or null. */
  nextExpiry(): number | null {
    const rows = this.sql
      .exec(
        `SELECT MIN(expires_at) AS next FROM suspensions
         WHERE status = 'suspended' AND expires_at IS NOT NULL`
      )
      .toArray();
    const next = rows[0]?.["next"];
    return typeof next === "number" ? next : null;
  }

  findById(id: string): SuspensionRow | null {
    return this.firstRow(this.sql.exec(`SELECT * FROM suspensions WHERE id = ?`, id).toArray());
  }

  findByRequestId(requestId: string): SuspensionRow | null {
    return this.firstRow(
      this.sql.exec(`SELECT * FROM suspensions WHERE request_id = ?`, requestId).toArray()
    );
  }

  /** All still-suspended rows (for restart redrive). */
  listSuspended(reason?: SuspensionReason): SuspensionRow[] {
    const rows = reason
      ? this.sql
          .exec(`SELECT * FROM suspensions WHERE status = 'suspended' AND reason = ?`, reason)
          .toArray()
      : this.sql.exec(`SELECT * FROM suspensions WHERE status = 'suspended'`).toArray();
    return rows.map((row) => this.toRow(row));
  }

  /** All still-suspended rows that are backed by an out-of-band request. */
  listRedrivable(reason?: SuspensionReason): SuspensionRow[] {
    const rows = reason
      ? this.sql
          .exec(
            `SELECT * FROM suspensions
             WHERE status = 'suspended' AND reason = ? AND request_id IS NOT NULL`,
            reason
          )
          .toArray()
      : this.sql
          .exec(
            `SELECT * FROM suspensions
             WHERE status = 'suspended' AND request_id IS NOT NULL`
          )
          .toArray();
    return rows.map((row) => this.toRow(row));
  }

  /** True if the (channel, turn) has any live suspension (suspended or resuming). */
  hasOpenSuspension(channelId: string, turnId: string): boolean {
    return (
      this.sql
        .exec(
          `SELECT 1 FROM suspensions WHERE channel_id = ? AND turn_id = ? LIMIT 1`,
          channelId,
          turnId
        )
        .toArray().length > 0
    );
  }

  /** True if the turn has any live suspension (turn ids are globally unique). */
  hasOpenSuspensionForTurn(turnId: string): boolean {
    return (
      this.sql
        .exec(`SELECT 1 FROM suspensions WHERE turn_id = ? LIMIT 1`, turnId)
        .toArray().length > 0
    );
  }

  /**
   * Atomically claim the resume for a suspension. Returns true iff THIS caller
   * transitioned it `suspended`→`resuming`. Synchronous SELECT→UPDATE with no
   * `await` between: under workerd's input gate, concurrent claimers serialize,
   * so exactly one wins. The credential resume's idempotency rests entirely on
   * this — no separate guard needed.
   */
  claimResume(id: string): boolean {
    const rows = this.sql.exec(`SELECT status FROM suspensions WHERE id = ?`, id).toArray();
    if (rows.length === 0 || rows[0]!["status"] !== "suspended") return false;
    this.sql.exec(
      `UPDATE suspensions SET status = 'resuming', updated_at = ? WHERE id = ?`,
      this.now(),
      id
    );
    return true;
  }

  /**
   * Refine the resume cursor — but ONLY while still `suspended`. Used by the
   * detached message-count read at park time: a conditional UPDATE (never an
   * INSERT) so it can't resurrect a row that resume already resolved, nor clobber
   * a row another trigger already claimed. This is what makes the cursor refresh
   * non-blocking yet race-free (kills the orphan-row resurrection, P1-2).
   */
  setResumeCountIfSuspended(id: string, resumeCount: number): void {
    this.sql.exec(
      `UPDATE suspensions SET resume_count = ?, updated_at = ? WHERE id = ? AND status = 'suspended'`,
      resumeCount,
      this.now(),
      id
    );
  }

  /** Keep the suspension resumable by its natural id, but stop deferred re-drive. */
  clearRequestIdIfSuspended(id: string): void {
    this.sql.exec(
      `UPDATE suspensions
       SET request_id = NULL, idempotency_key = NULL, updated_at = ?
       WHERE id = ? AND status = 'suspended'`,
      this.now(),
      id
    );
  }

  /** Re-arm a claimed-but-not-completed resume back to `suspended` (e.g. a resume
   *  attempt that bailed before doing any work), so a later trigger can retry. */
  releaseClaim(id: string): void {
    this.sql.exec(
      `UPDATE suspensions SET status = 'suspended', updated_at = ? WHERE id = ? AND status = 'resuming'`,
      this.now(),
      id
    );
  }

  /** Suspension resolved — drop it. */
  resolve(id: string): void {
    this.sql.exec(`DELETE FROM suspensions WHERE id = ?`, id);
  }

  /** Drop every suspension for a (channel, turn) — used when a turn terminates. */
  clearForTurn(channelId: string, turnId: string): void {
    this.sql.exec(`DELETE FROM suspensions WHERE channel_id = ? AND turn_id = ?`, channelId, turnId);
  }

  private firstRow(rows: Record<string, unknown>[]): SuspensionRow | null {
    return rows.length === 0 ? null : this.toRow(rows[0]!);
  }

  private toRow(row: Record<string, unknown>): SuspensionRow {
    const payloadJson = row["payload_json"] as string | null;
    return {
      id: row["id"] as string,
      channelId: row["channel_id"] as string,
      turnId: row["turn_id"] as string,
      reason: row["reason"] as SuspensionReason,
      requestId: (row["request_id"] as string | null) ?? null,
      idempotencyKey: (row["idempotency_key"] as string | null) ?? null,
      status: row["status"] as SuspensionStatus,
      resumeCount: Number(row["resume_count"] ?? 0),
      payload: payloadJson ? (JSON.parse(payloadJson) as Record<string, unknown>) : {},
      createdAt: Number(row["created_at"]),
      updatedAt: Number(row["updated_at"]),
      expiresAt: typeof row["expires_at"] === "number" ? row["expires_at"] : null,
    };
  }
}

/** Reason-specific natural identity for a model-credential wait. */
export function credentialSuspensionId(channelId: string, providerId: string): string {
  return `credential:${channelId}:${providerId}`;
}
