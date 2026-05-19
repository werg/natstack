/**
 * DispatchedCallStore — Durable breadcrumb index for dispatched interactive calls.
 *
 * Each row tracks an in-flight dispatch while its provider result is pending:
 * - interactive tool calls routed to channel participants
 * - ask_user
 * - ctx.ui.* prompts
 * - approval-gate prompts
 *
 * The row is a durable cancellation/diagnostic breadcrumb. Results are not
 * spliced back into a prior transcript; live calls resolve from the canonical
 * method-result event and write their normal toolResult message.
 */

import type { SqlStorage } from "@workspace/runtime/worker";

export type DispatchedCallKind =
  | "tool-call"
  | "ask-user"
  | "ui-prompt"
  | "approval";

export interface DispatchedCall {
  callId: string;
  channelId: string;
  kind: DispatchedCallKind;
  toolCallId: string;
  toolName: string | null;
  paramsJson: string | null;
  targetParticipantId: string | null;
  methodName: string | null;
  argsJson: string | null;
  dispatchedAt: number | null;
  pendingResultJson: string | null;
  pendingIsError: boolean | null;
  abandonedReason: string | null;
  resolvingToken: string | null;
  createdAt: number;
}

export interface StoreDispatchedCallInput {
  callId: string;
  channelId: string;
  kind: DispatchedCallKind;
  toolCallId: string;
  toolName?: string | null;
  paramsJson?: string | null;
  targetParticipantId?: string | null;
  methodName?: string | null;
  argsJson?: string | null;
}

export class DispatchedCallStore {
  constructor(private readonly sql: SqlStorage) {}

  createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS dispatched_calls (
        call_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT,
        params_json TEXT,
        target_participant_id TEXT,
        method_name TEXT,
        args_json TEXT,
        dispatched_at INTEGER,
        pending_result_json TEXT,
        pending_is_error INTEGER,
        abandoned_reason TEXT,
        resolving_token TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    const columns = new Set(
      this.sql.exec(`PRAGMA table_info(dispatched_calls)`).toArray()
        .map((row) => String(row["name"] ?? "")),
    );
    if (!columns.has("abandoned_reason")) {
      this.sql.exec(`ALTER TABLE dispatched_calls ADD COLUMN abandoned_reason TEXT`);
    }
    if (!columns.has("resolving_token")) {
      this.sql.exec(`ALTER TABLE dispatched_calls ADD COLUMN resolving_token TEXT`);
    }
    if (!columns.has("target_participant_id")) {
      this.sql.exec(`ALTER TABLE dispatched_calls ADD COLUMN target_participant_id TEXT`);
    }
    if (!columns.has("method_name")) {
      this.sql.exec(`ALTER TABLE dispatched_calls ADD COLUMN method_name TEXT`);
    }
    if (!columns.has("args_json")) {
      this.sql.exec(`ALTER TABLE dispatched_calls ADD COLUMN args_json TEXT`);
    }
    if (!columns.has("dispatched_at")) {
      this.sql.exec(`ALTER TABLE dispatched_calls ADD COLUMN dispatched_at INTEGER`);
    }
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_dispatched_calls_channel
      ON dispatched_calls(channel_id)
    `);
  }

  store(input: StoreDispatchedCallInput): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO dispatched_calls (
         call_id, channel_id, kind, tool_call_id, tool_name, params_json,
         target_participant_id, method_name, args_json, dispatched_at,
         pending_result_json, pending_is_error, abandoned_reason, resolving_token, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)`,
      input.callId,
      input.channelId,
      input.kind,
      input.toolCallId,
      input.toolName ?? null,
      input.paramsJson ?? null,
      input.targetParticipantId ?? null,
      input.methodName ?? null,
      input.argsJson ?? null,
      Date.now(),
    );
  }

  peek(callId: string): DispatchedCall | null {
    const rows = this.sql.exec(
      `SELECT call_id, channel_id, kind, tool_call_id, tool_name, params_json,
              target_participant_id, method_name, args_json, dispatched_at,
              pending_result_json, pending_is_error, abandoned_reason, resolving_token, created_at
         FROM dispatched_calls
        WHERE call_id = ?`,
      callId,
    ).toArray();
    if (rows.length === 0) return null;
    return mapRow(rows[0]!);
  }

  markDispatched(callId: string): void {
    this.sql.exec(
      `UPDATE dispatched_calls SET dispatched_at = ? WHERE call_id = ?`,
      Date.now(),
      callId,
    );
  }

  bufferResult(callId: string, result: unknown, isError: boolean): void {
    this.sql.exec(
      `UPDATE dispatched_calls
          SET pending_result_json = ?,
              pending_is_error = ?
        WHERE call_id = ?`,
      JSON.stringify({ value: result }),
      isError ? 1 : 0,
      callId,
    );
  }

  clearResolvingTokens(): void {
    this.sql.exec(
      `UPDATE dispatched_calls
          SET resolving_token = NULL
        WHERE resolving_token IS NOT NULL`,
    );
  }

  listForChannel(channelId: string): DispatchedCall[] {
    const rows = this.sql.exec(
      `SELECT call_id, channel_id, kind, tool_call_id, tool_name, params_json,
              target_participant_id, method_name, args_json, dispatched_at,
              pending_result_json, pending_is_error, abandoned_reason, resolving_token, created_at
         FROM dispatched_calls
        WHERE channel_id = ?
        ORDER BY created_at ASC`,
      channelId,
    ).toArray();
    return rows.map((row) => mapRow(row));
  }

  deleteOne(callId: string): void {
    this.sql.exec(`DELETE FROM dispatched_calls WHERE call_id = ?`, callId);
  }

  deleteForChannel(channelId: string): void {
    this.sql.exec(`DELETE FROM dispatched_calls WHERE channel_id = ?`, channelId);
  }
}

function mapRow(row: Record<string, unknown>): DispatchedCall {
  return {
    callId: row["call_id"] as string,
    channelId: row["channel_id"] as string,
    kind: row["kind"] as DispatchedCallKind,
    toolCallId: row["tool_call_id"] as string,
    toolName: (row["tool_name"] as string | null) ?? null,
    paramsJson: (row["params_json"] as string | null) ?? null,
    targetParticipantId: (row["target_participant_id"] as string | null) ?? null,
    methodName: (row["method_name"] as string | null) ?? null,
    argsJson: (row["args_json"] as string | null) ?? null,
    dispatchedAt: row["dispatched_at"] == null ? null : Number(row["dispatched_at"]),
    pendingResultJson: (row["pending_result_json"] as string | null) ?? null,
    pendingIsError:
      row["pending_is_error"] == null
        ? null
        : Number(row["pending_is_error"]) !== 0,
    abandonedReason: (row["abandoned_reason"] as string | null) ?? null,
    resolvingToken: (row["resolving_token"] as string | null) ?? null,
    createdAt: Number(row["created_at"] ?? 0),
  };
}
