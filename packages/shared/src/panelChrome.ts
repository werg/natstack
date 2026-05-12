import type { Panel, PanelNavigationState } from "./types.js";

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
  repo?: PanelRepoState;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export type AddressInputResult =
  | { type: "browser-url"; url: string }
  | { type: "panel-source"; source: string }
  | { type: "search"; query: string };

const BROWSER_SOURCE_PREFIX = "browser:";
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const PANEL_SOURCE_RE = /^(?:about|panels|packages|apps|templates|workers|skills)\//;

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

export function getPanelDisplayAddress(panel: Pick<Panel, "snapshot">, navigation?: PanelNavigationState): string {
  const source = panel.snapshot.source;
  const browserUrl = browserUrlFromPanelSource(source);
  if (browserUrl) return navigation?.url || panel.snapshot.resolvedUrl || browserUrl;
  return source;
}

export function getPanelEditableAddress(panel: Pick<Panel, "snapshot">, navigation?: PanelNavigationState): string {
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

export function buildPanelChromeState(args: {
  panel: Panel;
  navigation?: PanelNavigationState;
  repo?: PanelRepoState;
}): PanelChromeState {
  const navigation = args.navigation ?? args.panel.navigation ?? {};
  const source = args.panel.snapshot.source;
  const browserUrl = browserUrlFromPanelSource(source) ?? undefined;
  const kind = getPanelSourceKind(source);
  const displayAddress = getPanelDisplayAddress(args.panel, navigation);

  return {
    panelId: args.panel.id,
    title: navigation.pageTitle || args.panel.title,
    kind,
    source,
    contextId: args.panel.snapshot.contextId,
    displayAddress,
    editableAddress: getPanelEditableAddress(args.panel, navigation),
    browserUrl,
    resolvedUrl: navigation.url ?? args.panel.snapshot.resolvedUrl,
    repo: args.repo,
    isLoading: Boolean(navigation.isLoading),
    canGoBack: Boolean(navigation.canGoBack),
    canGoForward: Boolean(navigation.canGoForward),
  };
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
