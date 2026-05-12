import type { BranchInfo, CommitInfo, Panel, PanelNavigationState, PanelSnapshot, WorkspaceNode } from "./types.js";
import { getCurrentSnapshot, getPanelHistoryState, getPanelRef } from "./panel/accessors.js";

export type PanelSourceKind = "panel" | "browser";

export interface PanelRepoState {
  repoPath?: string;
  branch?: string | null;
  commit?: string | null;
  dirty?: boolean;
}

export interface PanelChromeState {
  panelId: string;
  title: string;
  kind: PanelSourceKind;
  source: string;
  contextId: string;
  displayAddress: string;
  editableAddress: string;
  browserUrl?: string;
  resolvedUrl?: string;
  ref?: string;
  repo?: PanelRepoState;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface PanelSourceSuggestion {
  source: string;
  title?: string;
  kind: "launchable" | "package" | "skill" | "repo" | "folder";
}

export interface PanelAddressOptions {
  source: string;
  suggestions: PanelSourceSuggestion[];
  repo?: PanelRepoState;
  branches: BranchInfo[];
  commits: CommitInfo[];
}

export interface BrowserAddressSuggestion {
  url: string;
  title?: string;
  visitCount?: number;
  typedCount?: number;
  lastVisit?: number;
  source: "history" | "session" | "bookmark" | "search-engine";
  engineId?: number;
  engineName?: string;
  keyword?: string;
  searchTemplate?: string;
}

export interface BrowserAddressOptions {
  query: string;
  suggestions: BrowserAddressSuggestion[];
}

export type AddressAction =
  | { type: "navigate-url"; url: string; recordAsTyped?: boolean }
  | { type: "search"; query: string; template: string; recordAsTyped: true }
  | { type: "keyword-search"; engineId: number; query: string; template: string; recordAsTyped: true }
  | { type: "panel-source"; source: string; ref?: string }
  | { type: "select-branch"; branch: string }
  | { type: "select-commit"; commit: string };

export interface TextMatchRange {
  start: number;
  end: number;
}

export interface TextMatchPart {
  text: string;
  highlighted: boolean;
}

export interface AddressAutocompleteBase {
  id: string;
  value: string;
  label: string;
  meta: string;
  iconKind: "globe" | "history" | "bookmark" | "search" | "branch" | "commit" | "panel" | "session";
  matchRanges?: {
    label?: TextMatchRange[];
    meta?: TextMatchRange[];
  };
  action: AddressAction;
}

export type AddressAutocompleteItem =
  | (AddressAutocompleteBase & {
      kind: "panel-source";
      panel: PanelSourceSuggestion;
    })
  | (AddressAutocompleteBase & {
      kind: "url" | "history" | "bookmark" | "session" | "search" | "search-engine";
      browser: BrowserAddressSuggestion;
    });

export interface BrowserHistoryAddressRow {
  url?: unknown;
  title?: unknown;
  visit_count?: unknown;
  visitCount?: unknown;
  typed_count?: unknown;
  typedCount?: unknown;
  last_visit?: unknown;
  lastVisit?: unknown;
}

export interface BrowserBookmarkAddressRow {
  id?: unknown;
  url?: unknown;
  title?: unknown;
  date_added?: unknown;
  dateAdded?: unknown;
}

export interface SearchEngineAddressRow {
  id?: unknown;
  name?: unknown;
  keyword?: unknown;
  search_url?: unknown;
  searchUrl?: unknown;
  is_default?: unknown;
  isDefault?: unknown;
}

export type AddressInputResult =
  | { type: "browser-url"; url: string }
  | { type: "panel-source"; source: string }
  | { type: "search"; query: string };

const BROWSER_SOURCE_PREFIX = "browser:";
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const PANEL_SOURCE_RE = /^(?:about|panels|packages|apps|templates|workers|skills|projects)\//;
const DEFAULT_SEARCH_TEMPLATE = "https://www.google.com/search?q=%s";

export function isBrowserPanelSource(source: string): boolean {
  return source.startsWith(BROWSER_SOURCE_PREFIX);
}

export function browserUrlFromPanelSource(source: string): string | null {
  return isBrowserPanelSource(source)
    ? source.slice(BROWSER_SOURCE_PREFIX.length)
    : null;
}

export function panelSourceFromBrowserUrl(url: string): string {
  return `${BROWSER_SOURCE_PREFIX}${url}`;
}

export function getPanelSourceKind(source: string): PanelSourceKind {
  return isBrowserPanelSource(source) ? "browser" : "panel";
}

export function getPanelDisplayAddress(panel: Pick<Panel, "id" | "history">, navigation?: PanelNavigationState): string {
  const snapshot = getCurrentSnapshot(panel);
  const source = snapshot.source;
  const browserUrl = browserUrlFromPanelSource(source);
  if (browserUrl) return navigation?.url || snapshot.resolvedUrl || browserUrl;
  return source;
}

export function getPanelEditableAddress(panel: Pick<Panel, "id" | "history">, navigation?: PanelNavigationState): string {
  return getPanelDisplayAddress(panel, navigation);
}

export function parseAddressInput(input: string): AddressInputResult | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (PANEL_SOURCE_RE.test(trimmed) && !/\s/.test(trimmed)) {
    return { type: "panel-source", source: trimmed.replace(/^\/+/, "").replace(/\/+$/, "") };
  }

  if (SCHEME_RE.test(trimmed)) {
    if (/^https?:\/\//i.test(trimmed)) return { type: "browser-url", url: trimmed };
    return { type: "search", query: trimmed };
  }

  if (!/\s/.test(trimmed) && looksLikeHostname(trimmed)) {
    return { type: "browser-url", url: `https://${trimmed}` };
  }

  return { type: "search", query: trimmed };
}

export function formatRepoChip(repo?: PanelRepoState): string | null {
  if (!repo) return null;
  const parts: string[] = [];
  if (repo.repoPath) parts.push(repo.repoPath);
  if (repo.branch) parts.push(repo.branch);
  if (repo.commit) parts.push(repo.commit.slice(0, 7));
  if (repo.dirty) parts.push("dirty");
  return parts.length > 0 ? parts.join(" @ ") : null;
}

export function collectPanelSourceSuggestions(nodes: WorkspaceNode[]): PanelSourceSuggestion[] {
  const suggestions: PanelSourceSuggestion[] = [];
  const visit = (node: WorkspaceNode) => {
    const kind: PanelSourceSuggestion["kind"] = node.launchable
      ? "launchable"
      : node.packageInfo
        ? "package"
        : node.skillInfo
          ? "skill"
          : node.isGitRepo
            ? "repo"
            : "folder";

    if (node.launchable || node.packageInfo || node.skillInfo || node.isGitRepo) {
      suggestions.push({
        source: node.path,
        title: node.launchable?.title ?? node.packageInfo?.name ?? node.skillInfo?.name ?? node.name,
        kind,
      });
    }

    for (const child of node.children) visit(child);
  };

  for (const node of nodes) visit(node);
  return suggestions.sort((a, b) => a.source.localeCompare(b.source));
}

export function filterPanelSourceSuggestions(
  suggestions: PanelSourceSuggestion[],
  query: string,
  limit = 50,
): PanelSourceSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();
  return suggestions
    .filter((item) =>
      !normalizedQuery ||
      item.source.toLowerCase().includes(normalizedQuery) ||
      item.title?.toLowerCase().includes(normalizedQuery)
    )
    .slice(0, limit);
}

export function normalizeBrowserAddressSuggestions(
  rows: BrowserHistoryAddressRow[],
  source: BrowserAddressSuggestion["source"] = "history",
): BrowserAddressSuggestion[] {
  const seen = new Set<string>();
  const suggestions: BrowserAddressSuggestion[] = [];
  for (const row of rows) {
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = typeof row.title === "string" ? row.title.trim() : "";
    suggestions.push({
      url,
      title: title || undefined,
      visitCount: readOptionalNumber(row.visitCount ?? row.visit_count),
      typedCount: readOptionalNumber(row.typedCount ?? row.typed_count),
      lastVisit: readOptionalNumber(row.lastVisit ?? row.last_visit),
      source,
    });
  }
  return suggestions;
}

export function normalizeBookmarkAddressSuggestions(rows: BrowserBookmarkAddressRow[]): BrowserAddressSuggestion[] {
  const seen = new Set<string>();
  const suggestions: BrowserAddressSuggestion[] = [];
  for (const row of rows) {
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = typeof row.title === "string" ? row.title.trim() : "";
    suggestions.push({
      url,
      title: title || undefined,
      lastVisit: readOptionalNumber(row.dateAdded ?? row.date_added),
      source: "bookmark",
    });
  }
  return suggestions;
}

export function normalizeSearchEngineAddressSuggestions(rows: SearchEngineAddressRow[]): BrowserAddressSuggestion[] {
  const suggestions: BrowserAddressSuggestion[] = [];
  for (const row of rows) {
    const searchTemplate = typeof (row.searchUrl ?? row.search_url) === "string"
      ? String(row.searchUrl ?? row.search_url).trim()
      : "";
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!searchTemplate || !name) continue;
    suggestions.push({
      url: searchTemplate,
      title: name,
      source: "search-engine",
      engineId: typeof row.id === "number" ? row.id : undefined,
      engineName: name,
      keyword: typeof row.keyword === "string" ? row.keyword.trim() || undefined : undefined,
      searchTemplate,
      typedCount: Number(row.isDefault ?? row.is_default) === 1 ? 1 : 0,
    });
  }
  return suggestions;
}

export function collectBrowserAddressSuggestionsFromPanels(panels: Panel[]): BrowserAddressSuggestion[] {
  const rows: BrowserHistoryAddressRow[] = [];
  const visit = (panel: Panel) => {
    const snapshot = getCurrentSnapshot(panel);
    const url = browserUrlFromPanelSource(snapshot.source);
    if (url) {
      rows.push({
        url: panel.navigation?.url ?? snapshot.resolvedUrl ?? url,
        title: panel.navigation?.pageTitle ?? panel.title,
      });
    }
    for (const child of panel.children) visit(child);
  };
  for (const panel of panels) visit(panel);
  return normalizeBrowserAddressSuggestions(rows, "session");
}

export function mergeBrowserAddressSuggestions(
  groups: BrowserAddressSuggestion[][],
  query = "",
  limit = 50,
): BrowserAddressSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();
  const byUrl = new Map<string, BrowserAddressSuggestion>();
  for (const group of groups) {
    for (const item of group) {
      if (item.source === "search-engine") {
        const key = `search-engine:${item.engineId ?? item.keyword ?? item.searchTemplate}`;
        if (!byUrl.has(key)) byUrl.set(key, item);
        continue;
      }
      if (!matchesBrowserAddressSuggestion(item, normalizedQuery)) continue;
      const key = canonicalizeUrlForAddress(item.url) ?? item.url;
      const existing = byUrl.get(key);
      if (!existing || scoreBrowserAddressSuggestion(item) > scoreBrowserAddressSuggestion(existing)) {
        byUrl.set(key, item);
      }
    }
  }
  return [...byUrl.values()]
    .sort((a, b) => scoreBrowserAddressSuggestion(b, normalizedQuery) - scoreBrowserAddressSuggestion(a, normalizedQuery))
    .slice(0, limit);
}

export function buildAddressAutocompleteItems(args: {
  kind: PanelSourceKind;
  input: string;
  panelSuggestions?: PanelSourceSuggestion[];
  browserSuggestions?: BrowserAddressSuggestion[];
  limit?: number;
  defaultSearchTemplate?: string;
}): AddressAutocompleteItem[] {
  const limit = args.limit ?? 8;
  if (args.kind === "panel") {
    return filterPanelSourceSuggestions(args.panelSuggestions ?? [], args.input, limit).map((panel) => ({
      id: `panel-source:${panel.source}`,
      kind: "panel-source",
      value: panel.source,
      label: panel.source,
      meta: panel.title ? `${panel.kind} · ${panel.title}` : panel.kind,
      iconKind: "panel",
      matchRanges: {
        label: findMatchRanges(panel.source, args.input),
        meta: findMatchRanges(panel.title ? `${panel.kind} · ${panel.title}` : panel.kind, args.input),
      },
      action: { type: "panel-source", source: panel.source },
      panel,
    }));
  }

  const items: AddressAutocompleteItem[] = [];
  const input = args.input.trim();
  const defaultSearchTemplate = args.browserSuggestions?.find((item) =>
    item.source === "search-engine" && item.typedCount === 1 && item.searchTemplate
  )?.searchTemplate ?? args.defaultSearchTemplate ?? DEFAULT_SEARCH_TEMPLATE;
  if (input) {
    const parsed = parseAddressInput(input);
    if (parsed?.type === "browser-url") {
      items.push(browserItem({
        kind: "url",
        browser: { url: parsed.url, source: "history" },
        label: `Go to ${parsed.url}`,
        meta: parsed.url,
        iconKind: "globe",
        query: input,
        action: { type: "navigate-url", url: parsed.url, recordAsTyped: true },
      }));
    } else {
      const searchQuery = parsed?.type === "search" ? parsed.query : input;
      items.push(browserItem({
        kind: "search",
        browser: { url: defaultSearchTemplate, title: searchQuery, source: "search-engine", searchTemplate: defaultSearchTemplate },
        label: `Search ${searchQuery}`,
        meta: "default search",
        iconKind: "search",
        query: input,
        action: { type: "search", query: searchQuery, template: defaultSearchTemplate, recordAsTyped: true },
      }));
    }
  }

  const keywordRows = buildKeywordSearchRows(args.browserSuggestions ?? [], input);
  const ranked = mergeBrowserAddressSuggestions([args.browserSuggestions ?? []], input, Math.max(limit * 2, limit))
    .filter((item) => item.source !== "search-engine")
    .slice(0, Math.max(0, limit - items.length - keywordRows.length));

  items.push(...keywordRows.slice(0, Math.max(0, limit - items.length)));
  items.push(...ranked.map((browser) => {
    const kind = browser.source === "session" ? "session" : browser.source === "bookmark" ? "bookmark" : "history";
    const label = browser.title || browser.url;
    const meta = browser.title ? browser.url : browser.source === "session" ? "open browser panel" : browser.source;
    return browserItem({
      kind,
      browser,
      label,
      meta,
      iconKind: browser.source === "session" ? "session" : browser.source === "bookmark" ? "bookmark" : "history",
      query: input,
      action: { type: "navigate-url", url: browser.url },
    });
  }));
  return items.slice(0, limit);
}

function getRefDisplay(ref?: string): string | undefined {
  return ref?.trim() || undefined;
}

export function buildPanelChromeState(args: {
  panel: Panel;
  navigation?: PanelNavigationState;
  repo?: PanelRepoState;
}): PanelChromeState {
  const navigation = args.navigation ?? args.panel.navigation ?? {};
  const snapshot: PanelSnapshot = getCurrentSnapshot(args.panel);
  const source = snapshot.source;
  const browserUrl = browserUrlFromPanelSource(source) ?? undefined;
  const kind = getPanelSourceKind(source);
  const displayAddress = getPanelDisplayAddress(args.panel, navigation);
  const history = getPanelHistoryState(args.panel);
  const ref = getRefDisplay(getPanelRef(args.panel));

  return {
    panelId: args.panel.id,
    title: navigation.pageTitle || args.panel.title,
    kind,
    source,
    contextId: snapshot.contextId,
    displayAddress: ref && kind === "panel" ? `${displayAddress} @ ${ref}` : displayAddress,
    editableAddress: getPanelEditableAddress(args.panel, navigation),
    browserUrl,
    resolvedUrl: navigation.url ?? snapshot.resolvedUrl ?? browserUrl,
    ref,
    repo: args.repo,
    isLoading: Boolean(navigation.isLoading),
    canGoBack: Boolean(navigation.canGoBack || history.canGoBack),
    canGoForward: Boolean(navigation.canGoForward || history.canGoForward),
  };
}

export interface AddressProviderGitAdapter {
  getWorkspaceTree(): Promise<{ children: WorkspaceNode[] }>;
  findRepoForPath(source: string): Promise<{ repoPath: string; relativePath: string } | null>;
  status(repoPath: string): Promise<PanelRepoState & { repoPath: string }>;
  listBranches(repoPath: string): Promise<BranchInfo[]>;
  listCommits(repoPath: string, ref: string, limit: number): Promise<CommitInfo[]>;
}

export interface AddressProviderBrowserDataAdapter {
  searchHistoryForAutocomplete(query: string, limit: number): Promise<BrowserHistoryAddressRow[]>;
  getHistory(query: { limit: number }): Promise<BrowserHistoryAddressRow[]>;
  searchBookmarks(query: string): Promise<BrowserBookmarkAddressRow[]>;
  getSearchEngines(): Promise<SearchEngineAddressRow[]>;
}

export async function getSharedPanelAddressOptions(args: {
  source: string;
  ref?: string;
  git?: AddressProviderGitAdapter | null;
}): Promise<PanelAddressOptions> {
  const { source, ref, git } = args;
  if (!git) return { source, suggestions: [], branches: [], commits: [] };

  const tree = await git.getWorkspaceTree();
  const suggestions = filterPanelSourceSuggestions(collectPanelSourceSuggestions(tree.children), source, 50);
  try {
    const repo = await git.findRepoForPath(source);
    if (!repo) return { source, suggestions, branches: [], commits: [] };
    const [status, branches] = await Promise.all([
      git.status(repo.repoPath),
      git.listBranches(repo.repoPath),
    ]);
    const currentBranch = ref || status.branch || branches.find((branch) => branch.current)?.name || "HEAD";
    const commits = await git.listCommits(repo.repoPath, currentBranch, 50);
    return {
      source,
      suggestions,
      repo: {
        repoPath: status.repoPath,
        branch: ref || status.branch,
        commit: status.commit,
        dirty: status.dirty,
      },
      branches,
      commits,
    };
  } catch {
    return { source, suggestions, branches: [], commits: [] };
  }
}

export async function getSharedBrowserAddressOptions(args: {
  query: string;
  panels: Panel[];
  browserData?: AddressProviderBrowserDataAdapter | null;
}): Promise<BrowserAddressOptions> {
  const sessionSuggestions = collectBrowserAddressSuggestionsFromPanels(args.panels);
  const browserData = args.browserData;
  if (!browserData) {
    return {
      query: args.query,
      suggestions: mergeBrowserAddressSuggestions([sessionSuggestions], args.query, 25),
    };
  }

  try {
    const trimmed = args.query.trim();
    const [historyRows, bookmarkRows, searchEngineRows] = await Promise.all([
      trimmed
        ? browserData.searchHistoryForAutocomplete(trimmed, 50)
        : browserData.getHistory({ limit: 50 }),
      trimmed ? browserData.searchBookmarks(trimmed) : Promise.resolve([]),
      browserData.getSearchEngines(),
    ]);
    return {
      query: args.query,
      suggestions: mergeBrowserAddressSuggestions([
        sessionSuggestions,
        normalizeBrowserAddressSuggestions(historyRows),
        normalizeBookmarkAddressSuggestions(bookmarkRows),
        normalizeSearchEngineAddressSuggestions(searchEngineRows),
      ], args.query, 50),
    };
  } catch {
    return {
      query: args.query,
      suggestions: mergeBrowserAddressSuggestions([sessionSuggestions], args.query, 25),
    };
  }
}

function looksLikeHostname(value: string): boolean {
  if (value.includes("/")) {
    const [host] = value.split("/");
    return Boolean(host && looksLikeHostname(host));
  }
  if (value === "localhost") return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(value)) return true;
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\:\d+)?$/i.test(value);
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function matchesBrowserAddressSuggestion(item: BrowserAddressSuggestion, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return item.url.toLowerCase().includes(normalizedQuery) ||
    Boolean(item.title?.toLowerCase().includes(normalizedQuery)) ||
    Boolean(item.keyword?.toLowerCase() === normalizedQuery.split(/\s+/, 1)[0]);
}

function scoreBrowserAddressSuggestion(item: BrowserAddressSuggestion, normalizedQuery = ""): number {
  const haystacks = [item.url, item.title ?? ""].map((value) => value.toLowerCase());
  const exactBoost = normalizedQuery && haystacks.some((value) => value === normalizedQuery) ? 500_000_000_000_000 : 0;
  const prefixBoost = normalizedQuery && haystacks.some((value) => value.startsWith(normalizedQuery)) ? 100_000_000_000_000 : 0;
  const substringBoost = normalizedQuery && haystacks.some((value) => value.includes(normalizedQuery)) ? 10_000_000_000_000 : 0;
  const sourceBoost =
    item.source === "session" ? 1_000_000_000_000 :
      item.source === "bookmark" ? 500_000_000_000 :
        item.source === "history" ? 100_000_000_000 :
          0;
  const typedBoost = (item.typedCount ?? 0) * 10_000_000_000;
  const visitBoost = (item.visitCount ?? 0) * 1_000_000;
  return exactBoost + prefixBoost + substringBoost + sourceBoost + typedBoost + visitBoost + (item.lastVisit ?? 0);
}

export function canonicalizeUrlForAddress(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";
    if ((parsed.protocol === "http:" && parsed.port === "80") || (parsed.protocol === "https:" && parsed.port === "443")) {
      parsed.port = "";
    }
    if (parsed.pathname === "/") parsed.pathname = "/";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function splitTextByMatchRanges(text: string, ranges?: TextMatchRange[]): TextMatchPart[] {
  if (!ranges?.length) return text ? [{ text, highlighted: false }] : [];
  const normalized = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(text.length, range.start)),
      end: Math.max(0, Math.min(text.length, range.end)),
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const parts: TextMatchPart[] = [];
  let cursor = 0;
  for (const range of normalized) {
    if (range.start < cursor) continue;
    if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start), highlighted: false });
    parts.push({ text: text.slice(range.start, range.end), highlighted: true });
    cursor = range.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), highlighted: false });
  return parts;
}

function browserItem(args: {
  kind: Extract<AddressAutocompleteItem["kind"], "url" | "history" | "bookmark" | "session" | "search" | "search-engine">;
  browser: BrowserAddressSuggestion;
  label: string;
  meta: string;
  iconKind: AddressAutocompleteBase["iconKind"];
  query: string;
  action: AddressAction;
}): AddressAutocompleteItem {
  return {
    id: `${args.kind}:${actionValue(args.action, args.browser.url)}:${args.label}`,
    kind: args.kind,
    value: actionValue(args.action, args.browser.url),
    label: args.label,
    meta: args.meta,
    iconKind: args.iconKind,
    matchRanges: {
      label: findMatchRanges(args.label, args.query),
      meta: findMatchRanges(args.meta, args.query),
    },
    action: args.action,
    browser: args.browser,
  };
}

function actionValue(action: AddressAction, fallback: string): string {
  if (action.type === "navigate-url") return action.url;
  if (action.type === "search" || action.type === "keyword-search") return action.query;
  if (action.type === "panel-source") return action.source;
  if (action.type === "select-branch") return action.branch;
  if (action.type === "select-commit") return action.commit;
  return fallback;
}

function buildKeywordSearchRows(suggestions: BrowserAddressSuggestion[], input: string): AddressAutocompleteItem[] {
  const [keyword, ...queryParts] = input.trim().split(/\s+/);
  const query = queryParts.join(" ").trim();
  if (!keyword || !query) return [];
  return suggestions
    .filter((item) => item.source === "search-engine" && item.keyword === keyword && item.searchTemplate && item.engineId !== undefined)
    .slice(0, 3)
    .map((engine) => browserItem({
      kind: "search-engine",
      browser: engine,
      label: `Search ${engine.engineName ?? engine.title ?? keyword} for ${query}`,
      meta: `${keyword} search`,
      iconKind: "search",
      query: input,
      action: {
        type: "keyword-search",
        engineId: engine.engineId!,
        query,
        template: engine.searchTemplate!,
        recordAsTyped: true,
      },
    }));
}

function findMatchRanges(text: string, query: string): TextMatchRange[] | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;
  const haystack = text.toLowerCase();
  const ranges: TextMatchRange[] = [];
  let start = 0;
  while (start < haystack.length) {
    const index = haystack.indexOf(needle, start);
    if (index === -1) break;
    ranges.push({ start: index, end: index + needle.length });
    start = index + needle.length;
  }
  return ranges.length ? ranges : undefined;
}
