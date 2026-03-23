/**
 * @workspace/panel-browser — Typed browser data API for panel eval context.
 *
 * Usage from eval:
 *   import { browserData } from "@workspace/panel-browser";
 *   const browsers = await browserData.detectBrowsers();
 *
 * Or explicitly with an RPC bridge:
 *   import { createBrowserDataApi } from "@workspace/panel-browser";
 *   import { rpc } from "@workspace/runtime";
 *   const browserData = createBrowserDataApi(rpc);
 *
 * Note: `createBrowserPanel` (for opening external URL panels with CDP access)
 * is available from `@workspace/runtime`, not this package.
 */

import type { RpcBridge } from "@natstack/rpc";

// ---- Types (mirrored from @natstack/browser-data for browser context) ----

export type BrowserName =
  | "firefox" | "zen" | "chrome" | "chrome-beta" | "chrome-dev" | "chrome-canary"
  | "chromium" | "edge" | "edge-beta" | "edge-dev" | "brave" | "vivaldi"
  | "opera" | "opera-gx" | "arc" | "safari";

export type BrowserFamily = "firefox" | "chromium" | "safari";

export interface DetectedProfile {
  id: string;
  displayName: string;
  path: string;
  isDefault: boolean;
  avatarUrl?: string;
}

export interface DetectedBrowser {
  name: BrowserName;
  family: BrowserFamily;
  displayName: string;
  version?: string;
  dataDir: string;
  profiles: DetectedProfile[];
  tccBlocked?: boolean;
}

export type ImportDataType =
  | "bookmarks" | "history" | "cookies" | "passwords" | "autofill"
  | "searchEngines" | "extensions" | "permissions" | "settings" | "favicons";

export interface ImportRequest {
  browser: BrowserName;
  profilePath: string;
  dataTypes: ImportDataType[];
  masterPassword?: string;
  csvPasswordFile?: string;
}

export interface ImportResult {
  dataType: ImportDataType;
  success: boolean;
  itemCount: number;
  skippedCount: number;
  error?: string;
  warnings: string[];
}

export interface StoredBookmark {
  id: number;
  title: string;
  url: string | null;
  folder_path: string;
  date_added: number;
  date_modified: number | null;
  position: number;
  tags: string | null;
  keyword: string | null;
}

export interface StoredHistory {
  id: number;
  url: string;
  title: string | null;
  visit_count: number;
  typed_count: number;
  first_visit: number | null;
  last_visit: number;
}

export interface HistoryQuery {
  search?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
}

export interface StoredPassword {
  id: number;
  origin_url: string;
  username: string;
  password: string;
  action_url: string;
  realm: string;
  date_created: number | null;
  date_last_used: number | null;
  times_used: number;
}

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
}

export interface StoredSearchEngine {
  id: number;
  name: string;
  keyword: string | null;
  search_url: string;
  suggest_url: string | null;
  favicon_url: string | null;
  is_default: number;
}

export interface StoredPermission {
  id: number;
  origin: string;
  permission: string;
  setting: string;
}

export interface StoredAutofill {
  id: number;
  field_name: string;
  value: string;
  times_used: number;
}

export interface ImportLogEntry {
  id: number;
  browser: string;
  profile_path: string;
  data_type: string;
  items_imported: number;
  items_skipped: number;
  imported_at: number;
  warnings: string | null;
}

// ---- API ----

export interface BrowserDataApi {
  // Detection
  detectBrowsers(): Promise<DetectedBrowser[]>;

  // Import
  startImport(request: ImportRequest): Promise<ImportResult[]>;
  getImportHistory(): Promise<ImportLogEntry[]>;

  // Bookmarks
  getBookmarks(folderPath?: string): Promise<StoredBookmark[]>;
  addBookmark(bookmark: {
    title: string;
    url?: string;
    folderPath?: string;
    dateAdded?: number;
    tags?: string;
    keyword?: string;
    position?: number;
  }): Promise<number>;
  updateBookmark(id: number, partial: Partial<{
    title: string;
    url: string;
    folderPath: string;
    tags: string;
    keyword: string;
    position: number;
  }>): Promise<void>;
  deleteBookmark(id: number): Promise<void>;
  moveBookmark(id: number, folderPath: string, position: number): Promise<void>;
  searchBookmarks(query: string): Promise<StoredBookmark[]>;

  // History
  getHistory(query: HistoryQuery): Promise<StoredHistory[]>;
  deleteHistoryEntry(id: number): Promise<void>;
  deleteHistoryRange(startTime: number, endTime: number): Promise<number>;
  clearAllHistory(): Promise<void>;
  searchHistory(query: string, limit?: number): Promise<StoredHistory[]>;

  // Passwords
  getPasswords(): Promise<StoredPassword[]>;
  getPasswordForSite(url: string): Promise<StoredPassword[]>;
  addPassword(password: {
    url: string;
    username: string;
    password: string;
    actionUrl?: string;
    realm?: string;
  }): Promise<number>;
  updatePassword(id: number, partial: Partial<{
    username: string;
    password: string;
    actionUrl: string;
    realm: string;
  }>): Promise<void>;
  deletePassword(id: number): Promise<void>;

  // Autofill
  getAutofillSuggestions(fieldName: string, prefix?: string): Promise<StoredAutofill[]>;

  // Search Engines
  getSearchEngines(): Promise<StoredSearchEngine[]>;
  setDefaultEngine(id: number): Promise<void>;

  // Permissions
  getPermissions(origin?: string): Promise<StoredPermission[]>;
  setPermission(origin: string, permission: string, setting: "allow" | "block" | "ask"): Promise<void>;

  // Cookies
  getCookies(domain?: string): Promise<StoredCookie[]>;
  deleteCookie(id: number): Promise<void>;
  clearCookies(domain?: string): Promise<number>;
  syncCookiesToSession(domain?: string): Promise<{ synced: number; failed: number }>;
  syncCookiesFromSession(domain?: string): Promise<{ synced: number }>;

  // Export
  exportBookmarks(format: "html" | "json" | "chrome-json"): Promise<string>;
  exportPasswords(format: "csv-chrome" | "csv-firefox" | "json"): Promise<string>;
  exportCookies(format: "json" | "netscape-txt"): Promise<string>;
  exportAll(): Promise<string>;
}

const SVC = "browser-data";

export function createBrowserDataApi(rpc: RpcBridge): BrowserDataApi {
  if (!rpc) {
    throw new Error(
      "createBrowserDataApi requires an RPC bridge. " +
      "In eval context: import { rpc } from '@workspace/runtime'. " +
      "In inline_ui components: use chat.rpc.",
    );
  }
  return {
    // Detection
    detectBrowsers: () => rpc.call("main", `${SVC}.detectBrowsers`),

    // Import
    startImport: (request) => rpc.call("main", `${SVC}.startImport`, request),
    getImportHistory: () => rpc.call("main", `${SVC}.getImportHistory`),

    // Bookmarks
    getBookmarks: (folderPath?) => rpc.call("main", `${SVC}.getBookmarks`, folderPath),
    addBookmark: (bookmark) => rpc.call("main", `${SVC}.addBookmark`, bookmark),
    updateBookmark: (id, partial) => rpc.call("main", `${SVC}.updateBookmark`, id, partial),
    deleteBookmark: (id) => rpc.call("main", `${SVC}.deleteBookmark`, id),
    moveBookmark: (id, folder, pos) => rpc.call("main", `${SVC}.moveBookmark`, id, folder, pos),
    searchBookmarks: (query) => rpc.call("main", `${SVC}.searchBookmarks`, query),

    // History
    getHistory: (query) => rpc.call("main", `${SVC}.getHistory`, query),
    deleteHistoryEntry: (id) => rpc.call("main", `${SVC}.deleteHistoryEntry`, id),
    deleteHistoryRange: (start, end) => rpc.call("main", `${SVC}.deleteHistoryRange`, start, end),
    clearAllHistory: () => rpc.call("main", `${SVC}.clearAllHistory`),
    searchHistory: (query, limit?) => rpc.call("main", `${SVC}.searchHistory`, query, limit),

    // Passwords
    getPasswords: () => rpc.call("main", `${SVC}.getPasswords`),
    getPasswordForSite: (url) => rpc.call("main", `${SVC}.getPasswordForSite`, url),
    addPassword: (pw) => rpc.call("main", `${SVC}.addPassword`, pw),
    updatePassword: (id, partial) => rpc.call("main", `${SVC}.updatePassword`, id, partial),
    deletePassword: (id) => rpc.call("main", `${SVC}.deletePassword`, id),

    // Autofill
    getAutofillSuggestions: (field, prefix?) => rpc.call("main", `${SVC}.getAutofillSuggestions`, field, prefix),

    // Search Engines
    getSearchEngines: () => rpc.call("main", `${SVC}.getSearchEngines`),
    setDefaultEngine: (id) => rpc.call("main", `${SVC}.setDefaultEngine`, id),

    // Permissions
    getPermissions: (origin?) => rpc.call("main", `${SVC}.getPermissions`, origin),
    setPermission: (origin, perm, setting) => rpc.call("main", `${SVC}.setPermission`, origin, perm, setting),

    // Cookies
    getCookies: (domain?) => rpc.call("main", `${SVC}.getCookies`, domain),
    deleteCookie: (id) => rpc.call("main", `${SVC}.deleteCookie`, id),
    clearCookies: (domain?) => rpc.call("main", `${SVC}.clearCookies`, domain),
    syncCookiesToSession: (domain?) => rpc.call("main", `${SVC}.syncCookiesToSession`, domain),
    syncCookiesFromSession: (domain?) => rpc.call("main", `${SVC}.syncCookiesFromSession`, domain),

    // Export
    exportBookmarks: (format) => rpc.call("main", `${SVC}.exportBookmarks`, format),
    exportPasswords: (format) => rpc.call("main", `${SVC}.exportPasswords`, format),
    exportCookies: (format) => rpc.call("main", `${SVC}.exportCookies`, format),
    exportAll: () => rpc.call("main", `${SVC}.exportAll`),
  };
}

// Auto-initialize using the runtime's RPC bridge if available
let _browserData: BrowserDataApi | undefined;

export function getBrowserData(): BrowserDataApi {
  if (_browserData) return _browserData;

  // Try multiple mechanisms to resolve @workspace/runtime's rpc bridge.
  // 1. __natstackRequire__ — available in built panel bundles
  // 2. __natstackModuleMap__ — the underlying map that __natstackRequire__ reads from;
  //    available in eval sandbox context even when __natstackRequire__ is not yet wired up
  let runtime: { rpc?: RpcBridge } | undefined;

  const g = globalThis as Record<string, unknown>;
  if (typeof g["__natstackRequire__"] === "function") {
    try {
      runtime = (g["__natstackRequire__"] as (id: string) => { rpc: RpcBridge })("@workspace/runtime");
    } catch {
      // fall through to next strategy
    }
  }

  if (!runtime?.rpc && g["__natstackModuleMap__"]) {
    const moduleMap = g["__natstackModuleMap__"] as Record<string, { rpc?: RpcBridge }>;
    runtime = moduleMap["@workspace/runtime"];
  }

  if (!runtime?.rpc) {
    throw new Error(
      "browserData requires @workspace/runtime. " +
      "In eval context: import { createBrowserDataApi } from '@workspace/panel-browser'; " +
      "import { rpc } from '@workspace/runtime'; const browserData = createBrowserDataApi(rpc); " +
      "In inline_ui: const browserData = createBrowserDataApi(chat.rpc);",
    );
  }

  _browserData = createBrowserDataApi(runtime.rpc);
  return _browserData;
}

/** Pre-initialized browser data API (lazy, uses runtime's RPC bridge) */
export const browserData: BrowserDataApi = new Proxy({} as BrowserDataApi, {
  get(_target, prop: string) {
    return (getBrowserData() as unknown as Record<string, unknown>)[prop];
  },
});
