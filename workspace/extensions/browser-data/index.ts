import {
  detectBrowsers,
  exportChromiumBookmarks,
  exportCsvPasswords,
  exportJson,
  exportNetscapeBookmarks,
  exportNetscapeCookies,
  runImportPipeline,
} from "@workspace/browser-data";
import { resolveProfilePath } from "@natstack/browser-data";
import type {
  ImportDataType,
  ImportRequest,
  ImportResult,
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
} from "@natstack/browser-data";

interface InvocationLike {
  current(): { caller: { callerKind: string } } | null;
}

interface ExtensionContextLike {
  rpc: {
    call<T>(targetId: string, method: string, ...args: unknown[]): Promise<T>;
  };
  workers: {
    resolveDurableObject(source: string, className: string, objectKey: string): Promise<{ targetId: string }>;
  };
  invocation: InvocationLike;
  log: { info(message: string): void };
  health?: {
    healthy(detail?: { summary: string }): void;
    degraded(detail: { summary: string; reasons?: string[] }): void;
    unhealthy(detail: { summary: string; reasons?: string[] }): void;
  };
  emit(event: string, payload: unknown): void;
}

const DO_SOURCE = "natstack/internal";
const DO_CLASS = "BrowserDataDO";
const DO_KEY = "global";

/**
 * Methods that read or export plaintext credentials, cookies, or browsing
 * history are shell-only. Mirrors the SHELL_ONLY policy on the previous
 * in-host browser-data service: panels and workers must never be able to
 * dump the imported credential store. The extension enforces this directly
 * because `extensions.invoke` is open to all userland kinds at the
 * dispatcher level.
 */
const SHELL_ONLY_METHODS = new Set([
  "getHistory",
  "deleteHistoryEntry",
  "deleteHistoryRange",
  "clearAllHistory",
  "searchHistory",
  "searchHistoryForAutocomplete",
  "recordHistoryVisit",
  "updateHistoryTitle",
  "getPasswords",
  "getPasswordForSite",
  "addPassword",
  "updatePassword",
  "deletePassword",
  "updatePasswordLastUsed",
  "addNeverSavePassword",
  "isNeverSavePassword",
  "getAutofillSuggestions",
  "exportBookmarks",
  "exportPasswords",
  "exportCookies",
  "exportAll",
  "getCookies",
  "deleteCookie",
  "clearCookies",
]);

/** Public API surface of this extension — the awaited return of {@link activate}. */
export type Api = Awaited<ReturnType<typeof activate>>;
declare module "@natstack/extension" {
  interface WorkspaceExtensions {
    "@workspace-extensions/browser-data": Api;
  }
}

export async function activate(ctx: ExtensionContextLike) {
  ctx.log.info("browser-data extension activating");
  ctx.health?.healthy({ summary: "Browser data extension ready" });

  let storeTargetPromise: Promise<string> | null = null;
  const getStoreTarget = () => {
    storeTargetPromise ??= ctx.workers
      .resolveDurableObject(DO_SOURCE, DO_CLASS, DO_KEY)
      .then((target) => target.targetId);
    return storeTargetPromise;
  };
  const callStore = <T>(method: string, ...args: unknown[]) =>
    getStoreTarget().then((targetId) => ctx.rpc.call<T>(targetId, method, ...args));

  const requireShell = (method: string): void => {
    const callerKind = ctx.invocation.current()?.caller.callerKind;
    if (callerKind !== "shell") {
      const err = new Error(
        `browser-data.${method} is only available to shell callers (got ${callerKind ?? "unknown"})`,
      ) as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    }
  };

  const guarded = <Args extends unknown[], R>(method: string, fn: (...args: Args) => Promise<R>) =>
    (...args: Args): Promise<R> => {
      if (SHELL_ONLY_METHODS.has(method)) requireShell(method);
      return fn(...args);
    };

  const emitChanged = (dataType: ImportDataType | "passwords" | "searchEngines"): void => {
    ctx.emit("data-changed", { dataType });
  };

  const mutate = async <T>(
    dataType: ImportDataType | "passwords" | "searchEngines",
    doMethod: string,
    ...args: unknown[]
  ): Promise<T> => {
    const result = await callStore<T>(doMethod, ...args);
    emitChanged(dataType);
    return result;
  };

  return {
    detectBrowsers: guarded("detectBrowsers", async () => detectBrowsers()),

    startImport: guarded("startImport", async (request: ImportRequest) =>
      importBrowserData(request, callStore, emitChanged, ctx)),

    getImportHistory: guarded("getImportHistory", async () => callStore("getImportHistory")),

    getBookmarks: guarded("getBookmarks", async (folderPath?: string) =>
      callStore("getBookmarks", folderPath ?? "/")),
    addBookmark: guarded("addBookmark", async (bookmark: unknown) =>
      mutate("bookmarks", "addBookmark", bookmark)),
    updateBookmark: guarded("updateBookmark", async (id: number, partial: unknown) =>
      mutate("bookmarks", "updateBookmark", id, partial)),
    deleteBookmark: guarded("deleteBookmark", async (id: number) =>
      mutate("bookmarks", "deleteBookmark", id)),
    moveBookmark: guarded("moveBookmark", async (id: number, folder: string, position: number) =>
      mutate("bookmarks", "moveBookmark", id, folder, position)),
    searchBookmarks: guarded("searchBookmarks", async (query: string) =>
      callStore("searchBookmarks", query)),

    getHistory: guarded("getHistory", async (query: unknown) => callStore("getHistory", query)),
    deleteHistoryEntry: guarded("deleteHistoryEntry", async (id: number) =>
      mutate("history", "deleteHistoryEntry", id)),
    deleteHistoryRange: guarded("deleteHistoryRange", async (start: number, end: number) =>
      mutate("history", "deleteHistoryRange", start, end)),
    clearAllHistory: guarded("clearAllHistory", async () => mutate("history", "clearAllHistory")),
    searchHistory: guarded("searchHistory", async (query: string, limit?: number) =>
      callStore("searchHistory", query, limit)),
    searchHistoryForAutocomplete: guarded("searchHistoryForAutocomplete", async (query: unknown) =>
      callStore("searchHistoryForAutocomplete", query)),
    recordHistoryVisit: guarded("recordHistoryVisit", async (request: RecordHistoryVisitRequest) =>
      mutate("history", "recordHistoryVisit", validateHistoryVisit(request))),
    updateHistoryTitle: guarded("updateHistoryTitle", async (request: UpdateHistoryTitleRequest) =>
      mutate("history", "updateHistoryTitle", validateHistoryTitle(request))),

    getPasswords: guarded("getPasswords", async () => callStore("getPasswords")),
    getPasswordForSite: guarded("getPasswordForSite", async (origin: string) =>
      callStore("getPasswordForSite", origin)),
    addPassword: guarded("addPassword", async (password: unknown) =>
      mutate("passwords", "addPassword", password)),
    updatePassword: guarded("updatePassword", async (id: number, partial: unknown) =>
      mutate("passwords", "updatePassword", id, partial)),
    deletePassword: guarded("deletePassword", async (id: number) =>
      mutate("passwords", "deletePassword", id)),
    updatePasswordLastUsed: guarded("updatePasswordLastUsed", async (id: number) =>
      mutate("passwords", "updateLastUsed", id)),
    addNeverSavePassword: guarded("addNeverSavePassword", async (origin: string) =>
      mutate("passwords", "addNeverSave", origin)),
    isNeverSavePassword: guarded("isNeverSavePassword", async (origin: string) =>
      callStore("isNeverSave", origin)),
    getAutofillSuggestions: guarded("getAutofillSuggestions", async (origin: string, fieldName?: string) =>
      callStore("getAutofillSuggestions", origin, fieldName)),

    getSearchEngines: guarded("getSearchEngines", async () => callStore("getSearchEngines")),
    setDefaultEngine: guarded("setDefaultEngine", async (id: number) =>
      mutate("searchEngines", "setDefaultEngine", id)),
    getPermissions: guarded("getPermissions", async (origin?: string) =>
      callStore("getPermissions", origin)),
    setPermission: guarded("setPermission", async (origin: string, perm: string, value: string) =>
      mutate("permissions", "setPermission", origin, perm, value)),

    exportBookmarks: guarded(
      "exportBookmarks",
      async (format: "html" | "json" | "chrome-json") =>
        exportBookmarks(format, await callStore<Array<Record<string, unknown>>>("getAllBookmarks")),
    ),
    exportPasswords: guarded(
      "exportPasswords",
      async (format: "csv-chrome" | "csv-firefox" | "json") =>
        exportPasswords(format, await callStore<Array<Record<string, unknown>>>("getPasswords")),
    ),
    exportCookies: guarded(
      "exportCookies",
      async (format: "json" | "netscape-txt") =>
        exportCookies(format, await callStore<Array<Record<string, unknown>>>("getCookies")),
    ),
    exportAll: guarded("exportAll", async () =>
      exportAll(
        await callStore<Array<Record<string, unknown>>>("getAllBookmarks"),
        await callStore<Array<Record<string, unknown>>>("getHistory", { limit: 2147483647 }),
        await callStore<Array<Record<string, unknown>>>("getCookies"),
        await callStore<Array<Record<string, unknown>>>("getPasswords"),
      )),

    getCookies: guarded("getCookies", async (domain?: string) => callStore("getCookies", domain)),
    deleteCookie: guarded("deleteCookie", async (id: number) =>
      mutate("cookies", "deleteCookie", id)),
    clearCookies: guarded("clearCookies", async (domain?: string) =>
      mutate("cookies", "clearCookies", domain)),
  };
}

async function importBrowserData(
  request: ImportRequest,
  callStore: <T>(method: string, ...args: unknown[]) => Promise<T>,
  emitChanged: (dataType: ImportDataType | "passwords" | "searchEngines") => void,
  ctx: ExtensionContextLike,
): Promise<ImportResult[]> {
  const profilePath = resolveProfilePath(request);
  const store = {
    bookmarks: { addBatch: (items: ImportedBookmark[]) => callStore<number>("addBookmarksBatch", items) },
    history: { addBatch: (items: ImportedHistoryEntry[]) => callStore<number>("addHistoryBatch", items) },
    cookies: { addBatch: (items: ImportedCookie[]) => callStore<number>("addCookiesBatch", items) },
    passwords: { addBatch: (items: ImportedPassword[]) => callStore<number>("addPasswordsBatch", items) },
    autofill: { addBatch: (items: ImportedAutofillEntry[]) => callStore<number>("addAutofillBatch", items) },
    searchEngines: { addBatch: (items: ImportedSearchEngine[]) => callStore<number>("addSearchEnginesBatch", items) },
    permissions: { addBatch: (items: ImportedPermission[]) => callStore<number>("addPermissionsBatch", items) },
    favicons: { addBatch: (items: ImportedFavicon[]) => callStore<number>("addFaviconsBatch", items) },
  };
  const results = await runImportPipeline(request, store);
  await Promise.all(results.map((result: ImportResult) => callStore("logImport", {
    browser: request.browser,
    profilePath,
    dataType: result.dataType,
    itemsImported: result.itemCount,
    itemsSkipped: result.skippedCount,
    warnings: result.warnings,
  })));
  for (const result of results) {
    if (result.success) emitChanged(result.dataType);
  }
  reportImportHealth(ctx, results);
  ctx.emit("import-complete", results);
  return results;
}

function reportImportHealth(ctx: ExtensionContextLike, results: ImportResult[]): void {
  const failures = results.filter((result) => !result.success);
  const warnings = results.flatMap((result) => result.warnings ?? []);
  if (failures.length > 0) {
    ctx.health?.degraded({
      summary: "Some browser data imports failed",
      reasons: failures.map((result) =>
        `${result.dataType}: ${result.error ?? "import failed"}`),
    });
    return;
  }
  if (warnings.length > 0) {
    ctx.health?.degraded({
      summary: "Browser data import completed with warnings",
      reasons: warnings.slice(0, 8),
    });
    return;
  }
  ctx.health?.healthy({ summary: "Browser data import completed" });
}

function exportBookmarks(format: "html" | "json" | "chrome-json", allBookmarks: Array<Record<string, unknown>>): string {
  const imported: ImportedBookmark[] = allBookmarks.map((b) => ({
    title: String(b["title"] ?? ""),
    url: String(b["url"] ?? ""),
    dateAdded: Number(b["date_added"] ?? Date.now()),
    folder: String(b["folder_path"] ?? "/").split("/").filter(Boolean),
    tags: b["tags"] ? JSON.parse(String(b["tags"])) as string[] : undefined,
    keyword: b["keyword"] ? String(b["keyword"]) : undefined,
  }));
  if (format === "html") return exportNetscapeBookmarks(imported);
  if (format === "chrome-json") return exportChromiumBookmarks(imported);
  return JSON.stringify(imported, null, 2);
}

function validateHistoryVisit(request: RecordHistoryVisitRequest): RecordHistoryVisitRequest {
  validateHttpUrl(request.url);
  return {
    ...request,
    title: request.title?.trim() || undefined,
    visitTime: request.visitTime ?? Date.now(),
    transition: request.transition ?? "link",
    typed: Boolean(request.typed),
  };
}

function validateHistoryTitle(request: UpdateHistoryTitleRequest): UpdateHistoryTitleRequest {
  validateHttpUrl(request.url);
  return {
    ...request,
    title: request.title.trim(),
    observedAt: request.observedAt ?? Date.now(),
  };
}

function validateHttpUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error(`Invalid browser history URL (must be http/https): ${url}`);
  }
}

function exportPasswords(format: "csv-chrome" | "csv-firefox" | "json", allPasswords: Array<Record<string, unknown>>): string {
  const imported: ImportedPassword[] = allPasswords.map((p) => ({
    url: String(p["origin_url"] ?? ""),
    username: String(p["username"] ?? ""),
    password: String(p["password"] ?? ""),
    actionUrl: p["action_url"] ? String(p["action_url"]) : undefined,
    realm: p["realm"] ? String(p["realm"]) : undefined,
  }));
  if (format === "csv-chrome") return exportCsvPasswords(imported, "chrome");
  if (format === "csv-firefox") return exportCsvPasswords(imported, "firefox");
  return JSON.stringify(imported, null, 2);
}

function exportCookies(format: "json" | "netscape-txt", allCookies: Array<Record<string, unknown>>): string {
  const mapped = allCookies.map(storedCookieToImported);
  if (format === "netscape-txt") return exportNetscapeCookies(mapped);
  return JSON.stringify(mapped, null, 2);
}

function exportAll(
  bookmarks: Array<Record<string, unknown>>,
  history: Array<Record<string, unknown>>,
  cookies: Array<Record<string, unknown>>,
  passwords: Array<Record<string, unknown>>,
): string {
  return exportJson({
    exportedAt: new Date().toISOString(),
    version: 1,
    bookmarks,
    history,
    cookies: cookies.map(storedCookieToImported),
    passwords,
  } as never);
}

function storedCookieToImported(c: Record<string, unknown>): ImportedCookie {
  return {
    name: String(c["name"] ?? ""),
    value: String(c["value"] ?? ""),
    domain: String(c["domain"] ?? ""),
    hostOnly: Number(c["host_only"] ?? 0) === 1,
    path: String(c["path"] ?? "/"),
    expirationDate: c["expiration_date"] == null ? undefined : Number(c["expiration_date"]),
    secure: Number(c["secure"] ?? 0) === 1,
    httpOnly: Number(c["http_only"] ?? 0) === 1,
    sameSite: (String(c["same_site"] ?? "unspecified") as ImportedCookie["sameSite"]),
    sourceScheme: (String(c["source_scheme"] ?? "unset") as ImportedCookie["sourceScheme"]),
    sourcePort: Number(c["source_port"] ?? -1),
  };
}
