import { DurableObjectBase, type DurableObjectContext } from "@workspace/runtime/worker";

/**
 * Sample Durable Object showing the canonical userland storage primitive.
 *
 * Each instance owns a single SQLite-backed `visits` table addressed via
 * `this.sql`. Callers reach the DO through the server's dispatch path
 * (postToDOWithToken / DODispatch); the fetch handler below is an info
 * message — DOs aren't routed from a sibling worker's fetch handler.
 *
 * For an end-to-end demonstration that round-trips through `this.sql`, see
 * `workspace/workers/sample-do/sampleDo.test.ts`, which uses `createTestDO`
 * to drive `recordVisit` and `visitCount` against a real SQLite-backed DO.
 */
export class SampleDO extends DurableObjectBase {
  protected createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL
      )
    `);
  }

  recordVisit(): { count: number } {
    this.ensureReady();
    this.sql.exec(`INSERT INTO visits (ts) VALUES (?)`, new Date().toISOString());
    return this.visitCount();
  }

  visitCount(): { count: number } {
    this.ensureReady();
    const row = this.sql.exec(`SELECT COUNT(*) as count FROM visits`).one() as { count: number };
    return { count: row.count };
  }
}

export default {
  async fetch(_request: Request) {
    return new Response(
      "Sample Durable Object worker.\nMethods: SampleDO.recordVisit, SampleDO.visitCount.\nDispatch via the server's DODispatch path; see sampleDo.test.ts for an end-to-end example using createTestDO.",
      { headers: { "Content-Type": "text/plain" } },
    );
  },
};

export type { DurableObjectContext };
