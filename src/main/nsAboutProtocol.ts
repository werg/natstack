/**
 * Protocol parser for ns-about:// URLs.
 *
 * URL Format: ns-about://{page}
 *
 * Examples:
 *   ns-about://settings
 *   ns-about://about
 *   ns-about://help
 *   ns-about://keyboard-shortcuts
 *   ns-about://model-provider-config
 */

import type { ShellPage } from "../shared/types.js";

export interface ParsedNsAboutUrl {
  page: ShellPage;
}

/**
 * Parse an ns-about:// URL into its components.
 * About page names are dynamically discovered — no hardcoded validation.
 */
export function parseNsAboutUrl(url: string): ParsedNsAboutUrl {
  const parsed = new URL(url);
  if (parsed.protocol !== "ns-about:") {
    throw new Error(`Invalid ns-about URL protocol: ${parsed.protocol}`);
  }

  // Format: ns-about://page (hostname is the page name)
  const page = parsed.hostname;

  if (!page) {
    throw new Error(`Invalid ns-about URL: missing page (${url})`);
  }

  return { page };
}

/**
 * Build an ns-about:// URL from a page name.
 */
export function buildNsAboutUrl(page: ShellPage): string {
  return `ns-about://${page}`;
}
