import { DurableObjectBase, type DurableObjectContext } from "../../../workspace/packages/runtime/src/worker/durable-base.js";
import { BROWSER_DATA_SCHEMA } from "../../../packages/browser-data/src/storage/schema.js";
import type {
  ImportedAutofillEntry,
  ImportedBookmark,
  ImportedCookie,
  ImportedFavicon,
  ImportedHistoryEntry,
  ImportedPassword,
  ImportedPermission,
  ImportedSearchEngine,
  RecordHistoryVisitRequest,
  UpdateHistoryTitleRequest,
} from "../../../packages/browser-data/src/types.js";

const BATCH_SIZE = 1000;

export class BrowserDataDO extends DurableObjectBase {
  static override schemaVersion = 1;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.ensureReady();
  }

  protected createTables(): void {
    for (const stmt of this.schemaStatements(BROWSER_DATA_SCHEMA)) {
      const sql = stmt.trim();
      if (sql) this.sql.exec(sql);
    }
  }

  getBookmarks(folderPath = "/") {
    return this.sql.exec(`SELECT * FROM bookmarks WHERE folder_path = ? ORDER BY position`, folderPath).toArray();
  }

  getAllBookmarks() {
    return this.sql.exec(`SELECT * FROM bookmarks ORDER BY folder_path, position`).toArray();
  }

  addBookmark(bookmark: { title: string; url?: string; folderPath?: string; dateAdded?: number; tags?: string[] | string; keyword?: string; position?: number }): number {
    const result = this.sql.exec(
      `INSERT INTO bookmarks (title, url, folder_path, date_added, tags, keyword, position)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      bookmark.title,
      bookmark.url ?? null,
      bookmark.folderPath ?? "/",
      bookmark.dateAdded ?? Date.now(),
      Array.isArray(bookmark.tags) ? JSON.stringify(bookmark.tags) : bookmark.tags ?? null,
      bookmark.keyword ?? null,
      bookmark.position ?? 0,
    ).one() as { id: number };
    return result.id;
  }

  updateBookmark(id: number, partial: Record<string, unknown>): void {
    this.updateByMap("bookmarks", id, {
      title: "title",
      url: "url",
      folderPath: "folder_path",
      tags: "tags",
      keyword: "keyword",
      position: "position",
      faviconId: "favicon_id",
    }, partial, { date_modified: Date.now() });
  }

  deleteBookmark(id: number): void {
    this.sql.exec(`DELETE FROM bookmarks WHERE id = ?`, id);
  }

  moveBookmark(id: number, folderPath: string, position: number): void {
    this.sql.exec(`UPDATE bookmarks SET folder_path = ?, position = ?, date_modified = ? WHERE id = ?`, folderPath, position, Date.now(), id);
  }

  searchBookmarks(query: string) {
    return this.sql.exec(
      `SELECT * FROM bookmarks WHERE title LIKE ? OR url LIKE ? ORDER BY date_added DESC`,
      `%${query}%`,
      `%${query}%`,
    ).toArray();
  }

  getHistory(query: { search?: string; startTime?: number; endTime?: number; limit?: number; offset?: number }) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.search) {
      conditions.push(`id IN (SELECT rowid FROM history_fts WHERE history_fts MATCH ?)`);
      params.push(this.escapeFts5Query(query.search));
    }
    if (query.startTime !== undefined) {
      conditions.push(`last_visit >= ?`);
      params.push(query.startTime);
    }
    if (query.endTime !== undefined) {
      conditions.push(`last_visit <= ?`);
      params.push(query.endTime);
    }
    params.push(query.limit ?? 100, query.offset ?? 0);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.sql.exec(`SELECT * FROM history ${where} ORDER BY last_visit DESC LIMIT ? OFFSET ?`, ...params).toArray();
  }

  searchHistory(query: string, limit = 50) {
    return this.sql.exec(
      `SELECT h.* FROM history h
       JOIN history_fts fts ON h.id = fts.rowid
       WHERE history_fts MATCH ?
       ORDER BY h.last_visit DESC
       LIMIT ?`,
      this.escapeFts5Query(query),
      limit,
    ).toArray();
  }

  searchHistoryForAutocomplete(query: { query: string; limit?: number }) {
    const trimmed = query.query.trim();
    const limit = query.limit ?? 50;
    if (!trimmed) return this.getHistory({ limit });

    const byId = new Map<number, Record<string, unknown>>();
    const addRows = (rows: Record<string, unknown>[]) => {
      for (const row of rows) {
        const id = Number(row["id"]);
        if (Number.isFinite(id) && !byId.has(id)) byId.set(id, row);
      }
    };

    try {
      addRows(this.sql.exec(
        `SELECT h.* FROM history h
         JOIN history_fts fts ON h.id = fts.rowid
         WHERE history_fts MATCH ?
         ORDER BY h.last_visit DESC
         LIMIT ?`,
        this.escapeFts5Query(trimmed.split(/\s+/).map((token) => `${token}*`).join(" ")),
        limit,
      ).toArray() as Record<string, unknown>[]);
    } catch {
      // FTS tokenization can reject unusual user input; LIKE fallback below still applies.
    }

    const pattern = `%${this.escapeLikePattern(trimmed)}%`;
    addRows(this.sql.exec(
      `SELECT * FROM history
       WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
       ORDER BY last_visit DESC
       LIMIT ?`,
      pattern,
      pattern,
      limit,
    ).toArray() as Record<string, unknown>[]);

    return [...byId.values()]
      .sort((a, b) => Number(b["last_visit"] ?? 0) - Number(a["last_visit"] ?? 0))
      .slice(0, limit);
  }

  recordHistoryVisit(request: RecordHistoryVisitRequest): number {
    const visitTime = request.visitTime ?? Date.now();
    const title = request.title?.trim() || null;
    const typedCount = request.typed ? 1 : 0;
    const row = this.sql.exec(
      `INSERT INTO history (url, title, visit_count, typed_count, first_visit, last_visit)
       VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         title = CASE
           WHEN excluded.title IS NOT NULL AND length(excluded.title) > 0 THEN excluded.title
           ELSE history.title
         END,
         visit_count = history.visit_count + 1,
         typed_count = history.typed_count + excluded.typed_count,
         first_visit = CASE
           WHEN history.first_visit IS NULL THEN excluded.first_visit
           WHEN excluded.first_visit IS NULL THEN history.first_visit
           ELSE MIN(history.first_visit, excluded.first_visit)
         END,
         last_visit = MAX(history.last_visit, excluded.last_visit)
       RETURNING id`,
      request.url,
      title,
      typedCount,
      visitTime,
      visitTime,
    ).one() as { id: number };

    this.sql.exec(
      `INSERT INTO history_visits (history_id, visit_time, transition, from_visit_id)
       VALUES (?, ?, ?, NULL)`,
      row.id,
      visitTime,
      request.transition ?? "link",
    );
    return row.id;
  }

  updateHistoryTitle(request: UpdateHistoryTitleRequest): void {
    const title = request.title.trim();
    if (!title) return;
    const observedAt = request.observedAt ?? Date.now();
    this.sql.exec(
      `INSERT INTO history (url, title, visit_count, typed_count, first_visit, last_visit)
       VALUES (?, ?, 0, 0, NULL, ?)
       ON CONFLICT(url) DO UPDATE SET
         title = excluded.title`,
      request.url,
      title,
      observedAt,
    );
  }

  deleteHistoryEntry(id: number): void {
    this.sql.exec(`DELETE FROM history WHERE id = ?`, id);
  }

  deleteHistoryRange(start: number, end: number): number {
    this.sql.exec(`DELETE FROM history WHERE last_visit >= ? AND last_visit <= ?`, start, end);
    return this.changes();
  }

  clearAllHistory(): void {
    this.sql.exec(`DELETE FROM history_visits`);
    this.sql.exec(`DELETE FROM history`);
  }

  async getPasswords() {
    const rows = this.sql.exec(`SELECT * FROM passwords`).toArray();
    return Promise.all(rows.map((row) => this.passwordRow(row)));
  }

  async getPasswordForSite(url: string) {
    const prefix = `${this.escapeLikePattern(url.replace(/\/+$/, ""))}/%`;
    const rows = this.sql.exec(
      `SELECT * FROM passwords
       WHERE origin_url = ? OR origin_url LIKE ? ESCAPE '\\'
       ORDER BY COALESCE(date_last_used, date_created, 0) DESC, times_used DESC`,
      url,
      prefix,
    ).toArray();
    return Promise.all(rows.map((row) => this.passwordRow(row)));
  }

  async addPassword(password: ImportedPassword): Promise<number> {
    const encrypted = await this.encryptPasswordFields(password.username, password.password);
    const now = Date.now();
    const result = this.sql.exec(
      `INSERT INTO passwords (origin_url, username_hash, username_encrypted, password_encrypted,
        action_url, realm, date_created, date_last_used, date_password_changed, times_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(origin_url, username_hash, action_url, realm) DO UPDATE SET
         username_encrypted = excluded.username_encrypted,
         password_encrypted = excluded.password_encrypted,
         date_last_used = excluded.date_last_used,
         date_password_changed = excluded.date_password_changed,
         times_used = excluded.times_used
       RETURNING id`,
      password.url,
      encrypted.usernameHash,
      encrypted.usernameEncrypted,
      encrypted.passwordEncrypted,
      password.actionUrl ?? "",
      password.realm ?? "",
      password.dateCreated ?? now,
      password.dateLastUsed ?? null,
      password.datePasswordChanged ?? null,
      password.timesUsed ?? 0,
    ).one() as { id: number };
    return result.id;
  }

  async updatePassword(id: number, partial: Partial<ImportedPassword>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (partial.username !== undefined) {
      sets.push("username_hash = ?", "username_encrypted = ?");
      params.push(
        await this.hashUsername(partial.username),
        await this.encryptText(partial.username),
      );
    }
    if (partial.password !== undefined) {
      sets.push("password_encrypted = ?", "date_password_changed = ?");
      params.push(await this.encryptText(partial.password), Date.now());
    }
    if (partial.actionUrl !== undefined) {
      sets.push("action_url = ?");
      params.push(partial.actionUrl);
    }
    if (partial.realm !== undefined) {
      sets.push("realm = ?");
      params.push(partial.realm);
    }
    if (sets.length === 0) return;
    params.push(id);
    this.sql.exec(`UPDATE passwords SET ${sets.join(", ")} WHERE id = ?`, ...params);
  }

  deletePassword(id: number): void {
    this.sql.exec(`DELETE FROM passwords WHERE id = ?`, id);
  }

  getAutofillSuggestions(fieldName: string, prefix?: string) {
    const pattern = `${prefix ?? ""}%`;
    return this.sql.exec(
      `SELECT * FROM autofill WHERE field_name = ? AND value LIKE ? ORDER BY times_used DESC, date_last_used DESC LIMIT 20`,
      fieldName,
      pattern,
    ).toArray();
  }

  getSearchEngines() {
    return this.sql.exec(`SELECT * FROM search_engines ORDER BY is_default DESC, name`).toArray();
  }

  setDefaultEngine(id: number): void {
    this.sql.exec(`UPDATE search_engines SET is_default = 0`);
    this.sql.exec(`UPDATE search_engines SET is_default = 1 WHERE id = ?`, id);
  }

  getPermissions(origin?: string) {
    return origin
      ? this.sql.exec(`SELECT * FROM permissions WHERE origin = ?`, origin).toArray()
      : this.sql.exec(`SELECT * FROM permissions`).toArray();
  }

  setPermission(origin: string, permission: string, setting: string): void {
    this.sql.exec(
      `INSERT INTO permissions (origin, permission, setting, date_set)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(origin, permission) DO UPDATE SET setting = excluded.setting, date_set = excluded.date_set`,
      origin,
      permission,
      setting,
      Date.now(),
    );
  }

  getCookies(domain?: string) {
    return domain
      ? this.sql.exec(`SELECT * FROM cookies WHERE domain = ? OR domain = ? ORDER BY created_at DESC`, domain, `.${domain}`).toArray()
      : this.sql.exec(`SELECT * FROM cookies ORDER BY created_at DESC`).toArray();
  }

  deleteCookie(id: number): void {
    this.sql.exec(`DELETE FROM cookies WHERE id = ?`, id);
  }

  clearCookies(domain?: string): number {
    if (domain) {
      this.sql.exec(`DELETE FROM cookies WHERE domain = ? OR domain = ?`, domain, `.${domain}`);
      return this.changes();
    }
    this.sql.exec(`DELETE FROM cookies`);
    return this.changes();
  }

  async addBookmarksBatch(bookmarks: ImportedBookmark[]): Promise<number> {
    return this.runBatch(bookmarks.length, (i) => {
      const bm = bookmarks[i]!;
      this.addBookmark({
        title: bm.title,
        url: bm.url,
        folderPath: "/" + bm.folder.join("/"),
        dateAdded: bm.dateAdded,
        tags: bm.tags,
        keyword: bm.keyword,
        position: i,
      });
    });
  }

  async addHistoryBatch(entries: ImportedHistoryEntry[]): Promise<number> {
    return this.runBatch(entries.length, (i) => {
      const entry = entries[i]!;
      this.sql.exec(
        `INSERT INTO history (url, title, visit_count, typed_count, first_visit, last_visit)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           title = COALESCE(excluded.title, title),
           visit_count = visit_count + excluded.visit_count,
           typed_count = typed_count + excluded.typed_count,
           first_visit = MIN(COALESCE(first_visit, excluded.first_visit), COALESCE(excluded.first_visit, first_visit)),
           last_visit = MAX(last_visit, excluded.last_visit)`,
        entry.url,
        entry.title ?? null,
        entry.visitCount,
        entry.typedCount ?? 0,
        entry.firstVisitTime ?? entry.lastVisitTime,
        entry.lastVisitTime,
      );
    });
  }

  async addCookiesBatch(cookies: ImportedCookie[]): Promise<number> {
    const now = Date.now();
    return this.runBatch(cookies.length, (i) => {
      const cookie = cookies[i]!;
      this.sql.exec(
        `INSERT INTO cookies (name, value, domain, host_only, path, expiration_date, secure, http_only,
          same_site, source_scheme, source_port, created_at, last_accessed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name, domain, path) DO UPDATE SET
          value = excluded.value,
          expiration_date = excluded.expiration_date,
          secure = excluded.secure,
          http_only = excluded.http_only,
          same_site = excluded.same_site,
          source_scheme = excluded.source_scheme,
          source_port = excluded.source_port,
          last_accessed = excluded.last_accessed`,
        cookie.name,
        cookie.value,
        cookie.domain,
        cookie.hostOnly ? 1 : 0,
        cookie.path,
        cookie.expirationDate ?? null,
        cookie.secure ? 1 : 0,
        cookie.httpOnly ? 1 : 0,
        cookie.sameSite,
        cookie.sourceScheme,
        cookie.sourcePort,
        now,
        now,
      );
    });
  }

  async addPasswordsBatch(passwords: ImportedPassword[]): Promise<number> {
    if (passwords.length === 0) return 0;
    // Encryption is async (crypto.subtle); transactionSync is synchronous.
    // Encrypt all passwords up-front, then run the inserts inside the txn.
    type PreparedRow = {
      url: string;
      usernameHash: string;
      usernameEncrypted: string;
      passwordEncrypted: string;
      actionUrl: string;
      realm: string;
      dateCreated: number;
      dateLastUsed: number | null;
      datePasswordChanged: number | null;
      timesUsed: number;
    };
    const prepared: PreparedRow[] = [];
    for (const password of passwords) {
      const encrypted = await this.encryptPasswordFields(password.username, password.password);
      prepared.push({
        url: password.url,
        usernameHash: encrypted.usernameHash,
        usernameEncrypted: encrypted.usernameEncrypted,
        passwordEncrypted: encrypted.passwordEncrypted,
        actionUrl: password.actionUrl ?? "",
        realm: password.realm ?? "",
        dateCreated: password.dateCreated ?? Date.now(),
        dateLastUsed: password.dateLastUsed ?? null,
        datePasswordChanged: password.datePasswordChanged ?? null,
        timesUsed: password.timesUsed ?? 0,
      });
    }
    return this.runBatch(prepared.length, (i) => {
      const r = prepared[i]!;
      this.sql.exec(
        `INSERT INTO passwords (origin_url, username_hash, username_encrypted, password_encrypted,
          action_url, realm, date_created, date_last_used, date_password_changed, times_used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(origin_url, username_hash, action_url, realm) DO UPDATE SET
           username_encrypted = excluded.username_encrypted,
           password_encrypted = excluded.password_encrypted,
           date_last_used = excluded.date_last_used,
           date_password_changed = excluded.date_password_changed,
           times_used = excluded.times_used`,
        r.url,
        r.usernameHash,
        r.usernameEncrypted,
        r.passwordEncrypted,
        r.actionUrl,
        r.realm,
        r.dateCreated,
        r.dateLastUsed,
        r.datePasswordChanged,
        r.timesUsed,
      );
    });
  }

  async addAutofillBatch(entries: ImportedAutofillEntry[]): Promise<number> {
    return this.runBatch(entries.length, (i) => {
      const entry = entries[i]!;
      this.sql.exec(
        `INSERT INTO autofill (field_name, value, date_created, date_last_used, times_used)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(field_name, value) DO UPDATE SET
           times_used = times_used + excluded.times_used,
           date_last_used = excluded.date_last_used`,
        entry.fieldName,
        entry.value,
        entry.dateCreated ?? null,
        entry.dateLastUsed ?? null,
        entry.timesUsed,
      );
    });
  }

  async addSearchEnginesBatch(engines: ImportedSearchEngine[]): Promise<number> {
    return this.runBatch(engines.length, (i) => {
      const engine = engines[i]!;
      this.sql.exec(
        `INSERT INTO search_engines (name, keyword, search_url, suggest_url, favicon_url, is_default)
         VALUES (?, ?, ?, ?, ?, ?)`,
        engine.name,
        engine.keyword ?? null,
        engine.searchUrl,
        engine.suggestUrl ?? null,
        engine.faviconUrl ?? null,
        engine.isDefault ? 1 : 0,
      );
    });
  }

  async addPermissionsBatch(permissions: ImportedPermission[]): Promise<number> {
    return this.runBatch(permissions.length, (i) => {
      const p = permissions[i]!;
      this.setPermission(p.origin, p.permission, p.setting);
    });
  }

  async addFaviconsBatch(favicons: ImportedFavicon[]): Promise<number> {
    return this.runBatch(favicons.length, (i) => {
      const favicon = favicons[i]!;
      this.sql.exec(
        `INSERT OR REPLACE INTO favicons (url, data, mime_type, last_updated) VALUES (?, ?, ?, ?)`,
        favicon.url,
        favicon.data,
        favicon.mimeType,
        Date.now(),
      );
    });
  }

  addNeverSave(origin: string): void {
    this.sql.exec(
      `INSERT INTO password_never_save (origin, date_added) VALUES (?, ?)
       ON CONFLICT(origin) DO NOTHING`,
      origin,
      Date.now(),
    );
  }

  isNeverSave(origin: string): boolean {
    const row = this.sql.exec(`SELECT 1 AS present FROM password_never_save WHERE origin = ?`, origin)
      .toArray()[0] as { present: number } | undefined;
    return row !== undefined;
  }

  updateLastUsed(id: number): void {
    this.sql.exec(
      `UPDATE passwords SET date_last_used = ?, times_used = times_used + 1 WHERE id = ?`,
      Date.now(),
      id,
    );
  }

  logImport(entry: Record<string, unknown>): void {
    this.sql.exec(
      `INSERT INTO import_log (browser, profile_path, data_type, items_imported, items_skipped, imported_at, warnings)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      entry["browser"],
      entry["profilePath"],
      entry["dataType"],
      entry["itemsImported"],
      entry["itemsSkipped"],
      Date.now(),
      JSON.stringify(entry["warnings"] ?? []),
    );
  }

  getImportHistory() {
    return this.sql.exec(`SELECT * FROM import_log ORDER BY imported_at DESC`).toArray();
  }

  private changes(): number {
    const row = this.sql.exec(`SELECT changes() AS changes`).one();
    return Number(row["changes"] ?? 0);
  }

  /**
   * Run an indexed batch of synchronous writes with per-chunk transactions
   * and yields between chunks. Each BATCH_SIZE chunk runs inside
   * `ctx.storage.transactionSync`, which workerd rolls back automatically
   * on a thrown exception — so a crash mid-import loses at most one chunk
   * and previously committed chunks are durable. The yield between chunks
   * releases the event loop so reads on this single-threaded DO can
   * interleave with a long import. `apply` MUST be synchronous; any async
   * preparation (e.g., crypto for passwords) belongs before this call.
   */
  private async runBatch(total: number, apply: (index: number) => void): Promise<number> {
    if (total === 0) return 0;
    let processed = 0;
    for (let start = 0; start < total; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE, total);
      this.ctx.storage.transactionSync(() => {
        for (let i = start; i < end; i++) apply(i);
      });
      processed = end;
      if (end < total) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    return processed;
  }

  private updateByMap(table: string, id: number, map: Record<string, string>, partial: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of Object.entries(map)) {
      if (partial[key] !== undefined) {
        sets.push(`${column} = ?`);
        params.push(partial[key]);
      }
    }
    for (const [column, value] of Object.entries(extra)) {
      sets.push(`${column} = ?`);
      params.push(value);
    }
    if (sets.length === 0) return;
    params.push(id);
    this.sql.exec(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`, ...params);
  }

  private async passwordRow(row: Record<string, unknown>) {
    return {
      id: row["id"],
      origin_url: row["origin_url"],
      username: await this.decryptText(String(row["username_encrypted"] ?? "")),
      password: await this.decryptText(String(row["password_encrypted"] ?? "")),
      action_url: row["action_url"],
      realm: row["realm"],
      date_created: row["date_created"],
      date_last_used: row["date_last_used"],
      date_password_changed: row["date_password_changed"],
      times_used: row["times_used"],
    };
  }

  private async encryptPasswordFields(username: string, password: string) {
    return {
      usernameHash: await this.hashUsername(username),
      usernameEncrypted: await this.encryptText(username),
      passwordEncrypted: await this.encryptText(password),
    };
  }

  private async hashUsername(username: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      this.masterKeyBytes(),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username));
    return this.bytesToBase64(new Uint8Array(signature));
  }

  private async encryptText(plaintext: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
    const key = await this.aesKey();
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext),
    );
    const packed = new Uint8Array(iv.length + ciphertext.byteLength);
    packed.set(iv, 0);
    packed.set(new Uint8Array(ciphertext), iv.length);
    return this.bytesToBase64(packed);
  }

  private async decryptText(encoded: string): Promise<string> {
    const packed = this.base64ToBytes(encoded);
    const iv = packed.slice(0, 12);
    const ciphertext = packed.slice(12);
    const key = await this.aesKey();
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  }

  private async aesKey(): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      "raw",
      this.masterKeyBytes(),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  }

  private masterKeyBytes(): Uint8Array<ArrayBuffer> {
    const existing = this.getStateValue("browser_data_master_key");
    if (existing) return this.base64ToBytes(existing);
    const key = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(32)));
    this.setStateValue("browser_data_master_key", this.bytesToBase64(key));
    return key;
  }

  private bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  private base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
    const binary = atob(encoded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  private escapeFts5Query(query: string): string {
    return query
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map((token) => {
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

  private escapeLikePattern(pattern: string): string {
    return pattern.replace(/[\\%_]/g, (char) => `\\${char}`);
  }

  private schemaStatements(schema: string): string[] {
    const statements: string[] = [];
    let buffer: string[] = [];
    let inTrigger = false;

    for (const line of schema.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^CREATE TRIGGER\b/i.test(trimmed)) inTrigger = true;
      buffer.push(line);

      if (inTrigger) {
        if (/^END;$/i.test(trimmed)) {
          statements.push(buffer.join("\n"));
          buffer = [];
          inTrigger = false;
        }
      } else if (trimmed.endsWith(";")) {
        statements.push(buffer.join("\n"));
        buffer = [];
      }
    }

    if (buffer.length > 0) statements.push(buffer.join("\n"));
    return statements;
  }
}
