/**
 * Method call routing for the PubSub Channel DO.
 *
 * Method calls are stored in `pending_calls` and delivered to the target
 * participant. Results are routed back to the caller. Calls have **no
 * wall-clock timeout** — agentic activities like long eval, remote builds,
 * LLM thinking, and user-input pauses can legitimately run for a long time
 * and a wall-clock kill converts legitimate work into hard failure.
 *
 * Pending calls are instead cancelled by **roster events**: when a target
 * participant leaves the channel (graceful unsubscribe, disconnect, or stale
 * eviction), `cancelCallsForTarget` is called from the leave handlers and
 * delivers a synthetic error to each affected caller via the normal result
 * path. This is the same mechanism the harness side uses to detect orphan
 * tool calls.
 */

import type { SqlStorage } from "@workspace/runtime/worker";

/**
 * Store a pending method call and deliver to the target.
 *
 * The `expires_at` column is a vestigial NOT NULL field from when this DO had
 * a wall-clock timeout on pending calls. The alarm code that read it has been
 * removed; we insert `0` as a sentinel to keep the schema's NOT NULL
 * constraint satisfied without migrating existing DOs. Pre-existing rows with
 * real expires_at values are simply ignored at read time — nothing queries it.
 */
export function storeCall(
  sql: SqlStorage,
  callId: string,
  callerId: string,
  targetId: string,
  method: string,
  args: unknown,
): void {
  sql.exec(
    `INSERT INTO pending_calls (call_id, caller_id, target_id, method, args, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
    callId, callerId, targetId, method, JSON.stringify(args), Date.now(),
  );
}

/**
 * Consume a pending call (retrieve and delete).
 */
export function consumeCall(sql: SqlStorage, callId: string): {
  callerId: string;
  targetId: string;
  method: string;
  args: unknown;
} | null {
  const rows = sql.exec(
    `SELECT caller_id, target_id, method, args FROM pending_calls WHERE call_id = ?`,
    callId,
  ).toArray();

  if (rows.length === 0) return null;

  sql.exec(`DELETE FROM pending_calls WHERE call_id = ?`, callId);

  const row = rows[0]!;
  return {
    callerId: row["caller_id"] as string,
    targetId: row["target_id"] as string,
    method: row["method"] as string,
    args: row["args"] ? JSON.parse(row["args"] as string) : undefined,
  };
}

/**
 * Cancel a pending call by ID.
 */
export function cancelCall(sql: SqlStorage, callId: string): boolean {
  const rows = sql.exec(
    `SELECT call_id FROM pending_calls WHERE call_id = ?`, callId,
  ).toArray();
  if (rows.length === 0) return false;
  sql.exec(`DELETE FROM pending_calls WHERE call_id = ?`, callId);
  return true;
}

/**
 * Cancel all pending calls targeting a participant that just left the channel.
 *
 * Returns the affected callIds + caller IDs so the channel DO can deliver a
 * synthetic error result to each caller via its normal result path. This is
 * the roster-based equivalent of a "target gone" failure — it converts the
 * orphaned call into a fast, meaningful error rather than hanging forever.
 */
export function cancelCallsForTarget(
  sql: SqlStorage,
  targetId: string,
): Array<{ callId: string; callerId: string }> {
  const rows = sql.exec(
    `SELECT call_id, caller_id FROM pending_calls WHERE target_id = ?`, targetId,
  ).toArray();
  if (rows.length === 0) return [];
  sql.exec(`DELETE FROM pending_calls WHERE target_id = ?`, targetId);
  return rows.map(r => ({
    callId: r["call_id"] as string,
    callerId: r["caller_id"] as string,
  }));
}

/**
 * Find pending calls older than `cutoffMs` (their `created_at` timestamp is
 * before `cutoffMs`). Used by the alarm-driven orphan sweep — see channel-do
 * `alarm()` and `failAgedPendingCalls`.
 *
 * This is a safety net, NOT a wall-clock timeout on agentic activity. The
 * cutoff is intentionally far beyond any plausible legitimate eval/build/LLM
 * call (the channel DO uses 30 minutes), so this only fires for calls that
 * have genuinely been forgotten by the dispatch chain — usually because the
 * target processed the call but never sent a result back, or because a
 * reconnect race left the call addressed to a stale participant entry.
 */
export function findAgedPendingCalls(
  sql: SqlStorage,
  cutoffMs: number,
): Array<{ callId: string; callerId: string; targetId: string; method: string; ageMs: number }> {
  const now = Date.now();
  const rows = sql.exec(
    `SELECT call_id, caller_id, target_id, method, created_at FROM pending_calls WHERE created_at < ?`,
    cutoffMs,
  ).toArray();
  if (rows.length === 0) return [];
  return rows.map(r => ({
    callId: r["call_id"] as string,
    callerId: r["caller_id"] as string,
    targetId: r["target_id"] as string,
    method: r["method"] as string,
    ageMs: now - (r["created_at"] as number),
  }));
}

/** Bulk-delete pending calls by callId. */
export function deleteCallsByIds(sql: SqlStorage, callIds: string[]): void {
  if (callIds.length === 0) return;
  const placeholders = callIds.map(() => "?").join(",");
  sql.exec(`DELETE FROM pending_calls WHERE call_id IN (${placeholders})`, ...callIds);
}

/** Whether any pending calls exist. Used by the alarm scheduler. */
export function hasPendingCalls(sql: SqlStorage): boolean {
  const row = sql.exec(`SELECT 1 FROM pending_calls LIMIT 1`).toArray();
  return row.length > 0;
}
