/**
 * MemoryManager — Persistent cross-session agent memory.
 *
 * Stores key-value facts with categories in DO SQLite.
 * Survives hibernation, restarts, and fork cloning.
 * Exposed to the LLM via method advertisements on agent workers.
 */

export interface MemoryEntry {
  key: string;
  value: string;
  category: string;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
}

interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export class MemoryManager {
  constructor(private sql: SqlStorage) {}

  createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_memory_category ON agent_memory(category)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_memory_updated ON agent_memory(updated_at)`);
  }

  /** Store or update a fact. */
  remember(key: string, value: string, category?: string): void {
    const now = Date.now();
    const cat = category ?? "general";
    this.sql.exec(
      `INSERT INTO agent_memory (key, value, category, created_at, updated_at, access_count)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, category = excluded.category, updated_at = excluded.updated_at`,
      key, value, cat, now, now,
    );
  }

  /** Retrieve a specific fact by key. Returns null if not found. */
  recall(key: string): string | null {
    const rows = this.sql.exec(
      `UPDATE agent_memory SET access_count = access_count + 1, updated_at = ? WHERE key = ? RETURNING value`,
      Date.now(), key,
    ).toArray();
    return rows.length > 0 ? (rows[0]!["value"] as string) : null;
  }

  /** Search memories by substring match on key or value, optionally filtered by category. */
  search(query: string, category?: string, limit?: number): MemoryEntry[] {
    const lim = limit ?? 20;
    const pattern = `%${query}%`;
    const rows = category
      ? this.sql.exec(
          `SELECT * FROM agent_memory WHERE category = ? AND (key LIKE ? OR value LIKE ?) ORDER BY updated_at DESC LIMIT ?`,
          category, pattern, pattern, lim,
        ).toArray()
      : this.sql.exec(
          `SELECT * FROM agent_memory WHERE key LIKE ? OR value LIKE ? ORDER BY updated_at DESC LIMIT ?`,
          pattern, pattern, lim,
        ).toArray();
    return rows.map(rowToEntry);
  }

  /** Delete a memory entry. Returns true if it existed. */
  forget(key: string): boolean {
    const before = this.sql.exec(`SELECT COUNT(*) as cnt FROM agent_memory WHERE key = ?`, key).toArray();
    if ((before[0]?.["cnt"] as number) === 0) return false;
    this.sql.exec(`DELETE FROM agent_memory WHERE key = ?`, key);
    return true;
  }

  /** List all distinct categories. */
  listCategories(): string[] {
    const rows = this.sql.exec(`SELECT DISTINCT category FROM agent_memory ORDER BY category`).toArray();
    return rows.map(r => r["category"] as string);
  }

  /** Get most recently updated entries. */
  getRecent(limit?: number): MemoryEntry[] {
    const lim = limit ?? 20;
    const rows = this.sql.exec(
      `SELECT * FROM agent_memory ORDER BY updated_at DESC LIMIT ?`,
      lim,
    ).toArray();
    return rows.map(rowToEntry);
  }

  /** Summary of memory state. */
  summarize(): { totalEntries: number; categories: Record<string, number> } {
    const total = this.sql.exec(`SELECT COUNT(*) as cnt FROM agent_memory`).toArray();
    const cats = this.sql.exec(
      `SELECT category, COUNT(*) as cnt FROM agent_memory GROUP BY category ORDER BY category`,
    ).toArray();
    const categories: Record<string, number> = {};
    for (const row of cats) {
      categories[row["category"] as string] = row["cnt"] as number;
    }
    return {
      totalEntries: (total[0]?.["cnt"] as number) ?? 0,
      categories,
    };
  }
}

function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    key: row["key"] as string,
    value: row["value"] as string,
    category: row["category"] as string,
    createdAt: row["created_at"] as number,
    updatedAt: row["updated_at"] as number,
    accessCount: row["access_count"] as number,
  };
}
