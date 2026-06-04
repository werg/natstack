/**
 * Invocation routing for the PubSub Channel DO.
 *
 * Channel-routed invocations are stored in `pending_calls` and delivered to
 * the target participant. Results are routed back to the caller. The channel does not
 * impose an internal wall-clock timeout — agentic activities like long eval,
 * remote builds, LLM thinking, and user-input pauses can legitimately run for
 * a long time and a wall-clock kill converts legitimate work into hard failure.
 *
 * Pending calls are cancelled by **roster events** when a target participant
 * leaves, or by the channel DO's explicit timeout method when an external
 * caller owns a deadline. Roster cancellation delivers a synthetic error to
 * each affected caller via the normal result path.
 */

import type { SqlStorage } from "@workspace/runtime/worker";

/**
 * Store a pending invocation and deliver it to the target.
 */
export function storeCall(
  sql: SqlStorage,
  transportCallId: string,
  invocationId: string,
  turnId: string | undefined,
  callerId: string,
  targetId: string,
  method: string,
  args: unknown,
  deadlineAt?: number,
): void {
  sql.exec(
    `INSERT INTO pending_calls (transport_call_id, invocation_id, turn_id, caller_id, target_id, method, args, created_at, deadline_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    transportCallId, invocationId, turnId ?? null, callerId, targetId, method, JSON.stringify(args), Date.now(), deadlineAt ?? null,
  );
}

/**
 * Consume a pending call (retrieve and delete).
 */
export function consumeCall(sql: SqlStorage, transportCallId: string): {
  transportCallId: string;
  invocationId: string;
  turnId?: string;
  callerId: string;
  targetId: string;
  method: string;
  args: unknown;
} | null {
  const rows = sql.exec(
    `SELECT transport_call_id, invocation_id, turn_id, caller_id, target_id, method, args FROM pending_calls WHERE transport_call_id = ?`,
    transportCallId,
  ).toArray();

  if (rows.length === 0) return null;

  sql.exec(`DELETE FROM pending_calls WHERE transport_call_id = ?`, transportCallId);

  const row = rows[0]!;
  return {
    transportCallId: row["transport_call_id"] as string,
    invocationId: row["invocation_id"] as string,
    turnId: row["turn_id"] ? row["turn_id"] as string : undefined,
    callerId: row["caller_id"] as string,
    targetId: row["target_id"] as string,
    method: row["method"] as string,
    args: row["args"] ? JSON.parse(row["args"] as string) : undefined,
  };
}

/**
 * Cancel a pending call by ID.
 */
export function cancelCall(sql: SqlStorage, transportCallId: string): {
  transportCallId: string;
  invocationId: string;
  turnId?: string;
  callerId: string;
  targetId: string;
} | null {
  const rows = sql.exec(
    `SELECT transport_call_id, invocation_id, turn_id, caller_id, target_id FROM pending_calls WHERE transport_call_id = ?`,
    transportCallId,
  ).toArray();
  if (rows.length === 0) return null;
  sql.exec(`DELETE FROM pending_calls WHERE transport_call_id = ?`, transportCallId);
  const row = rows[0]!;
  return {
    transportCallId: row["transport_call_id"] as string,
    invocationId: row["invocation_id"] as string,
    turnId: row["turn_id"] ? row["turn_id"] as string : undefined,
    callerId: row["caller_id"] as string,
    targetId: row["target_id"] as string,
  };
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
): Array<{
  transportCallId: string;
  invocationId: string;
  turnId?: string;
  callerId: string;
  targetId: string;
}> {
  const rows = sql.exec(
    `SELECT transport_call_id, invocation_id, turn_id, caller_id, target_id FROM pending_calls WHERE target_id = ?`, targetId,
  ).toArray();
  if (rows.length === 0) return [];
  sql.exec(`DELETE FROM pending_calls WHERE target_id = ?`, targetId);
  return rows.map(r => ({
    transportCallId: r["transport_call_id"] as string,
    invocationId: r["invocation_id"] as string,
    turnId: r["turn_id"] ? r["turn_id"] as string : undefined,
    callerId: r["caller_id"] as string,
    targetId: r["target_id"] as string,
  }));
}
