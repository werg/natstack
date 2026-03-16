/**
 * DOIdentity — Manages DO bootstrap, identity persistence, and restart detection.
 *
 * Owns the `do_identity` table. Stores DORef and session ID in SQLite.
 * Detects workerd restarts by comparing session IDs.
 */

import type { SqlStorage, DORef } from "@workspace/runtime/worker";

export class DOIdentity {
  private _ref: DORef | null = null;
  private _sessionId: string | null = null;

  constructor(private sql: SqlStorage) {}

  createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS do_identity (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  /**
   * Bootstrap the DO with its identity and session.
   * Returns { isRestart: true } if the session ID changed (workerd restarted).
   */
  bootstrap(doRef: DORef, sessionId: string): { isRestart: boolean } {
    this.sql.exec(
      `INSERT OR REPLACE INTO do_identity (key, value) VALUES ('doRef', ?)`,
      JSON.stringify(doRef),
    );
    this._ref = doRef;

    const previousSessionId = this._sessionId;
    this.sql.exec(
      `INSERT OR REPLACE INTO do_identity (key, value) VALUES ('workerdSessionId', ?)`,
      sessionId,
    );
    this._sessionId = sessionId;

    const isRestart = previousSessionId != null && previousSessionId !== sessionId;
    return { isRestart };
  }

  /** Restore identity from SQLite (called during construction). */
  restore(): void {
    try {
      const rows = this.sql.exec(`SELECT key, value FROM do_identity`).toArray();
      for (const row of rows) {
        const key = row["key"] as string;
        const value = row["value"] as string;
        if (key === "doRef") {
          try { this._ref = JSON.parse(value); }
          catch (e) { console.error(`[DOIdentity] Corrupt doRef: ${value}`, e); }
        }
        if (key === "workerdSessionId") this._sessionId = value;
      }
    } catch { /* identity table may not exist yet — first run before bootstrap */ }
  }

  /** Get the DORef. Throws if not bootstrapped. */
  get ref(): DORef {
    if (!this._ref) throw new Error("DOIdentity not bootstrapped — call bootstrap() first");
    return this._ref;
  }

  /** Get the DORef or null if not bootstrapped yet. */
  get refOrNull(): DORef | null {
    return this._ref;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }
}
