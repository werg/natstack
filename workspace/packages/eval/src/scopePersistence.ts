/**
 * scopePersistence — Dependency-injected persistence interface for REPL scopes.
 *
 * ScopeManager never imports runtime/DB directly. All storage goes through
 * this interface so tests can swap in a no-op or in-memory implementation.
 */

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

export interface ScopeEntry {
  /** Durable UUID — stable across saves, changes only on push() */
  id: string;
  channelId: string;
  panelId: string;
  /** JSON string of serializable values only */
  data: string;
  /** Top-level keys that were fully serialized */
  serializedKeys: string[];
  /** Paths that were dropped during serialization, with reasons */
  droppedPaths: Array<{ path: string; reason: string }>;
  /** Top-level keys that were only partially serialized (some children dropped) */
  partialKeys: string[];
  /** Epoch ms — current scope = max(created_at) per panel */
  createdAt: number;
}

export interface ScopeListEntry {
  id: string;
  createdAt: number;
  keys: string[];
  partial: string[];
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ScopePersistence {
  /** Upsert a scope row — create or update by durable ID */
  upsert(entry: ScopeEntry): Promise<void>;

  /** Load the most recent scope for this panel (highest created_at) */
  loadCurrent(channelId: string, panelId: string): Promise<ScopeEntry | null>;

  /** Get any scope by its durable ID */
  get(id: string): Promise<ScopeEntry | null>;

  /** List all scopes for a channel, sorted by creation time */
  list(channelId: string): Promise<ScopeListEntry[]>;
}

// ---------------------------------------------------------------------------
// DB handle type (minimal interface — matches @workspace/runtime db.open())
// ---------------------------------------------------------------------------

export interface DbHandle {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null | undefined>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default implementation: DB via injected callback
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS repl_scopes (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  panel_id TEXT NOT NULL,
  data TEXT NOT NULL,
  serialized_keys TEXT NOT NULL,
  dropped_paths TEXT NOT NULL,
  partial_keys TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scopes_current ON repl_scopes(channel_id, panel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scopes_channel ON repl_scopes(channel_id, created_at);
`;

export class DbScopePersistence implements ScopePersistence {
  private dbHandle: DbHandle | null = null;
  private initPromise: Promise<DbHandle> | null = null;

  constructor(private dbOpen: () => Promise<DbHandle>) {}

  private async db(): Promise<DbHandle> {
    if (this.dbHandle) return this.dbHandle;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          const handle = await this.dbOpen();
          await handle.exec(SCHEMA_SQL);
          this.dbHandle = handle;
          return handle;
        } catch (err) {
          this.initPromise = null; // Allow retry on next call
          throw err;
        }
      })();
    }
    return this.initPromise;
  }

  async upsert(entry: ScopeEntry): Promise<void> {
    const handle = await this.db();
    await handle.run(
      `INSERT OR REPLACE INTO repl_scopes
        (id, channel_id, panel_id, data, serialized_keys, dropped_paths, partial_keys, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.channelId,
        entry.panelId,
        entry.data,
        JSON.stringify(entry.serializedKeys),
        JSON.stringify(entry.droppedPaths),
        JSON.stringify(entry.partialKeys),
        entry.createdAt,
      ],
    );
  }

  async loadCurrent(channelId: string, panelId: string): Promise<ScopeEntry | null> {
    const handle = await this.db();
    const row = await handle.get<{
      id: string;
      channel_id: string;
      panel_id: string;
      data: string;
      serialized_keys: string;
      dropped_paths: string;
      partial_keys: string;
      created_at: number;
    }>(
      `SELECT * FROM repl_scopes
        WHERE channel_id = ? AND panel_id = ?
        ORDER BY created_at DESC LIMIT 1`,
      [channelId, panelId],
    );
    if (!row) return null;
    return {
      id: row.id,
      channelId: row.channel_id,
      panelId: row.panel_id,
      data: row.data,
      serializedKeys: JSON.parse(row.serialized_keys) as string[],
      droppedPaths: JSON.parse(row.dropped_paths) as Array<{ path: string; reason: string }>,
      partialKeys: JSON.parse(row.partial_keys) as string[],
      createdAt: row.created_at,
    };
  }

  async get(id: string): Promise<ScopeEntry | null> {
    const handle = await this.db();
    const row = await handle.get<{
      id: string;
      channel_id: string;
      panel_id: string;
      data: string;
      serialized_keys: string;
      dropped_paths: string;
      partial_keys: string;
      created_at: number;
    }>(`SELECT * FROM repl_scopes WHERE id = ?`, [id]);
    if (!row) return null;
    return {
      id: row.id,
      channelId: row.channel_id,
      panelId: row.panel_id,
      data: row.data,
      serializedKeys: JSON.parse(row.serialized_keys) as string[],
      droppedPaths: JSON.parse(row.dropped_paths) as Array<{ path: string; reason: string }>,
      partialKeys: JSON.parse(row.partial_keys) as string[],
      createdAt: row.created_at,
    };
  }

  async list(channelId: string): Promise<ScopeListEntry[]> {
    const handle = await this.db();
    const rows = await handle.query<{
      id: string;
      serialized_keys: string;
      partial_keys: string;
      created_at: number;
    }>(
      `SELECT id, serialized_keys, partial_keys, created_at
        FROM repl_scopes WHERE channel_id = ?
        ORDER BY created_at ASC`,
      [channelId],
    );
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      keys: JSON.parse(row.serialized_keys) as string[],
      partial: JSON.parse(row.partial_keys) as string[],
    }));
  }
}
