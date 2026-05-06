import { z } from "zod";
import type { EventService } from "@natstack/shared/eventsService";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { DODispatch } from "../doDispatch.js";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import {
  BookmarkSchema,
  HistoryQuerySchema,
  ImportRequestSchema,
  PasswordSchema,
  detectBrowsers,
  exportChromiumBookmarks,
  exportCsvPasswords,
  exportJson,
  exportNetscapeBookmarks,
  exportNetscapeCookies,
  runImportPipeline,
  resolveProfilePath,
} from "@natstack/browser-data";
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
} from "@natstack/browser-data";

export function createBrowserDataService(deps: {
  eventService: EventService;
  doDispatch: DODispatch;
}): ServiceDefinition {
  const ref = { source: INTERNAL_DO_SOURCE, className: "BrowserDataDO", objectKey: "global" };
  const call = <T>(method: string, ...args: unknown[]) =>
    deps.doDispatch.dispatch(ref, method, ...args) as Promise<T>;
  const changed = (dataType: ImportDataType | "passwords" | "searchEngines") => {
    deps.eventService.emit("browser-data-changed", { dataType });
  };
  const mutate = async <T>(dataType: ImportDataType | "passwords" | "searchEngines", doMethod: string, ...methodArgs: unknown[]) => {
    const result = await call<T>(doMethod, ...methodArgs);
    changed(dataType);
    return result;
  };

  // Methods that read/export plaintext credentials (passwords, cookies,
  // history) MUST be shell-only. The user's settings/import UI runs in the
  // shell; panels and workers must never be able to dump the imported
  // browser credential store. See audit findings #4 / 07-F-02 / 01-C2.
  const SHELL_ONLY: { allowed: ("shell" | "panel" | "worker" | "server" | "harness")[] } = { allowed: ["shell"] };

  return {
    name: "browser-data",
    description: "Browser data import, export, and management",
    // Service-level default keeps panel/worker access for non-sensitive
    // methods (detectBrowsers, bookmark CRUD, search engines). Every
    // method that touches plaintext credentials, cookies, or browsing
    // history is locked down via per-method `policy: SHELL_ONLY` below.
    policy: { allowed: ["shell", "panel", "worker"] },
    methods: {
      detectBrowsers: { args: z.tuple([]) },
      startImport: { args: z.tuple([ImportRequestSchema]) },
      getImportHistory: { args: z.tuple([]) },
      getBookmarks: { args: z.tuple([z.string().optional()]) },
      addBookmark: { args: z.tuple([BookmarkSchema]) },
      updateBookmark: { args: z.tuple([z.number(), BookmarkSchema.partial()]) },
      deleteBookmark: { args: z.tuple([z.number()]) },
      moveBookmark: { args: z.tuple([z.number(), z.string(), z.number()]) },
      searchBookmarks: { args: z.tuple([z.string()]) },
      getHistory: { args: z.tuple([HistoryQuerySchema]), policy: SHELL_ONLY },
      deleteHistoryEntry: { args: z.tuple([z.number()]), policy: SHELL_ONLY },
      deleteHistoryRange: { args: z.tuple([z.number(), z.number()]), policy: SHELL_ONLY },
      clearAllHistory: { args: z.tuple([]), policy: SHELL_ONLY },
      searchHistory: { args: z.tuple([z.string(), z.number().optional()]), policy: SHELL_ONLY },
      getPasswords: { args: z.tuple([]), policy: SHELL_ONLY },
      getPasswordForSite: { args: z.tuple([z.string()]), policy: SHELL_ONLY },
      addPassword: { args: z.tuple([PasswordSchema]), policy: SHELL_ONLY },
      updatePassword: { args: z.tuple([z.number(), PasswordSchema.partial()]), policy: SHELL_ONLY },
      deletePassword: { args: z.tuple([z.number()]), policy: SHELL_ONLY },
      updatePasswordLastUsed: { args: z.tuple([z.number()]), policy: SHELL_ONLY },
      addNeverSavePassword: { args: z.tuple([z.string()]), policy: SHELL_ONLY },
      isNeverSavePassword: { args: z.tuple([z.string()]), policy: SHELL_ONLY },
      getAutofillSuggestions: { args: z.tuple([z.string(), z.string().optional()]), policy: SHELL_ONLY },
      getSearchEngines: { args: z.tuple([]) },
      setDefaultEngine: { args: z.tuple([z.number()]) },
      getPermissions: { args: z.tuple([z.string().optional()]) },
      setPermission: { args: z.tuple([z.string(), z.string(), z.string()]) },
      exportBookmarks: { args: z.tuple([z.enum(["html", "json", "chrome-json"])]), policy: SHELL_ONLY },
      exportPasswords: { args: z.tuple([z.enum(["csv-chrome", "csv-firefox", "json"])]), policy: SHELL_ONLY },
      exportCookies: { args: z.tuple([z.enum(["json", "netscape-txt"])]), policy: SHELL_ONLY },
      exportAll: { args: z.tuple([]), policy: SHELL_ONLY },
      getCookies: { args: z.tuple([z.string().optional()]), policy: SHELL_ONLY },
      deleteCookie: { args: z.tuple([z.number()]), policy: SHELL_ONLY },
      clearCookies: { args: z.tuple([z.string().optional()]), policy: SHELL_ONLY },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "detectBrowsers":
          return detectBrowsers();
        case "startImport":
          return importBrowserData(args[0] as ImportRequest, call, deps.eventService);
        case "getImportHistory":
          return call("getImportHistory");
        case "getBookmarks":
          return call("getBookmarks", args[0] ?? "/");
        case "addBookmark":
          return mutate("bookmarks", "addBookmark", args[0]);
        case "updateBookmark":
          return mutate("bookmarks", "updateBookmark", args[0], args[1]);
        case "deleteBookmark":
          return mutate("bookmarks", "deleteBookmark", args[0]);
        case "moveBookmark":
          return mutate("bookmarks", "moveBookmark", ...args);
        case "searchBookmarks":
          return call("searchBookmarks", args[0]);
        case "getHistory":
          return call("getHistory", args[0]);
        case "deleteHistoryEntry":
        case "deleteHistoryRange":
        case "clearAllHistory":
          return mutate("history", method, ...args);
        case "deletePassword":
          return mutate("passwords", method, ...args);
        case "setDefaultEngine":
          return mutate("searchEngines", method, ...args);
        case "setPermission":
          return mutate("permissions", method, ...args);
        case "deleteCookie":
        case "clearCookies":
          return mutate("cookies", method, ...args);
        case "updatePasswordLastUsed":
          return mutate("passwords", "updateLastUsed", args[0]);
        case "addNeverSavePassword":
          return mutate("passwords", "addNeverSave", args[0]);
        case "isNeverSavePassword":
          return call("isNeverSave", args[0]);
        case "searchHistory":
          return call("searchHistory", ...args);
        case "getPasswords":
          return call("getPasswords");
        case "getPasswordForSite":
          return call("getPasswordForSite", args[0]);
        case "addPassword":
          return mutate("passwords", "addPassword", args[0]);
        case "updatePassword":
          return mutate("passwords", "updatePassword", args[0], args[1]);
        case "getAutofillSuggestions":
          return call("getAutofillSuggestions", ...args);
        case "getSearchEngines":
          return call("getSearchEngines");
        case "getPermissions":
          return call("getPermissions", args[0]);
        case "getCookies":
          return call("getCookies", args[0]);
        case "exportBookmarks":
          return exportBookmarks(args[0] as "html" | "json" | "chrome-json", await call("getAllBookmarks"));
        case "exportPasswords":
          return exportPasswords(args[0] as "csv-chrome" | "csv-firefox" | "json", await call("getPasswords"));
        case "exportCookies":
          return exportCookies(args[0] as "json" | "netscape-txt", await call("getCookies"));
        case "exportAll":
          return exportAll(await call("getAllBookmarks"), await call("getHistory", { limit: 2147483647 }), await call("getCookies"), await call("getPasswords"));
        default:
          throw new Error(`Unknown browser-data method: ${method}`);
      }
    },
  };
}

async function importBrowserData(
  request: ImportRequest,
  call: <T>(method: string, ...args: unknown[]) => Promise<T>,
  eventService: EventService,
) {
  const profilePath = resolveProfilePath(request);
  const store = {
    bookmarks: { addBatch: (items: ImportedBookmark[]) => call<number>("addBookmarksBatch", items) },
    history: { addBatch: (items: ImportedHistoryEntry[]) => call<number>("addHistoryBatch", items) },
    cookies: { addBatch: (items: ImportedCookie[]) => call<number>("addCookiesBatch", items) },
    passwords: { addBatch: (items: ImportedPassword[]) => call<number>("addPasswordsBatch", items) },
    autofill: { addBatch: (items: ImportedAutofillEntry[]) => call<number>("addAutofillBatch", items) },
    searchEngines: { addBatch: (items: ImportedSearchEngine[]) => call<number>("addSearchEnginesBatch", items) },
    permissions: { addBatch: (items: ImportedPermission[]) => call<number>("addPermissionsBatch", items) },
    favicons: { addBatch: (items: ImportedFavicon[]) => call<number>("addFaviconsBatch", items) },
  };
  const results = await runImportPipeline(request, store);
  await Promise.all(results.map((result: ImportResult) => call("logImport", {
    browser: request.browser,
    profilePath,
    dataType: result.dataType,
    itemsImported: result.itemCount,
    itemsSkipped: result.skippedCount,
    warnings: result.warnings,
  })));
  for (const result of results) {
    if (result.success) eventService.emit("browser-data-changed", { dataType: result.dataType });
  }
  eventService.emit("browser-import-complete", results);
  return results;
}

function exportBookmarks(format: "html" | "json" | "chrome-json", allBookmarks: Array<Record<string, unknown>>) {
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

function exportPasswords(format: "csv-chrome" | "csv-firefox" | "json", allPasswords: Array<Record<string, unknown>>) {
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

function exportCookies(format: "json" | "netscape-txt", allCookies: Array<Record<string, unknown>>) {
  const mapped = allCookies.map(storedCookieToImported);
  if (format === "netscape-txt") return exportNetscapeCookies(mapped);
  return JSON.stringify(mapped, null, 2);
}

function exportAll(bookmarks: Array<Record<string, unknown>>, history: Array<Record<string, unknown>>, cookies: Array<Record<string, unknown>>, passwords: Array<Record<string, unknown>>) {
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
