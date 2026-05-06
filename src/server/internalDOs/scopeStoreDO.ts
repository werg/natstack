import { DurableObjectBase, type DurableObjectContext } from "../../../workspace/packages/runtime/src/worker/durable-base.js";
import type { ScopeEntry, ScopeListEntry } from "../../../workspace/packages/eval/src/scopePersistence.js";

interface ScopeRow {
  id: string;
  channel_id: string;
  panel_id: string;
  data: string;
  serialized_keys: string;
  dropped_paths: string;
  partial_keys: string;
  created_at: number;
}

export class ScopeStoreDO extends DurableObjectBase {
  static override schemaVersion = 1;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.ensureReady();
  }

  protected createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS repl_scopes (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        panel_id TEXT NOT NULL,
        data TEXT NOT NULL,
        serialized_keys TEXT NOT NULL,
        dropped_paths TEXT NOT NULL,
        partial_keys TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_scopes_current
      ON repl_scopes(channel_id, panel_id, created_at DESC)
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_scopes_channel
      ON repl_scopes(channel_id, created_at)
    `);
  }

  upsert(entry: ScopeEntry): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO repl_scopes
        (id, channel_id, panel_id, data, serialized_keys, dropped_paths, partial_keys, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.id,
      entry.channelId,
      entry.panelId,
      entry.data,
      JSON.stringify(entry.serializedKeys),
      JSON.stringify(entry.droppedPaths),
      JSON.stringify(entry.partialKeys),
      entry.createdAt,
    );
  }

  loadCurrent(channelId: string, panelId: string): ScopeEntry | null {
    const row = this.sql.exec(
      `SELECT * FROM repl_scopes
       WHERE channel_id = ? AND panel_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      channelId,
      panelId,
    ).toArray()[0] as unknown as ScopeRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  get(id: string): ScopeEntry | null {
    const row = this.sql.exec(`SELECT * FROM repl_scopes WHERE id = ?`, id)
      .toArray()[0] as unknown as ScopeRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  list(channelId: string): ScopeListEntry[] {
    const rows = this.sql.exec(
      `SELECT id, serialized_keys, partial_keys, created_at
       FROM repl_scopes WHERE channel_id = ?
       ORDER BY created_at ASC`,
      channelId,
    ).toArray() as Array<{
      id: string;
      serialized_keys: string;
      partial_keys: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      keys: JSON.parse(row.serialized_keys) as string[],
      partial: JSON.parse(row.partial_keys) as string[],
    }));
  }

  private fromRow(row: ScopeRow): ScopeEntry {
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
}

