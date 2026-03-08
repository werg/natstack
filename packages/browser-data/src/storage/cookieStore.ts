import type Database from "better-sqlite3";
import type { ImportedCookie } from "../types.js";

export interface StoredCookie {
  id: number;
  name: string;
  value: string;
  domain: string;
  host_only: number;
  path: string;
  expiration_date: number | null;
  secure: number;
  http_only: number;
  same_site: string;
  source_scheme: string | null;
  source_port: number;
  source_browser: string | null;
  created_at: number;
  last_accessed: number | null;
}

export class CookieStore {
  constructor(private db: Database.Database) {}

  add(cookie: {
    name: string;
    value: string;
    domain: string;
    hostOnly?: boolean;
    path?: string;
    expirationDate?: number;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: string;
    sourceScheme?: string;
    sourcePort?: number;
    sourceBrowser?: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO cookies (name, value, domain, host_only, path, expiration_date,
        secure, http_only, same_site, source_scheme, source_port, source_browser, created_at)
      VALUES (@name, @value, @domain, @hostOnly, @path, @expirationDate,
        @secure, @httpOnly, @sameSite, @sourceScheme, @sourcePort, @sourceBrowser, @createdAt)
    `);
    const result = stmt.run({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      hostOnly: cookie.hostOnly ? 1 : 0,
      path: cookie.path ?? "/",
      expirationDate: cookie.expirationDate ?? null,
      secure: cookie.secure ? 1 : 0,
      httpOnly: cookie.httpOnly ? 1 : 0,
      sameSite: cookie.sameSite ?? "unspecified",
      sourceScheme: cookie.sourceScheme ?? "unset",
      sourcePort: cookie.sourcePort ?? -1,
      sourceBrowser: cookie.sourceBrowser ?? null,
      createdAt: Date.now(),
    });
    return Number(result.lastInsertRowid);
  }

  delete(id: number): void {
    this.db.prepare("DELETE FROM cookies WHERE id = ?").run(id);
  }

  getByDomain(domain?: string): StoredCookie[] {
    if (domain) {
      return this.db
        .prepare("SELECT * FROM cookies WHERE domain = ? OR domain = ?")
        .all(domain, `.${domain}`) as StoredCookie[];
    }
    return this.db.prepare("SELECT * FROM cookies").all() as StoredCookie[];
  }

  clearByDomain(domain?: string): number {
    if (domain) {
      const result = this.db
        .prepare("DELETE FROM cookies WHERE domain = ? OR domain = ?")
        .run(domain, `.${domain}`);
      return result.changes;
    }
    return this.clearAll();
  }

  clearAll(): number {
    const result = this.db.prepare("DELETE FROM cookies").run();
    return result.changes;
  }

  addBatch(cookies: ImportedCookie[]): number {
    const stmt = this.db.prepare(`
      INSERT INTO cookies (name, value, domain, host_only, path, expiration_date,
        secure, http_only, same_site, source_scheme, source_port, created_at)
      VALUES (@name, @value, @domain, @hostOnly, @path, @expirationDate,
        @secure, @httpOnly, @sameSite, @sourceScheme, @sourcePort, @createdAt)
      ON CONFLICT(name, domain, path) DO UPDATE SET
        value = @value,
        expiration_date = @expirationDate,
        last_accessed = @createdAt
    `);

    let count = 0;
    const insertMany = this.db.transaction((items: ImportedCookie[]) => {
      const now = Date.now();
      for (const c of items) {
        stmt.run({
          name: c.name,
          value: c.value,
          domain: c.domain,
          hostOnly: c.hostOnly ? 1 : 0,
          path: c.path,
          expirationDate: c.expirationDate ?? null,
          secure: c.secure ? 1 : 0,
          httpOnly: c.httpOnly ? 1 : 0,
          sameSite: c.sameSite,
          sourceScheme: c.sourceScheme,
          sourcePort: c.sourcePort,
          createdAt: now,
        });
        count++;
      }
    });

    insertMany(cookies);
    return count;
  }
}
