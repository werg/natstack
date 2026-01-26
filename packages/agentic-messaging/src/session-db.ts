import { db } from "@natstack/runtime";

type Database = Awaited<ReturnType<typeof db.open>>;

export interface SessionRow {
  sessionKey: string;
  checkpointPubsubId: number | undefined;
  sdkSessionId: string | undefined;
  status: "active" | "interrupted";
  settings: Record<string, unknown> | undefined;
}

interface SessionRowDb {
  session_key: string;
  checkpoint_pubsub_id: number | null;
  sdk_session_id: string | null;
  status: string;
  settings: string | null;
}

export class SessionDb {
  private db: Database | null = null;
  private sessionKey: string;
  private sessionRow: SessionRow | null = null;

  constructor(
    private channel: string,
    private handle: string,
    private contextId: string = ""
  ) {
    // Session key uniquely identifies a participant in a channel
    this.sessionKey = `${channel}:${handle}`;
  }

  getSessionKey(): string {
    return this.sessionKey;
  }

  async initialize(): Promise<void> {
    // Database named by channel for session isolation
    const dbName = `channel-${this.channel}-sessions`;
    this.db = await db.open(dbName);
    await this.initializeSchema();
  }

  async getOrCreateSession(): Promise<SessionRow> {
    if (!this.db) throw new Error("SessionDb not initialized");

    const existing = await this.db.get<SessionRowDb>(
      `SELECT session_key, checkpoint_pubsub_id, sdk_session_id, status, settings
       FROM agentic_sessions
       WHERE session_key = ?`,
      [this.sessionKey]
    );

    if (existing) {
      let parsedSettings: Record<string, unknown> | undefined;
      if (existing.settings) {
        try {
          parsedSettings = JSON.parse(existing.settings);
        } catch {
          // Ignore parse errors, use undefined
        }
      }
      this.sessionRow = {
        sessionKey: existing.session_key,
        checkpointPubsubId: existing.checkpoint_pubsub_id ?? undefined,
        sdkSessionId: existing.sdk_session_id ?? undefined,
        status: existing.status === "interrupted" ? "interrupted" : "active",
        settings: parsedSettings,
      };
      return this.sessionRow;
    }

    const now = Date.now();
    await this.db.run(
      `INSERT INTO agentic_sessions
       (session_key, context_id, channel, handle, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [this.sessionKey, this.contextId, this.channel, this.handle, "active", now, now]
    );

    this.sessionRow = {
      sessionKey: this.sessionKey,
      checkpointPubsubId: undefined,
      sdkSessionId: undefined,
      status: "active",
      settings: undefined,
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

  async updateSettings(settings: Record<string, unknown>): Promise<void> {
    if (!this.db) throw new Error("SessionDb not initialized");
    const now = Date.now();
    const settingsJson = JSON.stringify(settings);
    await this.db.run(
      `UPDATE agentic_sessions
       SET settings = ?, updated_at = ?
       WHERE session_key = ?`,
      [settingsJson, now, this.sessionKey]
    );

    if (this.sessionRow) {
      this.sessionRow.settings = settings;
    }
  }

  async getSettings<T = Record<string, unknown>>(): Promise<T | null> {
    if (!this.db) throw new Error("SessionDb not initialized");

    const row = await this.db.get<{ settings: string | null }>(
      `SELECT settings FROM agentic_sessions WHERE session_key = ?`,
      [this.sessionKey]
    );

    if (!row?.settings) return null;

    try {
      return JSON.parse(row.settings) as T;
    } catch {
      return null;
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

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  private async initializeSchema(): Promise<void> {
    if (!this.db) throw new Error("SessionDb not initialized");

    // Schema versioning table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      );
    `);

    // Get current schema version (0 if not set)
    const versionRow = await this.db.get<{ version: number }>(
      "SELECT version FROM schema_version WHERE id = 1"
    );
    const currentVersion = versionRow?.version ?? 0;

    // Version 1: Initial schema with sessions table
    if (currentVersion < 1) {
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS agentic_sessions (
          session_key TEXT PRIMARY KEY,
          context_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          handle TEXT NOT NULL,
          checkpoint_pubsub_id INTEGER,
          sdk_session_id TEXT,
          status TEXT NOT NULL,
          settings TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_agentic_sessions_context
          ON agentic_sessions(context_id, channel, handle);
      `);
    }

    // Version 2: Remove legacy agentic_history table (no longer used)
    // The history is now derived from pubsub replay instead of being stored separately.
    if (currentVersion < 2) {
      // Check if the table exists before logging about removal
      const tableExists = await this.db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agentic_history'"
      );
      if (tableExists) {
        console.info("[SessionDb] Migrating schema v1 → v2: removing legacy agentic_history table");
      }
      await this.db.exec(`DROP TABLE IF EXISTS agentic_history;`);
      await this.db.exec(`DROP INDEX IF EXISTS idx_agentic_history_session;`);
    }

    // Update schema version to latest
    const latestVersion = 2;
    if (currentVersion < latestVersion) {
      await this.db.run(
        "INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)",
        [latestVersion]
      );
    }
  }
}
