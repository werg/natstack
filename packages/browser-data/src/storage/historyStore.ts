import type Database from "better-sqlite3";
import type { ImportedHistoryEntry, HistoryQuery, HistoryTransition } from "../types.js";

export interface StoredHistory {
  id: number;
  url: string;
  title: string | null;
  visit_count: number;
  typed_count: number;
  first_visit: number | null;
  last_visit: number;
  favicon_id: number | null;
}

export interface StoredVisit {
  id: number;
  history_id: number;
  visit_time: number;
  transition: string;
  from_visit_id: number | null;
}

export class HistoryStore {
  constructor(private db: Database.Database) {}

  add(entry: {
    url: string;
    title?: string;
    visitCount?: number;
    typedCount?: number;
    firstVisit?: number;
    lastVisit: number;
    faviconId?: number;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO history (url, title, visit_count, typed_count, first_visit, last_visit, favicon_id)
      VALUES (@url, @title, @visitCount, @typedCount, @firstVisit, @lastVisit, @faviconId)
      ON CONFLICT(url) DO UPDATE SET
        title = COALESCE(@title, title),
        visit_count = visit_count + @visitCount,
        typed_count = typed_count + @typedCount,
        first_visit = MIN(COALESCE(first_visit, @firstVisit), COALESCE(@firstVisit, first_visit)),
        last_visit = MAX(last_visit, @lastVisit)
    `);
    const result = stmt.run({
      url: entry.url,
      title: entry.title ?? null,
      visitCount: entry.visitCount ?? 1,
      typedCount: entry.typedCount ?? 0,
      firstVisit: entry.firstVisit ?? entry.lastVisit,
      lastVisit: entry.lastVisit,
      faviconId: entry.faviconId ?? null,
    });

    if (result.changes === 0) {
      return Number(
        (
          this.db.prepare("SELECT id FROM history WHERE url = ?").get(entry.url) as {
            id: number;
          }
        ).id,
      );
    }
    return Number(result.lastInsertRowid);
  }

  addVisit(
    historyId: number,
    visitTime: number,
    transition: HistoryTransition = "link",
  ): number {
    const result = this.db
      .prepare(
        "INSERT INTO history_visits (history_id, visit_time, transition) VALUES (?, ?, ?)",
      )
      .run(historyId, visitTime, transition);
    return Number(result.lastInsertRowid);
  }

  delete(id: number): void {
    this.db.prepare("DELETE FROM history WHERE id = ?").run(id);
  }

  deleteRange(startTime: number, endTime: number): number {
    const result = this.db
      .prepare("DELETE FROM history WHERE last_visit >= ? AND last_visit <= ?")
      .run(startTime, endTime);
    return result.changes;
  }

  clearAll(): void {
    this.db.prepare("DELETE FROM history_visits").run();
    this.db.prepare("DELETE FROM history").run();
  }

  search(query: string, limit: number = 50): StoredHistory[] {
    const escaped = escapeFts5Query(query);
    return this.db
      .prepare(
        `SELECT h.* FROM history h
         JOIN history_fts fts ON h.id = fts.rowid
         WHERE history_fts MATCH @query
         ORDER BY h.last_visit DESC
         LIMIT @limit`,
      )
      .all({ query: escaped, limit }) as StoredHistory[];
  }

  query(q: HistoryQuery): StoredHistory[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (q.search) {
      conditions.push(
        "id IN (SELECT rowid FROM history_fts WHERE history_fts MATCH @search)",
      );
      params['search'] = escapeFts5Query(q.search);
    }
    if (q.startTime !== undefined) {
      conditions.push("last_visit >= @startTime");
      params['startTime'] = q.startTime;
    }
    if (q.endTime !== undefined) {
      conditions.push("last_visit <= @endTime");
      params['endTime'] = q.endTime;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = q.limit ?? 100;
    const offset = q.offset ?? 0;

    return this.db
      .prepare(
        `SELECT * FROM history ${where} ORDER BY last_visit DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit, offset }) as StoredHistory[];
  }

  addBatch(entries: ImportedHistoryEntry[]): number {
    const stmt = this.db.prepare(`
      INSERT INTO history (url, title, visit_count, typed_count, first_visit, last_visit)
      VALUES (@url, @title, @visitCount, @typedCount, @firstVisit, @lastVisit)
      ON CONFLICT(url) DO UPDATE SET
        title = COALESCE(@title, title),
        visit_count = visit_count + @visitCount,
        typed_count = typed_count + @typedCount,
        first_visit = MIN(COALESCE(first_visit, @firstVisit), COALESCE(@firstVisit, first_visit)),
        last_visit = MAX(last_visit, @lastVisit)
    `);

    let count = 0;
    const insertMany = this.db.transaction((items: ImportedHistoryEntry[]) => {
      for (const entry of items) {
        stmt.run({
          url: entry.url,
          title: entry.title ?? null,
          visitCount: entry.visitCount,
          typedCount: entry.typedCount ?? 0,
          firstVisit: entry.firstVisitTime ?? entry.lastVisitTime,
          lastVisit: entry.lastVisitTime,
        });
        count++;
      }
    });

    insertMany(entries);
    return count;
  }
}

/**
 * Escape a user query for FTS5 MATCH.
 * Splits into tokens, quotes each token that contains FTS5 special chars
 * (except `*` which is allowed as a suffix for prefix search).
 */
function escapeFts5Query(query: string): string {
  return query
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((token) => {
      // If the token contains FTS5 operators or special chars (but not trailing *),
      // wrap it in double quotes to treat as literal
      const hasStar = token.endsWith("*");
      const core = hasStar ? token.slice(0, -1) : token;
      if (/["(){}:^~\-+|]/.test(core)) {
        const escaped = `"${core.replace(/"/g, '""')}"`;
        return hasStar ? escaped + "*" : escaped;
      }
      return token;
    })
    .join(" ");
}
