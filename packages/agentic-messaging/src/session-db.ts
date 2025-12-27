import { db } from "@natstack/runtime";
import type { ConversationMessage } from "./types.js";

type Database = Awaited<ReturnType<typeof db.open>>;

export interface SessionRow {
  sessionKey: string;
  checkpointPubsubId: number | undefined;
  sdkSessionId: string | undefined;
  status: "active" | "interrupted";
}

interface SessionRowDb {
  session_key: string;
  checkpoint_pubsub_id: number | null;
  sdk_session_id: string | null;
  status: string;
}

interface HistoryRow {
  role: string;
  content: string;
}

export class SessionDb {
  private db: Database | null = null;
  private sessionKey: string;
  private sessionRow: SessionRow | null = null;

  constructor(
    private workspaceId: string,
    private channel: string,
    private handle: string
  ) {
    this.sessionKey = `${workspaceId}:${channel}:${handle}`;
  }

  getSessionKey(): string {
    return this.sessionKey;
  }

  async initialize(): Promise<void> {
    const dbName = `workspace-${this.workspaceId}-sessions`;
    this.db = await db.open(dbName);
    await this.initializeSchema();
  }

  async getOrCreateSession(): Promise<SessionRow> {
    if (!this.db) throw new Error("SessionDb not initialized");

    const existing = await this.db.get<SessionRowDb>(
      `SELECT session_key, checkpoint_pubsub_id, sdk_session_id, status
       FROM agentic_sessions
       WHERE session_key = ?`,
      [this.sessionKey]
    );

    if (existing) {
      this.sessionRow = {
        sessionKey: existing.session_key,
        checkpointPubsubId: existing.checkpoint_pubsub_id ?? undefined,
        sdkSessionId: existing.sdk_session_id ?? undefined,
        status: existing.status === "interrupted" ? "interrupted" : "active",
      };
      return this.sessionRow;
    }

    const now = Date.now();
    await this.db.run(
      `INSERT INTO agentic_sessions
       (session_key, workspace_id, channel, handle, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [this.sessionKey, this.workspaceId, this.channel, this.handle, "active", now, now]
    );

    this.sessionRow = {
      sessionKey: this.sessionKey,
      checkpointPubsubId: undefined,
      sdkSessionId: undefined,
      status: "active",
    };

    return this.sessionRow;
  }

  async commitCheckpoint(pubsubId: number): Promise<void> {
    if (!this.db) throw new Error("SessionDb not initialized");
    const now = Date.now();
    await this.db.run(
      `UPDATE agentic_sessions
       SET checkpoint_pubsub_id = ?, status = ?, updated_at = ?
       WHERE session_key = ?`,
      [pubsubId, "active", now, this.sessionKey]
    );

    if (this.sessionRow) {
      this.sessionRow.checkpointPubsubId = pubsubId;
      this.sessionRow.status = "active";
    }
  }

  async updateSdkSession(sessionId: string): Promise<void> {
    if (!this.db) throw new Error("SessionDb not initialized");
    const now = Date.now();
    await this.db.run(
      `UPDATE agentic_sessions
       SET sdk_session_id = ?, status = ?, updated_at = ?
       WHERE session_key = ?`,
      [sessionId, "active", now, this.sessionKey]
    );

    if (this.sessionRow) {
      this.sessionRow.sdkSessionId = sessionId;
      this.sessionRow.status = "active";
    }
  }

  async clearSdkSession(): Promise<void> {
    if (!this.db) throw new Error("SessionDb not initialized");
    const now = Date.now();
    await this.db.run(
      `UPDATE agentic_sessions
       SET sdk_session_id = NULL, updated_at = ?
       WHERE session_key = ?`,
      [now, this.sessionKey]
    );

    if (this.sessionRow) {
      this.sessionRow.sdkSessionId = undefined;
    }
  }

  async markInterrupted(): Promise<void> {
    if (!this.db) throw new Error("SessionDb not initialized");
    const now = Date.now();
    await this.db.run(
      `UPDATE agentic_sessions
       SET status = ?, updated_at = ?
       WHERE session_key = ?`,
      ["interrupted", now, this.sessionKey]
    );

    if (this.sessionRow) {
      this.sessionRow.status = "interrupted";
    }
  }

  async storeMessage(role: "user" | "assistant", content: string): Promise<void> {
    if (!this.db) throw new Error("SessionDb not initialized");
    await this.db.run(
      `INSERT INTO agentic_history (session_key, role, content, ts)
       VALUES (?, ?, ?, ?)`,
      [this.sessionKey, role, content, Date.now()]
    );
  }

  async getHistory(limit?: number): Promise<ConversationMessage[]> {
    if (!this.db) throw new Error("SessionDb not initialized");
    const query = limit
      ? `SELECT role, content FROM agentic_history
         WHERE session_key = ?
         ORDER BY ts DESC
         LIMIT ?`
      : `SELECT role, content FROM agentic_history
         WHERE session_key = ?
         ORDER BY ts ASC`;

    const rows = await this.db.query<HistoryRow>(
      query,
      limit ? [this.sessionKey, limit] : [this.sessionKey]
    );

    if (limit) {
      rows.reverse();
    }

    return rows.map((row) => ({
      role: row.role as "user" | "assistant",
      content: row.content,
    }));
  }

  async clearHistory(): Promise<void> {
    if (!this.db) throw new Error("SessionDb not initialized");
    await this.db.run(
      `DELETE FROM agentic_history WHERE session_key = ?`,
      [this.sessionKey]
    );
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  private async initializeSchema(): Promise<void> {
    if (!this.db) throw new Error("SessionDb not initialized");
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS agentic_sessions (
        session_key TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        handle TEXT NOT NULL,
        checkpoint_pubsub_id INTEGER,
        sdk_session_id TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agentic_sessions_workspace
        ON agentic_sessions(workspace_id, channel, handle);

      CREATE TABLE IF NOT EXISTS agentic_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        ts INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agentic_history_session
        ON agentic_history(session_key, ts);
    `);
  }
}
