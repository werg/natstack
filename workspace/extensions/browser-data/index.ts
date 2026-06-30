import {
  detectBrowsers,
  exportChromiumBookmarks,
  exportCsvPasswords,
  exportJson,
  exportNetscapeBookmarks,
  exportNetscapeCookies,
  previewImportPipeline,
  readOpenTabs,
  runImportPipeline,
} from "@workspace/browser-data";
import type { PreviewResult } from "@workspace/browser-data";
import { resolveProfilePath } from "@natstack/browser-data";
import type {
  BrowserOpenTabsRequest,
  ImportDataType,
  ImportRequest,
  ImportResult,
  ImportedAutofillEntry,
  ImportedBookmark,
  ImportedCookie,
  ImportedFavicon,
  ImportedHistoryEntry,
  ImportBatchMeta,
  ImportHistoryBatchMeta,
  ImportedOpenTab,
  ImportedPassword,
  ImportedPermission,
  ImportedSearchEngine,
  OpenTabsAsPanelsResult,
  RecordHistoryVisitRequest,
  UpdateHistoryTitleRequest,
} from "@natstack/browser-data";

interface InvocationLike {
  current(): {
    caller: { callerId?: string; callerKind: string };
    chainCaller?: { callerId: string; callerKind: string };
  } | null;
}

interface ApprovalDetailLike {
  label: string;
  value: string;
  format?: "plain" | "markdown" | "code";
}

/** Mirrors `UserlandApprovalRequest` from `@natstack/extension` (inlined to avoid a type-only dependency). */
interface UserlandApprovalRequestLike {
  subject: { id: string; label?: string };
  title: string;
  summary?: string;
  warning?: string;
  details?: ApprovalDetailLike[];
  severity?: "standard" | "dangerous";
  defaultAction?: "allow" | "deny";
  promptOptions?: "scoped" | "choices";
}

/** Mirrors `UserlandApprovalChoice` from `@natstack/extension`. */
type UserlandApprovalChoiceLike =
  | { kind: "choice"; choice: string }
  | { kind: "dismissed" }
  | { kind: "uncallable"; reason: string };

interface ExtensionContextLike {
  rpc: {
    call<T>(targetId: string, method: string, ...args: unknown[]): Promise<T>;
  };
  workers: {
    resolveDurableObject(source: string, className: string, objectKey: string): Promise<{ targetId: string }>;
  };
  invocation: InvocationLike;
  approvals: {
    request(req: UserlandApprovalRequestLike): Promise<UserlandApprovalChoiceLike>;
  };
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
 * Caller kinds that are trusted host infrastructure (the desktop shell's main
 * process — including the in-app history recorder and address-bar autocomplete —
 * and the server). They bypass the approval gate so first-party browsing never
 * prompts. Every other userland caller (panel/worker/do) is gated.
 */
const TRUSTED_CALLER_KINDS = new Set(["shell", "server"]);

/**
 * Methods gated behind a userland approval prompt instead of being shell-only.
 * Two axes: methods that REVEAL a secret value (cookies/passwords/full history/
 * exports) and methods that have a MODIFYING effect (imports, writes, deletes,
 * opening panels). Pure non-sensitive reads (detectBrowsers, bookmarks, search
 * engines, permissions, open-tab listing, import history, and the secret-free
 * "view" methods) are NOT gated. Trusted callers (see TRUSTED_CALLER_KINDS) skip
 * the prompt entirely.
 */
const GATED_METHODS = new Set<string>([
  // Sensitive value reads / exports
  "getCookies",
  "getPasswords",
  "getPasswordForSite",
  "getHistory",
  "searchHistory",
  "searchHistoryForAutocomplete",
  "getAutofillSuggestions",
  "getAutocompleteDebug",
  "exportBookmarks",
  "exportPasswords",
  "exportCookies",
  "exportAll",
  // Modifying effects
  "startImport",
  "openTabsAsPanels",
  "addBookmark",
  "updateBookmark",
  "deleteBookmark",
  "moveBookmark",
  "addPassword",
  "updatePassword",
  "updatePasswordLastUsed",
  "addNeverSavePassword",
  "recordHistoryVisit",
  "updateHistoryTitle",
  "setPermission",
  "setDefaultEngine",
  "deleteCookie",
  "clearCookies",
  "deletePassword",
  "deleteHistoryEntry",
  "deleteHistoryRange",
  "clearAllHistory",
]);

/** Methods whose approval is shown as dangerous (bulk secret egress or destructive). */
const DANGEROUS_METHODS = new Set<string>([
  "getCookies",
  "getPasswords",
  "getPasswordForSite",
  "exportBookmarks",
  "exportPasswords",
  "exportCookies",
  "exportAll",
  "deleteCookie",
  "clearCookies",
  "deletePassword",
  "deleteHistoryEntry",
  "deleteHistoryRange",
  "clearAllHistory",
]);

/** Human-facing labels for the approval prompt, keyed by method name. */
const METHOD_LABELS: Record<string, string> = {
  getCookies: "Read stored cookies",
  getPasswords: "Read stored passwords",
  getPasswordForSite: "Read the stored password for a site",
  getHistory: "Read full browsing history",
  searchHistory: "Search full browsing history",
  searchHistoryForAutocomplete: "Read browsing history for autocomplete",
  getAutofillSuggestions: "Read stored autofill values",
  getAutocompleteDebug: "Inspect address-bar autocomplete (full URLs)",
  exportBookmarks: "Export bookmarks",
  exportPasswords: "Export passwords",
  exportCookies: "Export cookies",
  exportAll: "Export all browser data",
  startImport: "Import browser data",
  openTabsAsPanels: "Open browser tabs as panels",
  addBookmark: "Add a bookmark",
  updateBookmark: "Modify a bookmark",
  deleteBookmark: "Delete a bookmark",
  moveBookmark: "Move a bookmark",
  addPassword: "Save a password",
  updatePassword: "Modify a saved password",
  updatePasswordLastUsed: "Update saved-password usage",
  addNeverSavePassword: "Add a never-save origin",
  recordHistoryVisit: "Record a history visit",
  updateHistoryTitle: "Update a history title",
  setPermission: "Change a site permission",
  setDefaultEngine: "Change the default search engine",
  deleteCookie: "Delete a cookie",
  clearCookies: "Clear cookies",
  deletePassword: "Delete a saved password",
  deleteHistoryEntry: "Delete a history entry",
  deleteHistoryRange: "Delete a range of history",
  clearAllHistory: "Clear all browsing history",
};

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

  const requireApproval = async (method: string): Promise<void> => {
    const caller = ctx.invocation.current()?.caller;
    const callerKind = caller?.callerKind;
    // Trusted host infrastructure (desktop shell, server) is never prompted.
    if (callerKind && TRUSTED_CALLER_KINDS.has(callerKind)) return;
    if (!caller || callerKind === "http") {
      const err = new Error(
        `browser-data.${method} requires a panel, worker, or DO caller`,
      ) as NodeJS.ErrnoException;
      err.code = "ENOCALLER";
      throw err;
    }
    const label = METHOD_LABELS[method] ?? method;
    const dangerous = DANGEROUS_METHODS.has(method);
    const choice = await ctx.approvals.request({
      subject: { id: `browser-data:${method}`, label },
      title: `${label}?`,
      summary: `A ${callerKind} (${caller.callerId}) is requesting to ${label.toLowerCase()}.`,
      ...(dangerous
        ? { warning: "This exposes or modifies sensitive imported browser data." }
        : {}),
      details: [
        { label: "Operation", value: method },
        { label: "Caller", value: `${callerKind}:${caller.callerId}` },
      ],
      severity: dangerous ? "dangerous" : "standard",
      defaultAction: "deny",
      promptOptions: "scoped",
    });
    if (choice.kind === "uncallable") {
      const err = new Error(
        `browser-data.${method} requires an interactive caller`,
      ) as NodeJS.ErrnoException;
      err.code = "ENOCALLER";
      throw err;
    }
    if (choice.kind === "dismissed" || choice.choice === "deny") {
      const err = new Error(`browser-data.${method} denied by user`) as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    }
  };

  const guarded = <Args extends unknown[], R>(method: string, fn: (...args: Args) => Promise<R>) =>
    async (...args: Args): Promise<R> => {
      if (GATED_METHODS.has(method)) await requireApproval(method);
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
    getOpenTabs: guarded("getOpenTabs", async (request: BrowserOpenTabsRequest) =>
      readOpenTabs(request)),
    openTabsAsPanels: guarded("openTabsAsPanels", async (request: BrowserOpenTabsRequest) =>
      openTabsAsPanels(request, ctx)),

    startImport: guarded("startImport", async (request: ImportRequest) =>
      importBrowserData(request, callStore, emitChanged, ctx)),

    getImportHistory: guarded("getImportHistory", async () => callStore("getImportHistory")),
    getProfileImportState: guarded("getProfileImportState", async (query: { browser: string; profilePath?: string; profile?: unknown }) =>
      callStore("getProfileImportState", {
        browser: query.browser,
        profilePath: query.profilePath ?? resolveProfilePath(query as ImportRequest),
      })),
    previewImport: guarded("previewImport", async (request: ImportRequest) =>
      previewBrowserData(request, callStore)),

    getCookieDomains: guarded("getCookieDomains", async () => callStore("getCookieDomains")),
    getHistoryDomains: guarded("getHistoryDomains", async (limit?: number) =>
      callStore("getHistoryDomains", limit)),
    getPasswordOrigins: guarded("getPasswordOrigins", async () => callStore("getPasswordOrigins")),
    getAutofillFieldNames: guarded("getAutofillFieldNames", async () =>
      callStore("getAutofillFieldNames")),
    getDomainReadiness: guarded("getDomainReadiness", async (domain: string) =>
      callStore("getDomainReadiness", domain)),
    getAutocompleteDebug: guarded("getAutocompleteDebug", async (query: string) =>
      getAutocompleteDebug(query, callStore)),

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

async function openTabsAsPanels(
  request: BrowserOpenTabsRequest,
  ctx: ExtensionContextLike,
): Promise<OpenTabsAsPanelsResult> {
  const allTabs = readOpenTabs(request);
  const selection = request.selection;
  const tabs = selection
    ? allTabs.filter((tab) =>
        selection.some((s) => s.windowIndex === tab.windowIndex && s.tabIndex === tab.tabIndex))
    : allTabs;
  const parentId = parentPanelIdFromInvocation(ctx.invocation.current());
  const panels: OpenTabsAsPanelsResult["panels"] = [];
  const skipped: OpenTabsAsPanelsResult["skipped"] = [];

  for (const tab of tabs) {
    if (!/^https?:\/\//i.test(tab.url)) {
      skipped.push({ url: tab.url, reason: "unsupported browser-panel URL scheme" });
      continue;
    }
    try {
      const created = await ctx.rpc.call<{ id: string; title: string }>(
        "main",
        "panelTree.create",
        tab.url,
        {
          ...(parentId ? { parentId } : {}),
          name: panelNameForOpenTab(tab),
          focus: false,
        },
      );
      panels.push({ id: created.id, title: created.title, url: tab.url });
    } catch (err) {
      skipped.push({
        url: tab.url,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    tabsFound: tabs.length,
    panelsOpened: panels.length,
    panels,
    skipped,
  };
}

function parentPanelIdFromInvocation(
  invocation: ReturnType<InvocationLike["current"]>,
): string | undefined {
  const caller = invocation?.chainCaller ?? invocation?.caller;
  if (!caller?.callerId) return undefined;
  if (
    caller.callerKind === "panel" ||
    caller.callerKind === "app" ||
    caller.callerKind === "worker" ||
    caller.callerKind === "do"
  ) {
    return caller.callerId;
  }
  return undefined;
}

function panelNameForOpenTab(tab: ImportedOpenTab): string {
  const fallback = hostnameFromUrl(tab.url) ?? "Imported Tab";
  const base = (tab.title?.trim() || fallback).replace(/\s+/g, " ").slice(0, 80);
  return `${base} (${tab.windowIndex + 1}.${tab.tabIndex + 1})`;
}

function hostnameFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

async function importBrowserData(
  request: ImportRequest,
  callStore: <T>(method: string, ...args: unknown[]) => Promise<T>,
  emitChanged: (dataType: ImportDataType | "passwords" | "searchEngines") => void,
  ctx: ExtensionContextLike,
): Promise<ImportResult[]> {
  const profilePath = resolveProfilePath(request);
  const meta: ImportBatchMeta = { browser: request.browser, profilePath };
  const store = {
    bookmarks: { addBatch: (items: ImportedBookmark[], m?: ImportBatchMeta) =>
      callStore<number>("addBookmarksBatch", items, m ?? meta) },
    history: { addBatch: (items: ImportedHistoryEntry[], m?: ImportHistoryBatchMeta) =>
      callStore<number>("addHistoryBatch", items, m ?? meta) },
    cookies: { addBatch: (items: ImportedCookie[]) => callStore<number>("addCookiesBatch", items, meta) },
    passwords: { addBatch: (items: ImportedPassword[]) => callStore<number>("addPasswordsBatch", items, meta) },
    autofill: { addBatch: (items: ImportedAutofillEntry[], m?: ImportBatchMeta) =>
      callStore<number>("addAutofillBatch", items, m ?? meta) },
    searchEngines: { addBatch: (items: ImportedSearchEngine[], m?: ImportBatchMeta) =>
      callStore<number>("addSearchEnginesBatch", items, m ?? meta) },
    permissions: { addBatch: (items: ImportedPermission[]) => callStore<number>("addPermissionsBatch", items, meta) },
    favicons: { addBatch: (items: ImportedFavicon[]) => callStore<number>("addFaviconsBatch", items, meta) },
  };
  const startedAt = Date.now();
  const results = await runImportPipeline(request, store);
  const finishedAt = Date.now();
  const failures = results.filter((result) => !result.success);
  await callStore("recordImportRun", {
    browser: request.browser,
    profilePath,
    mode: "import",
    status: failures.length === 0 ? "success" : failures.length === results.length ? "error" : "partial",
    startedAt,
    finishedAt,
    dataTypes: results.map((result) => result.dataType),
    warnings: results.flatMap((result) => result.warnings ?? []),
    summaries: results.map((result) => ({
      dataType: result.dataType,
      // Until the dry-run classifier lands, `added`/`changed`/`unchanged` are not
      // distinguishable here; record the counts the pipeline does produce.
      scanned: result.itemCount + result.skippedCount,
      skipped: result.skippedCount,
      errors: result.success ? 0 : 1,
    })),
  });
  for (const result of results) {
    if (result.success) emitChanged(result.dataType);
  }
  reportImportHealth(ctx, results);
  ctx.emit("import-complete", results);
  return results;
}

async function previewBrowserData(
  request: ImportRequest,
  callStore: <T>(method: string, ...args: unknown[]) => Promise<T>,
): Promise<PreviewResult[]> {
  return previewImportPipeline(request, (dataType, items, meta) =>
    callStore("classifyAgainstStore", dataType, items, meta));
}

interface AutocompleteDebugSuggestion {
  url?: string;
  title?: string;
  keyword?: string;
  source: "history" | "bookmark" | "search-engine";
  score: number;
  reasons: string[];
}

/**
 * Returns the ranked address-bar candidates for `query` with a transparent
 * score breakdown. Mirrors the scoring weights in panelChrome.ts so the panel's
 * debugger explains why each suggestion ranks where it does. Session/open-panel
 * suggestions are added client-side (panels are not visible from the extension).
 */
async function getAutocompleteDebug(
  query: string,
  callStore: <T>(method: string, ...args: unknown[]) => Promise<T>,
): Promise<{ query: string; suggestions: AutocompleteDebugSuggestion[] }> {
  const normalized = query.trim().toLowerCase();
  const [history, bookmarks, engines] = await Promise.all([
    callStore<Array<Record<string, unknown>>>("searchHistoryForAutocomplete", { query, limit: 25 }),
    callStore<Array<Record<string, unknown>>>("searchBookmarks", query),
    callStore<Array<Record<string, unknown>>>("getSearchEngines"),
  ]);

  const scoreEntry = (
    source: "history" | "bookmark",
    url: string,
    title: string,
    typedCount: number,
    visitCount: number,
    lastVisit: number,
  ): AutocompleteDebugSuggestion => {
    const haystacks = [url.toLowerCase(), title.toLowerCase()];
    const reasons: string[] = [];
    let score = 0;
    if (normalized && haystacks.some((h) => h === normalized)) {
      score += 500_000_000_000_000;
      reasons.push("exact match");
    } else if (normalized && haystacks.some((h) => h.startsWith(normalized))) {
      score += 100_000_000_000_000;
      reasons.push("prefix match");
    } else if (normalized && haystacks.some((h) => h.includes(normalized))) {
      score += 10_000_000_000_000;
      reasons.push("substring match");
    }
    const sourceBoost = source === "bookmark" ? 500_000_000_000 : 100_000_000_000;
    score += sourceBoost;
    reasons.push(`source: ${source}`);
    if (typedCount > 0) {
      score += typedCount * 10_000_000_000;
      reasons.push(`typed ${typedCount}×`);
    }
    if (visitCount > 0) {
      score += visitCount * 1_000_000;
      reasons.push(`${visitCount} visits`);
    }
    score += lastVisit;
    return { url, title, source, score, reasons };
  };

  const suggestions: AutocompleteDebugSuggestion[] = [];
  for (const h of history) {
    suggestions.push(
      scoreEntry(
        "history",
        String(h["url"] ?? ""),
        String(h["title"] ?? ""),
        Number(h["typed_count"] ?? 0),
        Number(h["visit_count"] ?? 0),
        Number(h["last_visit"] ?? 0),
      ),
    );
  }
  for (const b of bookmarks) {
    suggestions.push(
      scoreEntry("bookmark", String(b["url"] ?? ""), String(b["title"] ?? ""), 0, 0, Number(b["date_added"] ?? 0)),
    );
  }
  for (const e of engines) {
    const keyword = String(e["keyword"] ?? "");
    if (!keyword) continue;
    if (normalized && (keyword.toLowerCase() === normalized || keyword.toLowerCase().startsWith(normalized))) {
      suggestions.push({
        source: "search-engine",
        keyword,
        title: String(e["name"] ?? keyword),
        score: 1_000_000_000_000,
        reasons: [`keyword "${keyword}"`],
      });
    }
  }

  suggestions.sort((a, b) => b.score - a.score);
  return { query, suggestions: suggestions.slice(0, 20) };
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
    source: request.source ?? "natstack",
    panelId: request.panelId?.trim() || undefined,
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
