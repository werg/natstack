/**
 * Protocol parser for ns-focus:// URLs.
 *
 * URL Format: ns-focus:///{panelId}
 *
 * This protocol is used to switch UI focus to an existing panel without navigating.
 *
 * Examples:
 *   ns-focus:///tree/root/editor-abc
 *   ns-focus:///tree/root/child-1/child-2
 */

export interface ParsedNsFocusUrl {
  panelId: string;
}

/**
 * Parse an ns-focus:// URL into its components.
 */
export function parseNsFocusUrl(url: string): ParsedNsFocusUrl {
  const parsed = new URL(url);
  if (parsed.protocol !== "ns-focus:") {
    throw new Error(`Invalid ns-focus URL protocol: ${parsed.protocol}`);
  }

  // Format: ns-focus:///panelId or ns-focus://panelId
  // Note: URLs like ns-focus://tree/root/x parse "tree" as host; support both.
  const rawPath = parsed.host
    ? `${parsed.host}${parsed.pathname}`
    : parsed.pathname.replace(/^\/+/, "");
  const panelId = decodeURIComponent(rawPath);

  if (!panelId) {
    throw new Error(`Invalid ns-focus URL: missing panel ID (${url})`);
  }

  return { panelId };
}

/**
 * Build an ns-focus:// URL from a panel ID.
 */
export function buildNsFocusUrl(panelId: string): string {
  const encodedId = encodeURIComponent(panelId).replace(/%2F/g, "/"); // keep slashes readable
  return `ns-focus:///${encodedId}`;
}
