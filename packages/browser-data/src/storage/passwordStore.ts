import type Database from "better-sqlite3";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ImportedPassword } from "../types.js";

const KEY_FILE = "browser-data.key";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export interface StoredPassword {
  id: number;
  origin_url: string;
  username: string;
  password: string;
  action_url: string;
  realm: string;
  date_created: number | null;
  date_last_used: number | null;
  date_password_changed: number | null;
  times_used: number;
}

export class PasswordStore {
  private masterKey: Buffer;

  constructor(
    private db: Database.Database,
    configDir: string,
  ) {
    this.masterKey = this.loadOrCreateKey(configDir);
  }

  private loadOrCreateKey(configDir: string): Buffer {
    const keyPath = path.join(configDir, KEY_FILE);
    if (fs.existsSync(keyPath)) {
      return fs.readFileSync(keyPath);
    }
    const key = crypto.randomBytes(KEY_LENGTH);
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    return key;
  }

  private hashUsername(username: string): Buffer {
    return Buffer.from(
      crypto.createHmac("sha256", this.masterKey).update(username).digest(),
    );
  }

  private encrypt(plaintext: string): Buffer {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.masterKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, encrypted, tag]);
  }

  private decrypt(blob: Buffer): string {
    const iv = blob.subarray(0, IV_LENGTH);
    const tag = blob.subarray(blob.length - TAG_LENGTH);
    const ciphertext = blob.subarray(IV_LENGTH, blob.length - TAG_LENGTH);
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.masterKey, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext) + decipher.final("utf8");
  }

  add(password: {
    url: string;
    username: string;
    password: string;
    actionUrl?: string;
    realm?: string;
    dateCreated?: number;
    dateLastUsed?: number;
    datePasswordChanged?: number;
    timesUsed?: number;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO passwords (origin_url, username_hash, username_encrypted, password_encrypted,
        action_url, realm, date_created, date_last_used, date_password_changed, times_used)
      VALUES (@originUrl, @usernameHash, @usernameEncrypted, @passwordEncrypted,
        @actionUrl, @realm, @dateCreated, @dateLastUsed, @datePasswordChanged, @timesUsed)
    `);
    const result = stmt.run({
      originUrl: password.url,
      usernameHash: this.hashUsername(password.username),
      usernameEncrypted: this.encrypt(password.username),
      passwordEncrypted: this.encrypt(password.password),
      actionUrl: password.actionUrl ?? "",
      realm: password.realm ?? "",
      dateCreated: password.dateCreated ?? Date.now(),
      dateLastUsed: password.dateLastUsed ?? null,
      datePasswordChanged: password.datePasswordChanged ?? null,
      timesUsed: password.timesUsed ?? 0,
    });
    return Number(result.lastInsertRowid);
  }

  update(
    id: number,
    partial: Partial<{
      username: string;
      password: string;
      actionUrl: string;
      realm: string;
    }>,
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };

    if (partial.username !== undefined) {
      sets.push("username_hash = @usernameHash");
      sets.push("username_encrypted = @usernameEncrypted");
      params['usernameHash'] = this.hashUsername(partial.username);
      params['usernameEncrypted'] = this.encrypt(partial.username);
    }
    if (partial.password !== undefined) {
      sets.push("password_encrypted = @passwordEncrypted");
      sets.push("date_password_changed = @datePasswordChanged");
      params['passwordEncrypted'] = this.encrypt(partial.password);
      params['datePasswordChanged'] = Date.now();
    }
    if (partial.actionUrl !== undefined) {
      sets.push("action_url = @actionUrl");
      params['actionUrl'] = partial.actionUrl;
    }
    if (partial.realm !== undefined) {
      sets.push("realm = @realm");
      params['realm'] = partial.realm;
    }

    if (sets.length === 0) return;

    this.db.prepare(`UPDATE passwords SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  delete(id: number): void {
    this.db.prepare("DELETE FROM passwords WHERE id = ?").run(id);
  }

  getAll(): StoredPassword[] {
    const rows = this.db.prepare("SELECT * FROM passwords").all() as Array<{
      id: number;
      origin_url: string;
      username_encrypted: Buffer;
      password_encrypted: Buffer;
      action_url: string;
      realm: string;
      date_created: number | null;
      date_last_used: number | null;
      date_password_changed: number | null;
      times_used: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      origin_url: row.origin_url,
      username: this.decrypt(row.username_encrypted),
      password: this.decrypt(row.password_encrypted),
      action_url: row.action_url,
      realm: row.realm,
      date_created: row.date_created,
      date_last_used: row.date_last_used,
      date_password_changed: row.date_password_changed,
      times_used: row.times_used,
    }));
  }

  getForSite(url: string): StoredPassword[] {
    const rows = this.db
      .prepare("SELECT * FROM passwords WHERE origin_url = ?")
      .all(url) as Array<{
      id: number;
      origin_url: string;
      username_encrypted: Buffer;
      password_encrypted: Buffer;
      action_url: string;
      realm: string;
      date_created: number | null;
      date_last_used: number | null;
      date_password_changed: number | null;
      times_used: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      origin_url: row.origin_url,
      username: this.decrypt(row.username_encrypted),
      password: this.decrypt(row.password_encrypted),
      action_url: row.action_url,
      realm: row.realm,
      date_created: row.date_created,
      date_last_used: row.date_last_used,
      date_password_changed: row.date_password_changed,
      times_used: row.times_used,
    }));
  }

  addBatch(passwords: ImportedPassword[]): number {
    const stmt = this.db.prepare(`
      INSERT INTO passwords (origin_url, username_hash, username_encrypted, password_encrypted,
        action_url, realm, date_created, date_last_used, date_password_changed, times_used)
      VALUES (@originUrl, @usernameHash, @usernameEncrypted, @passwordEncrypted,
        @actionUrl, @realm, @dateCreated, @dateLastUsed, @datePasswordChanged, @timesUsed)
      ON CONFLICT(origin_url, username_hash, action_url, realm) DO UPDATE SET
        password_encrypted = @passwordEncrypted,
        date_password_changed = @datePasswordChanged,
        times_used = COALESCE(@timesUsed, times_used)
    `);

    let count = 0;
    const insertMany = this.db.transaction((items: ImportedPassword[]) => {
      for (const pw of items) {
        stmt.run({
          originUrl: pw.url,
          usernameHash: this.hashUsername(pw.username),
          usernameEncrypted: this.encrypt(pw.username),
          passwordEncrypted: this.encrypt(pw.password),
          actionUrl: pw.actionUrl ?? "",
          realm: pw.realm ?? "",
          dateCreated: pw.dateCreated ?? Date.now(),
          dateLastUsed: pw.dateLastUsed ?? null,
          datePasswordChanged: pw.datePasswordChanged ?? null,
          timesUsed: pw.timesUsed ?? 0,
        });
        count++;
      }
    });

    insertMany(passwords);
    return count;
  }
}
