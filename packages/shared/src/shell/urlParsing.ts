/**
 * URL parsing utilities for panel URLs.
 *
 * Platform-independent helpers extracted from PanelView (Electron).
 * Used by both Electron and React Native to identify managed URLs
 * and parse panel navigation targets.
 */

export interface ParsedPanelUrl {
  source: string;
  contextId?: string;
  options: { name?: string; contextId?: string; focus?: boolean };
  stateArgs?: Record<string, unknown>;
}

interface ParsedUrlLike {
  hostname: string;
  pathname: string;
  queryParams: Map<string, string>;
}

function parseUrlLike(url: string): ParsedUrlLike | null {
  const match = url.match(/^(https?):\/\/([^/?#]+)([^?#]*)?(?:\?([^#]*))?(?:#.*)?$/i);
  if (!match) return null;

  const host = match[2] ?? "";
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  if (!hostname) return null;

  const pathname = match[3] && match[3].length > 0 ? match[3] : "/";
  const rawQuery = match[4] ?? "";
  const queryParams = new Map<string, string>();

  for (const part of rawQuery.split("&")) {
    if (!part) continue;
    const separatorIndex = part.indexOf("=");
    const rawKey = separatorIndex === -1 ? part : part.slice(0, separatorIndex);
    const rawValue = separatorIndex === -1 ? "" : part.slice(separatorIndex + 1);
    try {
      const key = decodeURIComponent(rawKey.replace(/\+/g, " "));
      const value = decodeURIComponent(rawValue.replace(/\+/g, " "));
      queryParams.set(key, value);
    } catch {
      return null;
    }
  }

  return {
    hostname,
    pathname,
    queryParams,
  };
}

/**
 * Check if a URL targets a managed host (with or without explicit port).
 *
 * @param url - The URL to check
 * @param externalHost - The managed host domain (e.g. "natstack.example.com")
 */
export function isManagedHost(url: string, externalHost: string): boolean {
  const parsed = parseUrlLike(url);
  if (!parsed) return false;
  return parsed.hostname.endsWith(`.${externalHost}`) || parsed.hostname === externalHost;
}

/**
 * Parse a panel URL into its constituent parts (source, contextId, options, stateArgs).
 * Returns null if the URL is not a valid panel URL.
 *
 * @param url - The URL to parse
 * @param externalHost - The managed host domain (e.g. "natstack.example.com")
 */
export function parsePanelUrl(url: string, externalHost: string): ParsedPanelUrl | null {
  const parsed = parseUrlLike(url);
  if (!parsed) return null;
  if (!parsed.hostname.endsWith(`.${externalHost}`) && parsed.hostname !== externalHost) return null;

  const match = parsed.pathname.match(/^\/([^/]+\/[^/]+)(\/.*)?$/);
  if (!match) return null;
  const source = match[1]!;
  if ((match[2] || "/") !== "/") return null;
  if (parsed.queryParams.has("_bk") || parsed.queryParams.has("pid") || parsed.queryParams.has("_fresh")) {
    return null;
  }

  const contextId = parsed.queryParams.get("contextId");
  const name = parsed.queryParams.get("name");
  const focus = parsed.queryParams.get("focus");
  const rawStateArgs = parsed.queryParams.get("stateArgs");

  return {
    source,
    contextId: contextId ?? undefined,
    options: {
      contextId: contextId ?? undefined,
      name: name ?? undefined,
      focus: focus === "true" || undefined,
    },
    stateArgs: rawStateArgs != null
      ? (() => {
          try {
            return JSON.parse(rawStateArgs) as Record<string, unknown>;
          } catch {
            return undefined;
          }
        })()
      : undefined,
  };
}
