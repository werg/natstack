import type Database from "better-sqlite3";
import type { ImportedAutofillEntry } from "../types.js";

export interface StoredAutofill {
  id: number;
  field_name: string;
  value: string;
  date_created: number | null;
  date_last_used: number | null;
  times_used: number;
}

export class AutofillStore {
  constructor(private db: Database.Database) {}

  add(entry: {
    fieldName: string;
    value: string;
    dateCreated?: number;
    dateLastUsed?: number;
    timesUsed?: number;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO autofill (field_name, value, date_created, date_last_used, times_used)
      VALUES (@fieldName, @value, @dateCreated, @dateLastUsed, @timesUsed)
      ON CONFLICT(field_name, value) DO UPDATE SET
        times_used = times_used + 1,
        date_last_used = @dateLastUsed
    `);
    const result = stmt.run({
      fieldName: entry.fieldName,
      value: entry.value,
      dateCreated: entry.dateCreated ?? Date.now(),
      dateLastUsed: entry.dateLastUsed ?? null,
      timesUsed: entry.timesUsed ?? 1,
    });
    return Number(result.lastInsertRowid);
  }

  getSuggestions(fieldName: string, prefix?: string): StoredAutofill[] {
    if (prefix) {
      return this.db
        .prepare(
          "SELECT * FROM autofill WHERE field_name = @fieldName AND value LIKE @prefix ORDER BY times_used DESC",
        )
        .all({ fieldName, prefix: `${prefix}%` }) as StoredAutofill[];
    }
    return this.db
      .prepare(
        "SELECT * FROM autofill WHERE field_name = @fieldName ORDER BY times_used DESC",
      )
      .all({ fieldName }) as StoredAutofill[];
  }

  addBatch(entries: ImportedAutofillEntry[]): number {
    const stmt = this.db.prepare(`
      INSERT INTO autofill (field_name, value, date_created, date_last_used, times_used)
      VALUES (@fieldName, @value, @dateCreated, @dateLastUsed, @timesUsed)
      ON CONFLICT(field_name, value) DO UPDATE SET
        times_used = times_used + @timesUsed,
        date_last_used = MAX(COALESCE(date_last_used, 0), COALESCE(@dateLastUsed, 0))
    `);

    let count = 0;
    const insertMany = this.db.transaction((items: ImportedAutofillEntry[]) => {
      for (const entry of items) {
        stmt.run({
          fieldName: entry.fieldName,
          value: entry.value,
          dateCreated: entry.dateCreated ?? null,
          dateLastUsed: entry.dateLastUsed ?? null,
          timesUsed: entry.timesUsed,
        });
        count++;
      }
    });

    insertMany(entries);
    return count;
  }
}
