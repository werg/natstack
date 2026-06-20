/**
 * @workspace/panel-browser — Typed browser data API for panel eval context.
 *
 * Usage from eval:
 *   import { browserData } from "@workspace/panel-browser";
 *   const browsers = await browserData.detectBrowsers();
 *
 * Or explicitly with an RPC client:
 *   import { createBrowserDataApi } from "@workspace/panel-browser";
 *   import { rpc } from "@workspace/runtime";
 *   const browserData = createBrowserDataApi(rpc);
 *
 * Note: `openPanel(url)` (for opening external URL panels with CDP access)
 * is available from `@workspace/runtime`, not this package.
 */
import type { RpcClient } from "@natstack/rpc";
import { createExtensionProxy } from "@natstack/extension";
// Resolve the host RPC client through the module system, NOT
// `globalThis.__natstackRequire__`. A normal import is externalized by the build
// and resolved via the bundle's own require — which maps to the panel runtime in
// a panel and to the EvalDO's per-owner runtime in eval. Reaching for the global
// require only works in panels (where `@workspace/runtime` sits in the per-isolate
// global map); the eval sandbox keeps each owner's runtime in a per-object map, so
// the global lookup misses there.
import { rpc as runtimeRpc } from "@workspace/runtime";
// ---- Types (mirrored from @natstack/browser-data for browser context) ----
export type BrowserName = "firefox" | "zen" | "chrome" | "chrome-beta" | "chrome-dev" | "chrome-canary" | "chromium" | "edge" | "edge-beta" | "edge-dev" | "brave" | "vivaldi" | "opera" | "opera-gx" | "arc" | "safari";
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
export type ImportDataType = "bookmarks" | "history" | "cookies" | "passwords" | "autofill" | "searchEngines" | "extensions" | "permissions" | "settings" | "favicons";
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
    // Export
    exportBookmarks(format: "html" | "json" | "chrome-json"): Promise<string>;
    exportPasswords(format: "csv-chrome" | "csv-firefox" | "json"): Promise<string>;
    exportCookies(format: "json" | "netscape-txt"): Promise<string>;
    exportAll(): Promise<string>;
}
const BROWSER_DATA_EXTENSION = "@workspace-extensions/browser-data";
export function createBrowserDataApi(rpc: Pick<RpcClient, "call" | "stream">): BrowserDataApi {
    if (!rpc) {
        throw new Error("createBrowserDataApi requires an RPC client. " +
            "In eval context: import { rpc } from '@workspace/runtime'. " +
            "In inline_ui components: use chat.rpc.");
    }
    // browser-data is an extension reached over the extension host. Route through
    // the canonical extension proxy (typed against our own BrowserDataApi) rather
    // than hand-rolling the invoke envelope. It exposes no streaming methods, so
    // every call goes through extensions.invoke.
    return createExtensionProxy<BrowserDataApi>(rpc, BROWSER_DATA_EXTENSION, () => false);
}
// Auto-initialize from the host runtime's RPC client (imported above). Routing
// to the correct backend (Electron IPC vs server WebSocket vs eval DO) is handled
// by the runtime/transport layer — callers don't need to know where browser-data
// lives. Lazy so the API is built on first use, after the runtime is ready.
let _browserData: BrowserDataApi | undefined;
export function getBrowserData(): BrowserDataApi {
    if (_browserData)
        return _browserData;
    _browserData = createBrowserDataApi(runtimeRpc);
    return _browserData;
}
/** Pre-initialized browser data API (lazy, uses runtime's RPC bridge) */
export const browserData: BrowserDataApi = new Proxy({} as BrowserDataApi, {
    get(_target, prop: string) {
        const api = getBrowserData() as unknown as Record<string, unknown>;
        const value = api[prop];
        if (value === undefined && !(prop in api)) {
            const methods = Object.keys(api).join(", ");
            throw new Error(`browserData.${prop} is not a method. Available methods: ${methods}`);
        }
        return value;
    },
});
