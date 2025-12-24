/**
 * Session management for agentic responders
 *
 * Enables conversation resumption across worker restarts, reconnections, and crashes.
 * Uses per-workspace SQLite storage with SDK-native session features where available.
 */

import { db } from "@natstack/runtime";

// Database type inferred from db.open() return type
type Database = Awaited<ReturnType<typeof db.open>>;

export interface SessionManagerOptions {
  /** Workspace ID - used to scope database */
  workspaceId: string;
  /** Channel name for this session */
  channelName: string;
  /** Agent handle (e.g., "claude", "codex") - unique within channel */
  agentHandle: string;
  /** SDK type: 'claude-agent-sdk' | 'codex-sdk' | 'manual' */
  sdkType: "claude-agent-sdk" | "codex-sdk" | "manual";
  /** Optional working directory for the session */
  workingDirectory?: string;
}

export interface SessionState {
  /** Unique session key: workspace:channel:handle */
  sessionKey: string;
  /** SDK-specific session ID (Claude session_id, Codex thread_id) */
  sdkSessionId?: string;
  /** Last pubsub message ID processed */
  lastSeenMessageId?: number;
  /** Timestamp of last successful response (ms) */
  lastCommittedAt?: number;
  /** Session status */
  status: "active" | "interrupted" | "closed";
  /** Database row ID */
  id?: number;
}

export interface ConversationMessage {
  /** 'user' or 'assistant' */
  role: "user" | "assistant";
  /** Message content */
  content: string;
}

/**
 * Internal database row type for agent_sessions table.
 */
interface AgentSessionRow {
  id: number;
  session_key: string;
  workspace_id: string;
  channel_name: string;
  agent_handle: string;
  sdk_session_id: string | null;
  sdk_type: string;
  last_seen_message_id: number | null;
  last_committed_at: number | null;
  created_at: number;
  updated_at: number;
  status: string;
  working_directory: string | null;
}

/**
 * Session manager for agentic responders.
 * Handles session persistence, resumption, and conversation history.
 */
export class SessionManager {
  private db: Database | null = null;
  private sessionKey: string;
  private options: SessionManagerOptions;
  private sessionState: SessionState | null = null;
  private schemaVersion = 1;

  constructor(options: SessionManagerOptions) {
    this.options = options;
    this.sessionKey = `${options.workspaceId}:${options.channelName}:${options.agentHandle}`;
  }

  /**
   * Initialize database connection and schema.
   * Call this before any other operations.
   */
  async initialize(): Promise<void> {
    // Open database scoped to workspace
    const dbName = `workspace-${this.options.workspaceId}-sessions`;
    this.db = await db.open(dbName);

    // Initialize schema if not already present
    await this.initializeSchema();
  }

  /**
   * Get or create a session for this responder.
   * If session exists, resume from last checkpoint.
   * If session is stale (interrupted), mark as interrupted.
   */
  async getOrCreateSession(): Promise<SessionState> {
    if (!this.db) throw new Error("SessionManager not initialized. Call initialize() first.");

    // Check if session already exists
    const existing = await this.db.get<AgentSessionRow>(
      `SELECT * FROM agent_sessions WHERE session_key = ?`,
      [this.sessionKey]
    );

    if (existing) {
      // Check if session was interrupted (no update in X minutes)
      const staleDuration = Date.now() - (existing.last_committed_at || 0);
      const staleThreshold = 5 * 60 * 1000; // 5 minutes

      if (existing.last_committed_at && staleDuration > staleThreshold) {
        console.log(
          `[SessionManager] Session was interrupted ${staleDuration}ms ago, marking as interrupted`
        );
        await this.markInterrupted();
      }

      this.sessionState = {
        sessionKey: existing.session_key,
        sdkSessionId: existing.sdk_session_id || undefined,
        lastSeenMessageId: existing.last_seen_message_id || undefined,
        lastCommittedAt: existing.last_committed_at || undefined,
        status: (existing.status as SessionState["status"]) || "active",
        id: existing.id,
      };

      return this.sessionState;
    }

    // Create new session
    return await this.createSession();
  }

  /**
   * Create a new session.
   */
  private async createSession(): Promise<SessionState> {
    if (!this.db) throw new Error("SessionManager not initialized. Call initialize() first.");

    const now = Date.now();
    const result = await this.db.run(
      `INSERT INTO agent_sessions
       (session_key, workspace_id, channel_name, agent_handle, sdk_type, status, created_at, updated_at, working_directory)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.sessionKey,
        this.options.workspaceId,
        this.options.channelName,
        this.options.agentHandle,
        this.options.sdkType,
        "active",
        now,
        now,
        this.options.workingDirectory || null,
      ]
    );

    this.sessionState = {
      sessionKey: this.sessionKey,
      status: "active",
      id: Number(result.lastInsertRowid),
    };

    return this.sessionState;
  }

  /**
   * Commit a message to the session.
   * Updates last_seen_message_id and last_committed_at.
   * Optionally stores SDK session ID (for Claude/Codex).
   */
  async commitMessage(pubsubMessageId: number, sdkSessionId?: string): Promise<void> {
    if (!this.db) throw new Error("SessionManager not initialized. Call initialize() first.");

    const now = Date.now();
    await this.db.run(
      `UPDATE agent_sessions
       SET last_seen_message_id = ?, last_committed_at = ?, sdk_session_id = COALESCE(?, sdk_session_id), updated_at = ?
       WHERE session_key = ?`,
      [pubsubMessageId, now, sdkSessionId || null, now, this.sessionKey]
    );

    if (this.sessionState) {
      this.sessionState.lastSeenMessageId = pubsubMessageId;
      this.sessionState.lastCommittedAt = now;
      if (sdkSessionId) {
        this.sessionState.sdkSessionId = sdkSessionId;
      }
    }
  }

  /**
   * Mark session as interrupted (e.g., after crash).
   * Preserves session state for resumption.
   */
  async markInterrupted(): Promise<void> {
    if (!this.db) throw new Error("SessionManager not initialized. Call initialize() first.");

    await this.db.run(
      `UPDATE agent_sessions SET status = ?, updated_at = ? WHERE session_key = ?`,
      ["interrupted", Date.now(), this.sessionKey]
    );

    if (this.sessionState) {
      this.sessionState.status = "interrupted";
    }
  }

  /**
   * Close session gracefully.
   */
  async closeSession(): Promise<void> {
    if (!this.db) throw new Error("SessionManager not initialized. Call initialize() first.");

    await this.db.run(
      `UPDATE agent_sessions SET status = ?, updated_at = ? WHERE session_key = ?`,
      ["closed", Date.now(), this.sessionKey]
    );

    if (this.sessionState) {
      this.sessionState.status = "closed";
    }
  }

  /**
   * Store a message in conversation history (for manual history SDKs).
   * Used by Simple AI responder.
   */
  async storeMessage(
    messageId: string,
    pubsubMessageId: number,
    role: "user" | "assistant",
    content: string
  ): Promise<void> {
    if (!this.db) throw new Error("SessionManager not initialized. Call initialize() first.");

    await this.db.run(
      `INSERT INTO conversation_history
       (session_key, message_id, pubsub_message_id, role, content, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [this.sessionKey, messageId, pubsubMessageId, role, content, Date.now()]
    );
  }

  /**
   * Get conversation history for a session.
   * Returns messages in chronological order.
   * Can optionally limit to last N messages (sliding window).
   */
  async getConversationHistory(limit?: number): Promise<ConversationMessage[]> {
    if (!this.db) throw new Error("SessionManager not initialized. Call initialize() first.");

    const query = limit
      ? `SELECT role, content FROM conversation_history
         WHERE session_key = ?
         ORDER BY timestamp DESC
         LIMIT ?`
      : `SELECT role, content FROM conversation_history
         WHERE session_key = ?
         ORDER BY timestamp ASC`;

    interface HistoryRow {
      role: string;
      content: string;
    }

    const rows = await this.db.query<HistoryRow>(
      query,
      limit ? [this.sessionKey, limit] : [this.sessionKey]
    );

    // If we limited, we need to reverse to get chronological order
    if (limit) {
      rows.reverse();
    }

    return rows.map((row: HistoryRow) => ({
      role: row.role as "user" | "assistant",
      content: row.content,
    }));
  }

  /**
   * Clear conversation history for a session.
   * Useful for starting fresh or cleanup.
   */
  async clearConversationHistory(): Promise<void> {
    if (!this.db) throw new Error("SessionManager not initialized. Call initialize() first.");

    await this.db.run(
      `DELETE FROM conversation_history WHERE session_key = ?`,
      [this.sessionKey]
    );
  }

  /**
   * Get the database instance for direct queries.
   * Use with caution - prefer the SessionManager methods when possible.
   */
  getDatabase(): Database {
    if (!this.db) throw new Error("SessionManager not initialized. Call initialize() first.");
    return this.db;
  }

  /**
   * Get current session state.
   */
  getSessionState(): SessionState | null {
    return this.sessionState;
  }

  /**
   * Get session key.
   */
  getSessionKey(): string {
    return this.sessionKey;
  }

  /**
   * Close database connection.
   */
  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  /**
   * Initialize database schema if not already present.
   */
  private async initializeSchema(): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    // Check schema version
    const versionRow = await this.db.get<{ version: number }>(
      `SELECT version FROM schema_version LIMIT 1`
    );

    if (versionRow && versionRow.version >= this.schemaVersion) {
      // Schema already initialized
      return;
    }

    // Create tables
    await this.db.exec(`
      -- Schema version tracking
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );

      -- Agent session state tracking
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        agent_handle TEXT NOT NULL,

        -- SDK-specific session identifiers
        sdk_session_id TEXT,
        sdk_type TEXT NOT NULL,

        -- Message tracking for replay
        last_seen_message_id INTEGER,
        last_committed_at INTEGER,

        -- Session lifecycle
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT DEFAULT 'active',

        -- Working directory for SDK sessions
        working_directory TEXT,

        UNIQUE(workspace_id, channel_name, agent_handle)
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_key ON agent_sessions(session_key);
      CREATE INDEX IF NOT EXISTS idx_sessions_workspace_channel ON agent_sessions(workspace_id, channel_name);

      -- Manual conversation history for simple AI responder
      CREATE TABLE IF NOT EXISTS conversation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        message_id TEXT NOT NULL,
        pubsub_message_id INTEGER,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,

        FOREIGN KEY (session_key) REFERENCES agent_sessions(session_key) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_history_session ON conversation_history(session_key, timestamp);
    `);

    // Update schema version
    if (!versionRow) {
      await this.db.run(`INSERT INTO schema_version VALUES (?)`, [this.schemaVersion]);
    } else {
      await this.db.run(`UPDATE schema_version SET version = ?`, [this.schemaVersion]);
    }
  }
}
