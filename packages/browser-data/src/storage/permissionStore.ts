import type Database from "better-sqlite3";
import type { ImportedPermission } from "../types.js";

export interface StoredPermission {
  id: number;
  origin: string;
  permission: string;
  setting: string;
  date_set: number | null;
}

export class PermissionStore {
  constructor(private db: Database.Database) {}

  set(origin: string, permission: string, setting: string): number {
    const stmt = this.db.prepare(`
      INSERT INTO permissions (origin, permission, setting, date_set)
      VALUES (@origin, @permission, @setting, @dateSet)
      ON CONFLICT(origin, permission) DO UPDATE SET
        setting = @setting,
        date_set = @dateSet
    `);
    const result = stmt.run({
      origin,
      permission,
      setting,
      dateSet: Date.now(),
    });
    return Number(result.lastInsertRowid);
  }

  get(origin?: string): StoredPermission[] {
    if (origin) {
      return this.db
        .prepare("SELECT * FROM permissions WHERE origin = ?")
        .all(origin) as StoredPermission[];
    }
    return this.db.prepare("SELECT * FROM permissions").all() as StoredPermission[];
  }

  delete(origin: string, permission: string): void {
    this.db
      .prepare("DELETE FROM permissions WHERE origin = ? AND permission = ?")
      .run(origin, permission);
  }

  addBatch(permissions: ImportedPermission[]): number {
    const stmt = this.db.prepare(`
      INSERT INTO permissions (origin, permission, setting, date_set)
      VALUES (@origin, @permission, @setting, @dateSet)
      ON CONFLICT(origin, permission) DO UPDATE SET
        setting = @setting,
        date_set = @dateSet
    `);

    let count = 0;
    const insertMany = this.db.transaction((items: ImportedPermission[]) => {
      const now = Date.now();
      for (const perm of items) {
        stmt.run({
          origin: perm.origin,
          permission: perm.permission,
          setting: perm.setting,
          dateSet: now,
        });
        count++;
      }
    });

    insertMany(permissions);
    return count;
  }
}
