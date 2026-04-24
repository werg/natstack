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

/**
 * Check if a URL targets the managed host (with or without explicit port).
 *
 * @param url - The URL to check
 * @param externalHost - The managed host domain (e.g. "natstack.example.com")
 */
export function isManagedHost(url: string, externalHost: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === externalHost;
  } catch {
    return false;
  }
}

/**
 * Parse a panel URL into its constituent parts (source, contextId, options, stateArgs).
 * Returns null if the URL is not a valid panel URL.
 *
 * @param url - The URL to parse
 * @param externalHost - The managed host domain (e.g. "natstack.example.com")
 */
export function parsePanelUrl(url: string, externalHost: string): ParsedPanelUrl | null {
  try {
    const u = new URL(url);
    if (u.hostname !== externalHost) return null;

    const match = u.pathname.match(/^\/([^/]+\/[^/]+)(\/.*)?$/);
    if (!match) return null;
    const source = match[1]!;
    if ((match[2] || "/") !== "/") return null;
    if (u.searchParams.has("_bk") || u.searchParams.has("pid") || u.searchParams.has("_fresh")) return null;

    return {
      source,
      contextId: u.searchParams.get("contextId") ?? undefined,
      options: {
        contextId: u.searchParams.get("contextId") ?? undefined,
        name: u.searchParams.get("name") ?? undefined,
        focus: u.searchParams.get("focus") === "true" || undefined,
      },
      stateArgs: u.searchParams.has("stateArgs")
        ? (() => {
            try {
              return JSON.parse(u.searchParams.get("stateArgs")!) as Record<string, unknown>;
            } catch {
              return undefined;
            }
          })()
        : undefined,
    };
  } catch {
    return null;
  }
}
