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
  /** Pass a DetectedProfile object or a profile path string. */
  profile?: DetectedProfile | string;
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

/**
 * Call function signature: (method, ...args) → Promise.
 * Both the Electron IPC path and the RPC bridge path satisfy this shape.
 */
type ServiceCallFn = <T = unknown>(method: string, ...args: unknown[]) => Promise<T>;

function buildApi(call: ServiceCallFn): BrowserDataApi {
  return {
    // Detection
    detectBrowsers: () => call(`${SVC}.detectBrowsers`),

    // Import
    startImport: (request) => call(`${SVC}.startImport`, request),
    getImportHistory: () => call(`${SVC}.getImportHistory`),

    // Bookmarks
    getBookmarks: (folderPath?) => call(`${SVC}.getBookmarks`, folderPath),
    addBookmark: (bookmark) => call(`${SVC}.addBookmark`, bookmark),
    updateBookmark: (id, partial) => call(`${SVC}.updateBookmark`, id, partial),
    deleteBookmark: (id) => call(`${SVC}.deleteBookmark`, id),
    moveBookmark: (id, folder, pos) => call(`${SVC}.moveBookmark`, id, folder, pos),
    searchBookmarks: (query) => call(`${SVC}.searchBookmarks`, query),

    // History
    getHistory: (query) => call(`${SVC}.getHistory`, query),
    deleteHistoryEntry: (id) => call(`${SVC}.deleteHistoryEntry`, id),
    deleteHistoryRange: (start, end) => call(`${SVC}.deleteHistoryRange`, start, end),
    clearAllHistory: () => call(`${SVC}.clearAllHistory`),
    searchHistory: (query, limit?) => call(`${SVC}.searchHistory`, query, limit),

    // Passwords
    getPasswords: () => call(`${SVC}.getPasswords`),
    getPasswordForSite: (url) => call(`${SVC}.getPasswordForSite`, url),
    addPassword: (pw) => call(`${SVC}.addPassword`, pw),
    updatePassword: (id, partial) => call(`${SVC}.updatePassword`, id, partial),
    deletePassword: (id) => call(`${SVC}.deletePassword`, id),

    // Autofill
    getAutofillSuggestions: (field, prefix?) => call(`${SVC}.getAutofillSuggestions`, field, prefix),

    // Search Engines
    getSearchEngines: () => call(`${SVC}.getSearchEngines`),
    setDefaultEngine: (id) => call(`${SVC}.setDefaultEngine`, id),

    // Permissions
    getPermissions: (origin?) => call(`${SVC}.getPermissions`, origin),
    setPermission: (origin, perm, setting) => call(`${SVC}.setPermission`, origin, perm, setting),

    // Cookies
    getCookies: (domain?) => call(`${SVC}.getCookies`, domain),
    deleteCookie: (id) => call(`${SVC}.deleteCookie`, id),
    clearCookies: (domain?) => call(`${SVC}.clearCookies`, domain),
    syncCookiesToSession: (domain?) => call(`${SVC}.syncCookiesToSession`, domain),
    syncCookiesFromSession: (domain?) => call(`${SVC}.syncCookiesFromSession`, domain),

    // Export
    exportBookmarks: (format) => call(`${SVC}.exportBookmarks`, format),
    exportPasswords: (format) => call(`${SVC}.exportPasswords`, format),
    exportCookies: (format) => call(`${SVC}.exportCookies`, format),
    exportAll: () => call(`${SVC}.exportAll`),
  };
}

export function createBrowserDataApi(rpc: RpcBridge): BrowserDataApi {
  if (!rpc) {
    throw new Error(
      "createBrowserDataApi requires an RPC bridge. " +
      "In eval context: import { rpc } from '@workspace/runtime'. " +
      "In inline_ui components: use chat.rpc.",
    );
  }
  return buildApi((method, ...args) => rpc.call("main", method, ...args));
}

// Auto-initialize using the runtime's RPC bridge via __natstackRequire__
// (the module system for panel bundles and eval/inline_ui blocks).
// Routing to the correct backend (Electron IPC vs server WebSocket) is
// handled by the panel transport layer — callers don't need to know
// where browser-data lives.
let _browserData: BrowserDataApi | undefined;

export function getBrowserData(): BrowserDataApi {
  if (_browserData) return _browserData;

  const require = (globalThis as Record<string, unknown>)["__natstackRequire__"] as
    | ((id: string) => { rpc: RpcBridge })
    | undefined;
  if (!require) {
    throw new Error(
      "browserData requires __natstackRequire__ (panel runtime). " +
      "In other contexts, use: createBrowserDataApi(rpc)",
    );
  }

  const { rpc } = require("@workspace/runtime");
  _browserData = createBrowserDataApi(rpc);
  return _browserData;
}

/** Pre-initialized browser data API (lazy, uses runtime's RPC bridge) */
export const browserData: BrowserDataApi = new Proxy({} as BrowserDataApi, {
  get(_target, prop: string) {
    const api = getBrowserData() as unknown as Record<string, unknown>;
    const value = api[prop];
    if (value === undefined && !(prop in api)) {
      const methods = Object.keys(api).join(", ");
      throw new Error(
        `browserData.${prop} is not a method. Available methods: ${methods}`,
      );
    }
    return value;
  },
});
