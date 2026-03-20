/**
 * HarnessManager — Harness lifecycle tracking.
 *
 * Owns the `harnesses` table. Calls server directly via ServerDOClient.
 */

import type { SqlStorage } from "@workspace/runtime/worker";
import type { ServerDOClient } from "@workspace/runtime/worker";

export class HarnessManager {
  constructor(
    private sql: SqlStorage,
    private server: ServerDOClient,
  ) {}

  createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS harnesses (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        parent_id TEXT,
        fork_point_message_id INTEGER,
        external_session_id TEXT,
        state TEXT,
        last_aligned_message_id INTEGER,
        created_at INTEGER NOT NULL
      )
    `);
  }

  register(harnessId: string, type: string): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO harnesses (id, type, status, created_at) VALUES (?, ?, 'starting', ?)`,
      harnessId, type, Date.now(),
    );
  }

  reactivate(harnessId: string): void {
    this.sql.exec(`UPDATE harnesses SET status = 'starting' WHERE id = ?`, harnessId);
  }

  setStatus(harnessId: string, status: string): void {
    this.sql.exec(`UPDATE harnesses SET status = ? WHERE id = ?`, status, harnessId);
  }

  setSessionId(harnessId: string, sessionId: string): void {
    this.sql.exec(`UPDATE harnesses SET external_session_id = ? WHERE id = ?`, sessionId, harnessId);
  }

  setStatusWithState(harnessId: string, status: string, state: Record<string, unknown>): void {
    this.sql.exec(
      `UPDATE harnesses SET status = ?, state = ? WHERE id = ?`,
      status, JSON.stringify(state), harnessId,
    );
  }

  getActive(): string | null {
    const row = this.sql.exec(
      `SELECT id FROM harnesses WHERE status = 'active' LIMIT 1`,
    ).toArray();
    return row.length > 0 ? (row[0]!["id"] as string) : null;
  }

  getAlignment(harnessId: string): { lastAlignedMessageId: number | null } {
    const row = this.sql.exec(
      `SELECT last_aligned_message_id FROM harnesses WHERE id = ?`, harnessId,
    ).toArray();
    return {
      lastAlignedMessageId: row.length > 0
        ? (row[0]!["last_aligned_message_id"] as number | null)
        : null,
    };
  }

  /** Mark all active/starting harnesses as crashed (called on restart). */
  markCrashedOnRestart(): void {
    this.sql.exec(`UPDATE harnesses SET status = 'crashed' WHERE status IN ('active', 'starting')`);
  }

  /** List all harness IDs. */
  listAll(): string[] {
    const rows = this.sql.exec(`SELECT id FROM harnesses`).toArray();
    return rows.map(r => r["id"] as string);
  }

  /** Delete all harnesses. */
  deleteAll(): void {
    this.sql.exec(`DELETE FROM harnesses`);
  }

  /** Stop a harness via server API (best-effort). */
  async stop(harnessId: string): Promise<void> {
    try {
      await this.server.stopHarness(harnessId);
    } catch { /* harness may already be stopped */ }
  }
}
