/**
 * Method call routing + timeout for the PubSub Channel DO.
 *
 * Method calls are stored in pending_calls and delivered to the target
 * participant. Results are routed back to the caller. Timeout via alarm.
 */

import type { SqlStorage } from "@workspace/runtime/worker";

const CALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Store a pending method call and deliver to the target.
 */
export function storeCall(
  sql: SqlStorage,
  callId: string,
  callerId: string,
  targetId: string,
  method: string,
  args: unknown,
): number {
  const now = Date.now();
  const expiresAt = now + CALL_TIMEOUT_MS;

  sql.exec(
    `INSERT INTO pending_calls (call_id, caller_id, target_id, method, args, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    callId, callerId, targetId, method, JSON.stringify(args), expiresAt, now,
  );

  return expiresAt;
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
 * Cancel a pending call.
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
 * Get the earliest expiry time for scheduling the alarm.
 */
export function getNextExpiry(sql: SqlStorage): number | null {
  const row = sql.exec(
    `SELECT MIN(expires_at) as next FROM pending_calls`,
  ).toArray();
  if (row.length === 0 || !row[0]!["next"]) return null;
  return row[0]!["next"] as number;
}

/**
 * Expire timed-out calls. Returns the expired call IDs and their caller IDs.
 */
export function expireCalls(sql: SqlStorage): Array<{ callId: string; callerId: string }> {
  const now = Date.now();
  const expired = sql.exec(
    `SELECT call_id, caller_id FROM pending_calls WHERE expires_at <= ?`, now,
  ).toArray();

  const results: Array<{ callId: string; callerId: string }> = [];
  for (const row of expired) {
    const callId = row["call_id"] as string;
    sql.exec(`DELETE FROM pending_calls WHERE call_id = ?`, callId);
    results.push({ callId, callerId: row["caller_id"] as string });
  }

  return results;
}
