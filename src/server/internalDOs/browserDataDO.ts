import { DurableObjectBase, rpc, type DurableObjectContext } from "@natstack/durable";
import type { AuthenticatedCaller } from "@natstack/rpc";
import { BROWSER_DATA_SCHEMA } from "@natstack/browser-data";
import type {
  ImportedAutofillEntry,
  ImportedBookmark,
  ImportedCookie,
  ImportedFavicon,
  ImportedHistoryEntry,
  ImportedHistoryVisit,
  ImportBatchMeta,
  ImportHistoryBatchMeta,
  ImportedPassword,
  ImportedPermission,
  ImportedSearchEngine,
  RecordHistoryVisitRequest,
  UpdateHistoryTitleRequest,
} from "@natstack/browser-data";
import { assertPresent } from "../../lintHelpers";

const BATCH_SIZE = 1000;

type HistoryVisitSource = "natstack" | "import";

interface HistoryVisitWrite {
  visitTime: number;
  transition?: string;
  typed?: boolean;
  source: HistoryVisitSource;
  sourceBrowser?: string;
  sourceProfilePath?: string;
  panelId?: string;
  title?: string;
}

/**
 * Direct callers permitted at BrowserDataDO (Layer A). Shell + shell-side server
 * services, PLUS the `@workspace-extensions/browser-data` extension — the
 * designated mediator panel/agent access goes through (it gates its own callers
 * to shell and runs in the server-managed extension host, so its
 * server-authenticated `callerId` is trustworthy). Every OTHER extension and
 * every other caller kind is refused (this DO holds user credentials). Exported
 * so the policy is unit-testable without the FTS5 schema the DO itself needs.
 */
export function isBrowserDataDirectCaller(caller: AuthenticatedCaller | null): boolean {
  const kind = caller?.callerKind;
  if (kind === "server" || kind === "shell") return true;
  return kind === "extension" && caller?.callerId === "@workspace-extensions/browser-data";
}

export class BrowserDataDO extends DurableObjectBase {
  static override schemaVersion = 4;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.ensureReady();
  }

  /**
   * Receiver-side authorization (Layer A). BrowserDataDO holds user
   * credentials/passwords/cookies/history. Direct callers are the Electron shell
   * and shell-side server services, plus the `@workspace-extensions/browser-data`
   * extension — the designated mediator that panel/agent access goes through. That
   * extension gates its OWN callers to shell and runs in the server-managed
   * extension host (so its server-authenticated `callerId` is trustworthy), hence
   * it is whitelisted by id. Refuse every other caller kind — and every OTHER
   * extension — so the open relay cannot read user secrets by addressing the DO
   * directly. Events are owner-scoped push notifications — accept them.
   */
  protected override assertInboundAllowed(
    caller: AuthenticatedCaller | null,
    kind: "call" | "event"
  ): void {
    if (kind === "event") return;
    if (!isBrowserDataDirectCaller(caller)) {
      throw new Error(
        `browser-data: BrowserDataDO is shell/server-only (holds user credentials); refusing caller kind ${caller?.callerKind ?? "unknown"}`
      );
    }
  }

  protected createTables(): void {
    for (const stmt of this.schemaStatements(BROWSER_DATA_SCHEMA)) {
      const sql = stmt.trim();
      if (sql) this.sql.exec(sql);
    }
  }

  protected override migrate(fromVersion: number, _toVersion: number): void {
    if (fromVersion < 2) {
      this.sql.exec(`DROP TRIGGER IF EXISTS history_ai`);
      this.sql.exec(`DROP TRIGGER IF EXISTS history_ad`);
      this.sql.exec(`DROP TRIGGER IF EXISTS history_au`);
      this.sql.exec(`DROP TABLE IF EXISTS history_fts`);
      this.sql.exec(`DROP TABLE IF EXISTS history_visits`);
      this.sql.exec(`DROP TABLE IF EXISTS history`);
    }
    if (fromVersion < 3) {
      this.sql.exec(`DROP TABLE IF EXISTS bookmarks`);
      this.sql.exec(`DROP TABLE IF EXISTS autofill`);
      this.sql.exec(`DROP TABLE IF EXISTS search_engines`);
    }
    if (fromVersion < 4) {
      // Pre-release: no compatibility layer. Replace the flat import_log with the
      // import_runs/import_run_summaries model and recreate the credential/metadata
      // tables that gained source-provenance columns.
      this.sql.exec(`DROP TABLE IF EXISTS import_log`);
      this.sql.exec(`DROP TABLE IF EXISTS passwords`);
      this.sql.exec(`DROP TABLE IF EXISTS autofill`);
      this.sql.exec(`DROP TABLE IF EXISTS permissions`);
      this.sql.exec(`DROP TABLE IF EXISTS favicons`);
    }
  }

  @rpc
  getBookmarks(folderPath = "/") {
    return this.sql
      .exec(`SELECT * FROM bookmarks WHERE folder_path = ? ORDER BY position`, folderPath)
      .toArray();
  }

  @rpc
  getAllBookmarks() {
    return this.sql.exec(`SELECT * FROM bookmarks ORDER BY folder_path, position`).toArray();
  }

  @rpc
  addBookmark(bookmark: {
    title: string;
    url?: string;
    folderPath?: string;
    dateAdded?: number;
    tags?: string[] | string;
    keyword?: string;
    position?: number;
  }): number {
    const result = this.sql
      .exec(
        `INSERT INTO bookmarks (title, url, folder_path, date_added, tags, keyword, position)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        bookmark.title,
        bookmark.url ?? null,
        bookmark.folderPath ?? "/",
        bookmark.dateAdded ?? Date.now(),
        Array.isArray(bookmark.tags) ? JSON.stringify(bookmark.tags) : (bookmark.tags ?? null),
        bookmark.keyword ?? null,
        bookmark.position ?? 0
      )
      .one() as { id: number };
    return result.id;
  }

  @rpc
  updateBookmark(id: number, partial: Record<string, unknown>): void {
    this.updateByMap(
      "bookmarks",
      id,
      {
        title: "title",
        url: "url",
        folderPath: "folder_path",
        tags: "tags",
        keyword: "keyword",
        position: "position",
        faviconId: "favicon_id",
      },
      partial,
      { date_modified: Date.now() }
    );
  }

  @rpc
  deleteBookmark(id: number): void {
    this.sql.exec(`DELETE FROM bookmarks WHERE id = ?`, id);
  }

  @rpc
  moveBookmark(id: number, folderPath: string, position: number): void {
    this.sql.exec(
      `UPDATE bookmarks SET folder_path = ?, position = ?, date_modified = ? WHERE id = ?`,
      folderPath,
      position,
      Date.now(),
      id
    );
  }

  @rpc
  searchBookmarks(query: string) {
    return this.sql
      .exec(
        `SELECT * FROM bookmarks WHERE title LIKE ? OR url LIKE ? ORDER BY date_added DESC`,
        `%${query}%`,
        `%${query}%`
      )
      .toArray();
  }

  @rpc
  getHistory(query: {
    search?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
    offset?: number;
  }) {
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
    return this.sql
      .exec(`SELECT * FROM history ${where} ORDER BY last_visit DESC LIMIT ? OFFSET ?`, ...params)
      .toArray();
  }

  @rpc
  searchHistory(query: string, limit = 50) {
    return this.sql
      .exec(
        `SELECT h.* FROM history h
       JOIN history_fts fts ON h.id = fts.rowid
       WHERE history_fts MATCH ?
       ORDER BY h.last_visit DESC
       LIMIT ?`,
        this.escapeFts5Query(query),
        limit
      )
      .toArray();
  }

  @rpc
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
      addRows(
        this.sql
          .exec(
            `SELECT h.* FROM history h
         JOIN history_fts fts ON h.id = fts.rowid
         WHERE history_fts MATCH ?
         ORDER BY h.typed_count DESC, h.visit_count DESC, h.last_visit DESC
         LIMIT ?`,
            this.escapeFts5Query(
              trimmed
                .split(/\s+/)
                .map((token) => `${token}*`)
                .join(" ")
            ),
            limit
          )
          .toArray() as Record<string, unknown>[]
      );
    } catch {
      // FTS tokenization can reject unusual user input; LIKE fallback below still applies.
    }

    const pattern = `%${this.escapeLikePattern(trimmed)}%`;
    addRows(
      this.sql
        .exec(
          `SELECT * FROM history
       WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
       ORDER BY typed_count DESC, visit_count DESC, last_visit DESC
       LIMIT ?`,
          pattern,
          pattern,
          limit
        )
        .toArray() as Record<string, unknown>[]
    );

    return [...byId.values()]
      .sort(
        (a, b) =>
          this.historyAutocompleteScore(b, trimmed) - this.historyAutocompleteScore(a, trimmed)
      )
      .slice(0, limit);
  }

  @rpc
  recordHistoryVisit(request: RecordHistoryVisitRequest): number {
    const visitTime = request.visitTime ?? Date.now();
    const historyId = this.ensureHistoryRow(request.url, request.title, visitTime);
    this.insertHistoryVisit(historyId, {
      visitTime,
      transition: request.transition ?? "link",
      typed: Boolean(request.typed),
      source: request.source ?? "natstack",
      panelId: request.panelId,
      title: request.title,
    });
    this.recomputeHistorySummary(historyId);
    return historyId;
  }

  @rpc
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
      observedAt
    );
  }

  @rpc
  deleteHistoryEntry(id: number): void {
    this.sql.exec(`DELETE FROM history WHERE id = ?`, id);
  }

  @rpc
  deleteHistoryRange(start: number, end: number): number {
    let affectedCount = 0;
    this.ctx.storage.transactionSync(() => {
      const affectedIds = this.sql
        .exec(
          `SELECT DISTINCT history_id AS id
           FROM history_visits
           WHERE visit_time >= ? AND visit_time <= ?`,
          start,
          end
        )
        .toArray()
        .map((row) => Number(row["id"]))
        .filter((id) => Number.isFinite(id));

      if (affectedIds.length === 0) return;
      affectedCount = affectedIds.length;

      this.sql.exec(
        `DELETE FROM history_visits WHERE visit_time >= ? AND visit_time <= ?`,
        start,
        end
      );

      for (const historyId of affectedIds) {
        const remaining = this.sql
          .exec(`SELECT COUNT(*) AS count FROM history_visits WHERE history_id = ?`, historyId)
          .one();
        if (Number(remaining["count"] ?? 0) > 0) {
          this.recomputeHistorySummary(historyId);
        } else {
          this.sql.exec(`DELETE FROM history WHERE id = ?`, historyId);
        }
      }
    });
    return affectedCount;
  }

  @rpc
  clearAllHistory(): void {
    this.sql.exec(`DELETE FROM history_visits`);
    this.sql.exec(`DELETE FROM history`);
  }

  @rpc
  async getPasswords() {
    const rows = this.sql.exec(`SELECT * FROM passwords`).toArray();
    return Promise.all(rows.map((row) => this.passwordRow(row)));
  }

  @rpc
  async getPasswordForSite(url: string) {
    const prefix = `${this.escapeLikePattern(url.replace(/\/+$/, ""))}/%`;
    const rows = this.sql
      .exec(
        `SELECT * FROM passwords
       WHERE origin_url = ? OR origin_url LIKE ? ESCAPE '\\'
       ORDER BY COALESCE(date_last_used, date_created, 0) DESC, times_used DESC`,
        url,
        prefix
      )
      .toArray();
    return Promise.all(rows.map((row) => this.passwordRow(row)));
  }

  @rpc
  async addPassword(password: ImportedPassword): Promise<number> {
    const encrypted = await this.encryptPasswordFields(password.username, password.password);
    const now = Date.now();
    const result = this.sql
      .exec(
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
        password.timesUsed ?? 0
      )
      .one() as { id: number };
    return result.id;
  }

  @rpc
  async updatePassword(id: number, partial: Partial<ImportedPassword>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (partial.username !== undefined) {
      sets.push("username_hash = ?", "username_encrypted = ?");
      params.push(
        await this.hashUsername(partial.username),
        await this.encryptText(partial.username)
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

  @rpc
  deletePassword(id: number): void {
    this.sql.exec(`DELETE FROM passwords WHERE id = ?`, id);
  }

  @rpc
  getAutofillSuggestions(fieldName: string, prefix?: string) {
    const pattern = `${prefix ?? ""}%`;
    return this.sql
      .exec(
        `SELECT * FROM autofill WHERE field_name = ? AND value LIKE ? ORDER BY times_used DESC, date_last_used DESC LIMIT 20`,
        fieldName,
        pattern
      )
      .toArray();
  }

  @rpc
  getSearchEngines() {
    return this.sql.exec(`SELECT * FROM search_engines ORDER BY is_default DESC, name`).toArray();
  }

  @rpc
  setDefaultEngine(id: number): void {
    this.sql.exec(`UPDATE search_engines SET is_default = 0`);
    this.sql.exec(`UPDATE search_engines SET is_default = 1 WHERE id = ?`, id);
  }

  @rpc
  getPermissions(origin?: string) {
    return origin
      ? this.sql.exec(`SELECT * FROM permissions WHERE origin = ?`, origin).toArray()
      : this.sql.exec(`SELECT * FROM permissions`).toArray();
  }

  @rpc
  setPermission(origin: string, permission: string, setting: string): void {
    this.sql.exec(
      `INSERT INTO permissions (origin, permission, setting, date_set)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(origin, permission) DO UPDATE SET
         setting = excluded.setting,
         date_set = excluded.date_set
       WHERE permissions.setting IS NOT excluded.setting`,
      origin,
      permission,
      setting,
      Date.now()
    );
  }

  @rpc
  getCookies(domain?: string) {
    return domain
      ? this.sql
          .exec(
            `SELECT * FROM cookies WHERE domain = ? OR domain = ? ORDER BY created_at DESC`,
            domain,
            `.${domain}`
          )
          .toArray()
      : this.sql.exec(`SELECT * FROM cookies ORDER BY created_at DESC`).toArray();
  }

  @rpc
  deleteCookie(id: number): void {
    this.sql.exec(`DELETE FROM cookies WHERE id = ?`, id);
  }

  @rpc
  clearCookies(domain?: string): number {
    if (domain) {
      this.sql.exec(`DELETE FROM cookies WHERE domain = ? OR domain = ?`, domain, `.${domain}`);
      return this.changes();
    }
    this.sql.exec(`DELETE FROM cookies`);
    return this.changes();
  }

  @rpc
  async addBookmarksBatch(
    bookmarks: ImportedBookmark[],
    meta: ImportBatchMeta = {}
  ): Promise<number> {
    return this.runBatch(bookmarks.length, (i) => {
      const bm = assertPresent(bookmarks[i]);
      const folderPath = "/" + bm.folder.join("/");
      const importKey = this.importKey(
        "bookmark",
        meta,
        bm.sourceId ? ["id", bm.sourceId] : ["url-folder", bm.url, folderPath]
      );
      this.sql.exec(
        `INSERT INTO bookmarks (
           title, url, folder_path, date_added, date_modified, source_browser,
           source_profile_path, import_key, tags, keyword, position
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(import_key) DO UPDATE SET
           title = excluded.title,
           url = excluded.url,
           folder_path = excluded.folder_path,
           date_added = CASE
             WHEN excluded.date_added > 0 AND (bookmarks.date_added <= 0 OR excluded.date_added < bookmarks.date_added)
               THEN excluded.date_added
             ELSE bookmarks.date_added
           END,
           date_modified = excluded.date_modified,
           source_browser = excluded.source_browser,
           source_profile_path = excluded.source_profile_path,
           tags = excluded.tags,
           keyword = excluded.keyword,
           position = excluded.position`,
        bm.title,
        bm.url,
        folderPath,
        bm.dateAdded,
        bm.dateModified ?? null,
        meta.browser ?? null,
        meta.profilePath ?? "",
        importKey,
        bm.tags ? JSON.stringify(bm.tags) : null,
        bm.keyword ?? null,
        i
      );
    });
  }

  @rpc
  async addHistoryBatch(
    entries: ImportedHistoryEntry[],
    meta: ImportHistoryBatchMeta = {}
  ): Promise<number> {
    return this.runBatch(entries.length, (i) => {
      const entry = assertPresent(entries[i]);
      const historyId = this.ensureHistoryRow(entry.url, entry.title, entry.lastVisitTime);
      const visits = this.importedVisitsForEntry(entry);
      for (const visit of visits) {
        this.insertHistoryVisit(historyId, {
          visitTime: visit.visitTime,
          transition: visit.transition ?? entry.transition ?? "link",
          typed: Boolean(visit.typed),
          source: "import",
          sourceBrowser: meta.browser,
          sourceProfilePath: meta.profilePath,
          title: entry.title,
        });
      }
      this.recomputeHistorySummary(historyId);
    });
  }

  @rpc
  async addCookiesBatch(cookies: ImportedCookie[], meta: ImportBatchMeta = {}): Promise<number> {
    const now = Date.now();
    const sourceBrowser = meta.browser ?? null;
    return this.runBatch(cookies.length, (i) => {
      const cookie = assertPresent(cookies[i]);
      this.sql.exec(
        `INSERT INTO cookies (name, value, domain, host_only, path, expiration_date, secure, http_only,
          same_site, source_scheme, source_port, source_browser, created_at, last_accessed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name, domain, path) DO UPDATE SET
          value = excluded.value,
          expiration_date = excluded.expiration_date,
          secure = excluded.secure,
          http_only = excluded.http_only,
          same_site = excluded.same_site,
          source_scheme = excluded.source_scheme,
          source_port = excluded.source_port,
          source_browser = excluded.source_browser,
          last_accessed = excluded.last_accessed
         WHERE cookies.value IS NOT excluded.value
            OR cookies.expiration_date IS NOT excluded.expiration_date
            OR cookies.secure IS NOT excluded.secure
            OR cookies.http_only IS NOT excluded.http_only
            OR cookies.same_site IS NOT excluded.same_site
            OR cookies.source_scheme IS NOT excluded.source_scheme
            OR cookies.source_port IS NOT excluded.source_port`,
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
        sourceBrowser,
        now,
        now
      );
    });
  }

  @rpc
  async addPasswordsBatch(
    passwords: ImportedPassword[],
    meta: ImportBatchMeta = {}
  ): Promise<number> {
    if (passwords.length === 0) return 0;
    const sourceBrowser = meta.browser ?? null;
    const sourceProfilePath = meta.profilePath ?? "";
    // Encryption is async (crypto.subtle); transactionSync is synchronous.
    // Encrypt all passwords up-front, then run the inserts inside the txn.
    type PreparedSecretRow = {
      kind: "secret";
      url: string;
      usernameHash: string;
      usernameEncrypted: string;
      passwordEncrypted: string;
      actionUrl: string;
      realm: string;
      dateCreated: number | null;
      dateLastUsed: number | null;
      datePasswordChanged: number | null;
      timesUsed: number;
    };
    type PreparedMetadataRow = {
      kind: "metadata";
      url: string;
      usernameHash: string;
      actionUrl: string;
      realm: string;
      dateCreated: number | null;
      dateLastUsed: number | null;
      datePasswordChanged: number | null;
      timesUsed: number;
    };
    type PreparedRow = PreparedSecretRow | PreparedMetadataRow;
    const prepared: PreparedRow[] = [];
    for (const password of passwords) {
      const url = password.url;
      const usernameHash = await this.hashUsername(password.username);
      const actionUrl = password.actionUrl ?? "";
      const realm = password.realm ?? "";
      const dateCreated = password.dateCreated ?? null;
      const dateLastUsed = password.dateLastUsed ?? null;
      const datePasswordChanged = password.datePasswordChanged ?? null;
      const timesUsed = password.timesUsed ?? 0;
      const existing = this.sql
        .exec(
          `SELECT password_encrypted FROM passwords
           WHERE origin_url = ? AND username_hash = ? AND action_url = ? AND realm = ?`,
          url,
          usernameHash,
          actionUrl,
          realm
        )
        .toArray()[0] as Record<string, unknown> | undefined;

      let sameSecret = false;
      if (existing) {
        try {
          sameSecret =
            (await this.decryptText(String(existing["password_encrypted"] ?? ""))) ===
            password.password;
        } catch {
          sameSecret = false;
        }
      }

      if (sameSecret) {
        prepared.push({
          kind: "metadata",
          url,
          usernameHash,
          actionUrl,
          realm,
          dateCreated,
          dateLastUsed,
          datePasswordChanged,
          timesUsed,
        });
        continue;
      }

      prepared.push({
        kind: "secret",
        url: password.url,
        usernameHash,
        usernameEncrypted: await this.encryptText(password.username),
        passwordEncrypted: await this.encryptText(password.password),
        actionUrl,
        realm,
        dateCreated,
        dateLastUsed,
        datePasswordChanged,
        timesUsed,
      });
    }
    return this.runBatch(prepared.length, (i) => {
      const r = assertPresent(prepared[i]);
      if (r.kind === "metadata") {
        this.sql.exec(
          `UPDATE passwords SET
             date_created = CASE
               WHEN passwords.date_created IS NULL THEN ?
               WHEN ? IS NULL THEN passwords.date_created
               ELSE MIN(passwords.date_created, ?)
             END,
             date_last_used = ?,
             date_password_changed = ?,
             times_used = ?
           WHERE origin_url = ? AND username_hash = ? AND action_url = ? AND realm = ?
             AND (
               date_created IS NOT ?
               OR date_last_used IS NOT ?
               OR date_password_changed IS NOT ?
               OR times_used IS NOT ?
             )`,
          r.dateCreated,
          r.dateCreated,
          r.dateCreated,
          r.dateLastUsed,
          r.datePasswordChanged,
          r.timesUsed,
          r.url,
          r.usernameHash,
          r.actionUrl,
          r.realm,
          r.dateCreated,
          r.dateLastUsed,
          r.datePasswordChanged,
          r.timesUsed
        );
        return;
      }
      this.sql.exec(
        `INSERT INTO passwords (origin_url, username_hash, username_encrypted, password_encrypted,
          action_url, realm, date_created, date_last_used, date_password_changed, times_used,
          source_browser, source_profile_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(origin_url, username_hash, action_url, realm) DO UPDATE SET
           username_encrypted = excluded.username_encrypted,
           password_encrypted = excluded.password_encrypted,
           date_last_used = excluded.date_last_used,
           date_password_changed = excluded.date_password_changed,
           times_used = excluded.times_used,
           source_browser = excluded.source_browser,
           source_profile_path = excluded.source_profile_path`,
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
        sourceBrowser,
        sourceProfilePath
      );
    });
  }

  @rpc
  async addAutofillBatch(
    entries: ImportedAutofillEntry[],
    meta: ImportBatchMeta = {}
  ): Promise<number> {
    const sourceBrowser = meta.browser ?? null;
    const sourceProfilePath = meta.profilePath ?? "";
    return this.runBatch(entries.length, (i) => {
      const entry = assertPresent(entries[i]);
      this.sql.exec(
        `INSERT INTO autofill (field_name, value, date_created, date_last_used, times_used,
           source_browser, source_profile_path)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(field_name, value) DO UPDATE SET
           times_used = MAX(autofill.times_used, excluded.times_used),
           source_browser = excluded.source_browser,
           source_profile_path = excluded.source_profile_path,
           date_created = CASE
             WHEN autofill.date_created IS NULL THEN excluded.date_created
             WHEN excluded.date_created IS NULL THEN autofill.date_created
             ELSE MIN(autofill.date_created, excluded.date_created)
           END,
           date_last_used = CASE
             WHEN autofill.date_last_used IS NULL THEN excluded.date_last_used
             WHEN excluded.date_last_used IS NULL THEN autofill.date_last_used
             ELSE MAX(autofill.date_last_used, excluded.date_last_used)
           END`,
        entry.fieldName,
        entry.value,
        entry.dateCreated ?? null,
        entry.dateLastUsed ?? null,
        entry.timesUsed,
        sourceBrowser,
        sourceProfilePath
      );
    });
  }

  @rpc
  async addSearchEnginesBatch(
    engines: ImportedSearchEngine[],
    meta: ImportBatchMeta = {}
  ): Promise<number> {
    return this.runBatch(engines.length, (i) => {
      const engine = assertPresent(engines[i]);
      const importKey = this.importKey(
        "search-engine",
        meta,
        engine.sourceId
          ? ["id", engine.sourceId]
          : ["keyword-url", engine.keyword ?? "", engine.searchUrl]
      );
      this.sql.exec(
        `INSERT INTO search_engines (
           name, keyword, search_url, suggest_url, favicon_url, is_default,
           source_browser, source_profile_path, import_key
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(import_key) DO UPDATE SET
           name = excluded.name,
           keyword = excluded.keyword,
           search_url = excluded.search_url,
           suggest_url = excluded.suggest_url,
           favicon_url = excluded.favicon_url,
           is_default = excluded.is_default,
           source_browser = excluded.source_browser,
           source_profile_path = excluded.source_profile_path`,
        engine.name,
        engine.keyword ?? null,
        engine.searchUrl,
        engine.suggestUrl ?? null,
        engine.faviconUrl ?? null,
        engine.isDefault ? 1 : 0,
        meta.browser ?? "",
        meta.profilePath ?? "",
        importKey
      );
    });
  }

  @rpc
  async addPermissionsBatch(
    permissions: ImportedPermission[],
    meta: ImportBatchMeta = {}
  ): Promise<number> {
    const sourceBrowser = meta.browser ?? null;
    const sourceProfilePath = meta.profilePath ?? "";
    return this.runBatch(permissions.length, (i) => {
      const p = assertPresent(permissions[i]);
      this.sql.exec(
        `INSERT INTO permissions (origin, permission, setting, date_set, source_browser, source_profile_path)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(origin, permission) DO UPDATE SET
           setting = excluded.setting,
           date_set = excluded.date_set,
           source_browser = excluded.source_browser,
           source_profile_path = excluded.source_profile_path
         WHERE permissions.setting IS NOT excluded.setting`,
        p.origin,
        p.permission,
        p.setting,
        Date.now(),
        sourceBrowser,
        sourceProfilePath
      );
    });
  }

  @rpc
  async addFaviconsBatch(favicons: ImportedFavicon[], meta: ImportBatchMeta = {}): Promise<number> {
    const sourceBrowser = meta.browser ?? null;
    const sourceProfilePath = meta.profilePath ?? "";
    return this.runBatch(favicons.length, (i) => {
      const favicon = assertPresent(favicons[i]);
      this.sql.exec(
        `INSERT INTO favicons (url, data, mime_type, last_updated, source_browser, source_profile_path)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           data = excluded.data,
           mime_type = excluded.mime_type,
           last_updated = excluded.last_updated,
           source_browser = excluded.source_browser,
           source_profile_path = excluded.source_profile_path
         WHERE favicons.data IS NOT excluded.data
            OR favicons.mime_type IS NOT excluded.mime_type`,
        favicon.url,
        favicon.data,
        favicon.mimeType,
        Date.now(),
        sourceBrowser,
        sourceProfilePath
      );
    });
  }

  @rpc
  addNeverSave(origin: string): void {
    this.sql.exec(
      `INSERT INTO password_never_save (origin, date_added) VALUES (?, ?)
       ON CONFLICT(origin) DO NOTHING`,
      origin,
      Date.now()
    );
  }

  @rpc
  isNeverSave(origin: string): boolean {
    const row = this.sql
      .exec(`SELECT 1 AS present FROM password_never_save WHERE origin = ?`, origin)
      .toArray()[0] as { present: number } | undefined;
    return row !== undefined;
  }

  @rpc
  updateLastUsed(id: number): void {
    this.sql.exec(
      `UPDATE passwords SET date_last_used = ?, times_used = times_used + 1 WHERE id = ?`,
      Date.now(),
      id
    );
  }

  @rpc
  recordImportRun(run: {
    browser: string;
    profilePath: string;
    mode?: string;
    status?: string;
    startedAt?: number;
    finishedAt?: number;
    dataTypes?: string[];
    warnings?: string[];
    summaries?: Array<{
      dataType: string;
      scanned?: number;
      added?: number;
      changed?: number;
      unchanged?: number;
      skipped?: number;
      errors?: number;
    }>;
  }): number {
    const now = Date.now();
    const runId = this.sql
      .exec(
        `INSERT INTO import_runs (browser, profile_path, mode, status, started_at, finished_at, data_types, warnings)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        run.browser,
        run.profilePath,
        run.mode ?? "import",
        run.status ?? "success",
        run.startedAt ?? now,
        run.finishedAt ?? now,
        JSON.stringify(run.dataTypes ?? (run.summaries ?? []).map((s) => s.dataType)),
        JSON.stringify(run.warnings ?? [])
      )
      .one()["id"] as number;
    for (const s of run.summaries ?? []) {
      this.sql.exec(
        `INSERT INTO import_run_summaries (run_id, data_type, scanned, added, changed, unchanged, skipped, errors)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        runId,
        s.dataType,
        s.scanned ?? 0,
        s.added ?? 0,
        s.changed ?? 0,
        s.unchanged ?? 0,
        s.skipped ?? 0,
        s.errors ?? 0
      );
    }
    return runId;
  }

  @rpc
  getImportHistory() {
    const runs = this.sql
      .exec(`SELECT * FROM import_runs ORDER BY finished_at DESC`)
      .toArray() as Array<Record<string, unknown>>;
    return runs.map((run) => ({
      ...run,
      summaries: this.sql
        .exec(`SELECT * FROM import_run_summaries WHERE run_id = ? ORDER BY data_type`, run["id"])
        .toArray(),
    }));
  }

  @rpc
  getProfileImportState(query: { browser: string; profilePath: string }): {
    lastRun: Record<string, unknown> | null;
    runs: Array<Record<string, unknown>>;
  } {
    const runs = this.sql
      .exec(
        `SELECT * FROM import_runs WHERE browser = ? AND profile_path = ? ORDER BY finished_at DESC LIMIT 20`,
        query.browser,
        query.profilePath
      )
      .toArray() as Array<Record<string, unknown>>;
    const withSummaries = runs.map((run) => ({
      ...run,
      summaries: this.sql
        .exec(`SELECT * FROM import_run_summaries WHERE run_id = ? ORDER BY data_type`, run["id"])
        .toArray(),
    }));
    return { lastRun: withSummaries[0] ?? null, runs: withSummaries };
  }

  // ---- Secret-free "view" aggregates (Tier-1: no raw values leave the store) ----

  @rpc
  getCookieDomains() {
    return this.sql
      .exec(
        `SELECT domain,
                COUNT(*) AS count,
                MAX(secure) AS secure,
                MAX(http_only) AS httpOnly,
                MAX(source_browser) AS sourceBrowser,
                MIN(created_at) AS earliest,
                MAX(last_accessed) AS latest
         FROM cookies GROUP BY domain ORDER BY count DESC`
      )
      .toArray();
  }

  @rpc
  getPasswordOrigins(): Array<{ origin: string; count: number }> {
    const rows = this.sql.exec(`SELECT origin_url FROM passwords`).toArray() as Array<{
      origin_url: string;
    }>;
    const byHost = new Map<string, number>();
    for (const r of rows) {
      const host = this.hostnameOf(String(r.origin_url)) ?? String(r.origin_url);
      byHost.set(host, (byHost.get(host) ?? 0) + 1);
    }
    return [...byHost.entries()]
      .map(([origin, count]) => ({ origin, count }))
      .sort((a, b) => b.count - a.count);
  }

  @rpc
  getAutofillFieldNames() {
    return this.sql
      .exec(
        `SELECT field_name AS fieldName, COUNT(*) AS count, SUM(times_used) AS timesUsed
         FROM autofill GROUP BY field_name ORDER BY count DESC`
      )
      .toArray();
  }

  @rpc
  getHistoryDomains(
    limit = 2000
  ): Array<{ domain: string; visits: number; typed: number; pages: number; lastVisit: number }> {
    const rows = this.sql
      .exec(
        `SELECT url, visit_count, typed_count, last_visit FROM history ORDER BY last_visit DESC LIMIT ?`,
        limit
      )
      .toArray() as Array<{
      url: string;
      visit_count: number;
      typed_count: number;
      last_visit: number;
    }>;
    const byHost = new Map<
      string,
      { domain: string; visits: number; typed: number; pages: number; lastVisit: number }
    >();
    for (const r of rows) {
      const host = this.hostnameOf(String(r.url));
      if (!host) continue;
      const cur = byHost.get(host) ?? { domain: host, visits: 0, typed: 0, pages: 0, lastVisit: 0 };
      cur.visits += Number(r.visit_count ?? 0);
      cur.typed += Number(r.typed_count ?? 0);
      cur.pages += 1;
      cur.lastVisit = Math.max(cur.lastVisit, Number(r.last_visit ?? 0));
      byHost.set(host, cur);
    }
    return [...byHost.values()].sort((a, b) => b.lastVisit - a.lastVisit);
  }

  @rpc
  getDomainReadiness(domain: string): {
    domain: string;
    cookies: number;
    password: boolean;
    permissions: Array<{ permission: string; setting: string }>;
    recentHistoryCount: number;
    lastVisit: number | null;
  } {
    const normalizedDomain = this.normalizeDomainInput(domain);
    const cookieRows = this.sql
      .exec(`SELECT domain, COUNT(*) AS c FROM cookies GROUP BY domain`)
      .toArray() as Array<{ domain: string; c: number }>;
    let cookieCount = 0;
    for (const row of cookieRows) {
      if (this.hostMatchesDomain(String(row.domain), normalizedDomain)) {
        cookieCount += Number(row.c ?? 0);
      }
    }

    const passwordRows = this.sql.exec(`SELECT origin_url FROM passwords`).toArray() as Array<{
      origin_url: string;
    }>;
    const hasPassword = passwordRows.some((row) =>
      this.hostMatchesDomain(this.hostnameOf(String(row.origin_url)), normalizedDomain)
    );

    const perms = (
      this.sql.exec(`SELECT origin, permission, setting FROM permissions`).toArray() as Array<{
        origin: string;
        permission: string;
        setting: string;
      }>
    )
      .filter((row) =>
        this.hostMatchesDomain(this.hostnameOf(String(row.origin)), normalizedDomain)
      )
      .map((row) => ({ permission: row.permission, setting: row.setting }));

    const historyRows = this.sql.exec(`SELECT url, last_visit FROM history`).toArray() as Array<{
      url: string;
      last_visit: number;
    }>;
    let recentHistoryCount = 0;
    let lastVisit: number | null = null;
    for (const row of historyRows) {
      if (!this.hostMatchesDomain(this.hostnameOf(String(row.url)), normalizedDomain)) continue;
      recentHistoryCount++;
      const candidate = Number(row.last_visit ?? 0);
      lastVisit = lastVisit == null ? candidate : Math.max(lastVisit, candidate);
    }

    return {
      domain: normalizedDomain || domain,
      cookies: cookieCount,
      password: hasPassword,
      permissions: perms,
      recentHistoryCount,
      lastVisit,
    };
  }

  // ---- Dry-run classifier: compares candidate import items against the store ----

  @rpc
  async classifyAgainstStore(
    dataType: string,
    items: Array<Record<string, unknown>>,
    meta: ImportBatchMeta = {}
  ): Promise<{
    scanned: number;
    added: number;
    changed: number;
    unchanged: number;
    skipped: number;
    samples: Array<{ status: string; label: string; detail?: string }>;
  }> {
    let added = 0;
    let changed = 0;
    let unchanged = 0;
    let skipped = 0;
    const samples: Array<{ status: string; label: string; detail?: string }> = [];
    for (const raw of items) {
      const outcome = await this.classifyItem(dataType, raw, meta);
      if (outcome.status === "added") added++;
      else if (outcome.status === "changed") changed++;
      else if (outcome.status === "skipped") skipped++;
      else unchanged++;
      if (outcome.status !== "unchanged" && samples.length < 8) {
        samples.push({
          status: outcome.status,
          label: outcome.label,
          ...(outcome.detail ? { detail: outcome.detail } : {}),
        });
      }
    }
    return { scanned: items.length, added, changed, unchanged, skipped, samples };
  }

  private async classifyItem(
    dataType: string,
    raw: Record<string, unknown>,
    meta: ImportBatchMeta
  ): Promise<{
    status: "added" | "changed" | "unchanged" | "skipped";
    label: string;
    detail?: string;
  }> {
    switch (dataType) {
      case "cookies": {
        const name = String(raw["name"] ?? "");
        const domain = String(raw["domain"] ?? "");
        const path = String(raw["path"] ?? "/");
        const value = String(raw["value"] ?? "");
        const label = `${domain} ${name}`;
        if (value === "") return { status: "skipped", label, detail: "undecryptable" };
        const row = this.sql
          .exec(
            `SELECT value FROM cookies WHERE name = ? AND domain = ? AND path = ?`,
            name,
            domain,
            path
          )
          .toArray()[0] as { value?: string } | undefined;
        if (!row) return { status: "added", label };
        return row.value === value ? { status: "unchanged", label } : { status: "changed", label };
      }
      case "bookmarks": {
        const folder = Array.isArray(raw["folder"]) ? (raw["folder"] as string[]) : [];
        const folderPath = "/" + folder.join("/");
        const url = raw["url"] == null ? null : String(raw["url"]);
        const importKey = this.importKey(
          "bookmark",
          meta,
          raw["sourceId"] ? ["id", String(raw["sourceId"])] : ["url-folder", url ?? "", folderPath]
        );
        const label = String(raw["title"] ?? url ?? "bookmark");
        const row = this.sql
          .exec(`SELECT title, url, folder_path FROM bookmarks WHERE import_key = ?`, importKey)
          .toArray()[0] as Record<string, unknown> | undefined;
        if (!row) return { status: "added", label };
        const same =
          String(row["title"] ?? "") === String(raw["title"] ?? "") &&
          String(row["url"] ?? "") === String(url ?? "") &&
          String(row["folder_path"] ?? "") === folderPath;
        return same ? { status: "unchanged", label } : { status: "changed", label };
      }
      case "searchEngines": {
        const importKey = this.importKey(
          "search-engine",
          meta,
          raw["sourceId"]
            ? ["id", String(raw["sourceId"])]
            : ["keyword-url", String(raw["keyword"] ?? ""), String(raw["searchUrl"] ?? "")]
        );
        const label = String(raw["name"] ?? raw["keyword"] ?? "engine");
        const row = this.sql
          .exec(`SELECT name, search_url FROM search_engines WHERE import_key = ?`, importKey)
          .toArray()[0] as Record<string, unknown> | undefined;
        if (!row) return { status: "added", label };
        const same =
          String(row["name"] ?? "") === String(raw["name"] ?? "") &&
          String(row["search_url"] ?? "") === String(raw["searchUrl"] ?? "");
        return same ? { status: "unchanged", label } : { status: "changed", label };
      }
      case "permissions": {
        const origin = String(raw["origin"] ?? "");
        const permission = String(raw["permission"] ?? "");
        const label = `${origin} ${permission}`;
        const row = this.sql
          .exec(
            `SELECT setting FROM permissions WHERE origin = ? AND permission = ?`,
            origin,
            permission
          )
          .toArray()[0] as { setting?: string } | undefined;
        if (!row) return { status: "added", label };
        return row.setting === String(raw["setting"] ?? "")
          ? { status: "unchanged", label }
          : { status: "changed", label };
      }
      case "favicons": {
        const url = String(raw["url"] ?? "");
        const row = this.sql.exec(`SELECT 1 AS p FROM favicons WHERE url = ?`, url).toArray()[0];
        return row ? { status: "unchanged", label: url } : { status: "added", label: url };
      }
      case "passwords": {
        const url = String(raw["url"] ?? "");
        const username = String(raw["username"] ?? "");
        const password = String(raw["password"] ?? "");
        const actionUrl = String(raw["actionUrl"] ?? "");
        const realm = String(raw["realm"] ?? "");
        const label = `${this.hostnameOf(url) ?? url} (${username})`;
        if (password === "") return { status: "skipped", label, detail: "undecryptable" };
        const usernameHash = await this.hashUsername(username);
        const row = this.sql
          .exec(
            `SELECT password_encrypted FROM passwords WHERE origin_url = ? AND username_hash = ? AND action_url = ? AND realm = ?`,
            url,
            usernameHash,
            actionUrl,
            realm
          )
          .toArray()[0] as { password_encrypted?: string } | undefined;
        if (!row) return { status: "added", label };
        try {
          const same = (await this.decryptText(String(row.password_encrypted ?? ""))) === password;
          return same ? { status: "unchanged", label } : { status: "changed", label };
        } catch {
          return { status: "changed", label };
        }
      }
      case "history": {
        // History merges visits per URL; treat an existing URL as unchanged for preview.
        const url = String(raw["url"] ?? "");
        const row = this.sql.exec(`SELECT 1 AS p FROM history WHERE url = ?`, url).toArray()[0];
        return row ? { status: "unchanged", label: url } : { status: "added", label: url };
      }
      case "autofill": {
        const fieldName = String(raw["fieldName"] ?? "");
        const value = String(raw["value"] ?? "");
        const row = this.sql
          .exec(`SELECT 1 AS p FROM autofill WHERE field_name = ? AND value = ?`, fieldName, value)
          .toArray()[0];
        return row
          ? { status: "unchanged", label: fieldName }
          : { status: "added", label: fieldName };
      }
      default:
        return { status: "added", label: dataType };
    }
  }

  private hostnameOf(url: string): string | null {
    try {
      return new URL(url).hostname || null;
    } catch {
      return null;
    }
  }

  private normalizeDomainInput(value: string): string {
    const trimmed = value.trim().toLowerCase().replace(/^\.+/, "");
    if (!trimmed) return "";
    try {
      const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
      return parsed.hostname.replace(/^\.+/, "");
    } catch {
      return trimmed.split("/")[0]?.split(":")[0]?.replace(/^\.+/, "") ?? "";
    }
  }

  private hostMatchesDomain(host: string | null, domain: string): boolean {
    if (!host || !domain) return false;
    const normalizedHost = this.normalizeDomainInput(host);
    return normalizedHost === domain || normalizedHost.endsWith(`.${domain}`);
  }

  private changes(): number {
    const row = this.sql.exec(`SELECT changes() AS changes`).one();
    return Number(row["changes"] ?? 0);
  }

  private importKey(kind: string, meta: ImportBatchMeta, parts: string[]): string {
    return JSON.stringify([kind, meta.browser ?? "", meta.profilePath ?? "", ...parts]);
  }

  private ensureHistoryRow(
    url: string,
    title: string | null | undefined,
    observedAt: number
  ): number {
    const cleanTitle = title?.trim() || null;
    const row = this.sql
      .exec(
        `INSERT INTO history (url, title, visit_count, typed_count, first_visit, last_visit)
         VALUES (?, ?, 0, 0, NULL, ?)
         ON CONFLICT(url) DO UPDATE SET
           title = CASE
             WHEN excluded.title IS NOT NULL AND length(excluded.title) > 0 THEN excluded.title
             ELSE history.title
           END,
           last_visit = MAX(history.last_visit, excluded.last_visit)
         RETURNING id`,
        url,
        cleanTitle,
        observedAt
      )
      .one() as { id: number };
    return row.id;
  }

  private insertHistoryVisit(historyId: number, visit: HistoryVisitWrite): void {
    const transition = visit.transition?.trim() || "link";
    const title = visit.title?.trim() || null;
    const typed = visit.typed || transition === "typed" ? 1 : 0;
    this.sql.exec(
      `INSERT OR IGNORE INTO history_visits (
         history_id, visit_time, transition, from_visit_id, source, source_browser,
         source_profile_path, panel_id, title, typed
       )
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      historyId,
      visit.visitTime,
      transition,
      visit.source,
      visit.sourceBrowser ?? "",
      visit.sourceProfilePath ?? "",
      visit.panelId ?? "",
      title,
      typed
    );
  }

  private recomputeHistorySummary(historyId: number): void {
    this.sql.exec(
      `UPDATE history SET
         visit_count = (
           SELECT COUNT(*) FROM history_visits WHERE history_id = ?
         ),
         typed_count = COALESCE((
           SELECT SUM(typed) FROM history_visits WHERE history_id = ?
         ), 0),
         first_visit = (
           SELECT MIN(visit_time) FROM history_visits WHERE history_id = ?
         ),
         last_visit = COALESCE((
           SELECT MAX(visit_time) FROM history_visits WHERE history_id = ?
         ), last_visit)
       WHERE id = ?`,
      historyId,
      historyId,
      historyId,
      historyId,
      historyId
    );
  }

  private importedVisitsForEntry(entry: ImportedHistoryEntry): ImportedHistoryVisit[] {
    const explicit = (entry.visits ?? []).filter(
      (visit) => Number.isFinite(visit.visitTime) && visit.visitTime > 0
    );
    if (explicit.length > 0) return explicit;

    const visitCount = Math.max(1, Math.trunc(entry.visitCount || 1));
    const typedCount = Math.max(
      0,
      Math.min(
        visitCount,
        Math.trunc(entry.typedCount ?? (entry.transition === "typed" ? visitCount : 0))
      )
    );
    const lastVisit = this.validHistoryTimestamp(entry.lastVisitTime) ?? Date.now();
    const firstVisit = this.validHistoryTimestamp(entry.firstVisitTime) ?? lastVisit;
    const times = this.synthesizeVisitTimes(firstVisit, lastVisit, visitCount);
    return times.map((visitTime, index) => ({
      visitTime,
      transition: entry.transition,
      typed: index >= times.length - typedCount,
    }));
  }

  private validHistoryTimestamp(value: number | undefined): number | null {
    if (!Number.isFinite(value) || value == null || value <= 0) return null;
    return Math.trunc(value);
  }

  private synthesizeVisitTimes(firstVisit: number, lastVisit: number, count: number): number[] {
    if (count <= 1) return [lastVisit];
    const start = Math.min(firstVisit, lastVisit);
    const end = Math.max(firstVisit, lastVisit);
    const span = end - start;

    if (span >= count - 1) {
      const times: number[] = [];
      for (let i = 0; i < count; i++) {
        if (i === 0) {
          times.push(start);
          continue;
        }
        if (i === count - 1) {
          times.push(end);
          continue;
        }
        const ideal = Math.round(start + (span * i) / (count - 1));
        const min = assertPresent(times[i - 1]) + 1;
        const max = end - (count - 1 - i);
        times.push(Math.min(Math.max(ideal, min), max));
      }
      return times;
    }

    return Array.from({ length: count }, (_, index) => end - (count - 1 - index));
  }

  private historyAutocompleteScore(row: Record<string, unknown>, query: string): number {
    const normalized = query.toLowerCase();
    const url = String(row["url"] ?? "").toLowerCase();
    const title = String(row["title"] ?? "").toLowerCase();
    const exactBoost =
      normalized && (url === normalized || title === normalized) ? 500_000_000_000_000 : 0;
    const prefixBoost =
      normalized && (url.startsWith(normalized) || title.startsWith(normalized))
        ? 100_000_000_000_000
        : 0;
    const substringBoost =
      normalized && (url.includes(normalized) || title.includes(normalized))
        ? 10_000_000_000_000
        : 0;
    return (
      exactBoost +
      prefixBoost +
      substringBoost +
      Number(row["typed_count"] ?? 0) * 10_000_000_000 +
      Number(row["visit_count"] ?? 0) * 1_000_000 +
      Number(row["last_visit"] ?? 0)
    );
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

  private updateByMap(
    table: string,
    id: number,
    map: Record<string, string>,
    partial: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ): void {
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
      ["sign"]
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
      new TextEncoder().encode(plaintext)
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
    return crypto.subtle.importKey("raw", this.masterKeyBytes(), { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
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
