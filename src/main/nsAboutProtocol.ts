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

import type { ShellPage } from "../shared/ipc/types.js";

/**
 * Valid shell page names for ns-about:// protocol.
 */
export const VALID_ABOUT_PAGES: ShellPage[] = [
  "model-provider-config",
  "about",
  "keyboard-shortcuts",
  "help",
];

export interface ParsedNsAboutUrl {
  page: ShellPage;
}

/**
 * Check if a string is a valid shell page.
 */
export function isValidAboutPage(page: string): page is ShellPage {
  return VALID_ABOUT_PAGES.includes(page as ShellPage);
}

/**
 * Parse an ns-about:// URL into its components.
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

  if (!isValidAboutPage(page)) {
    throw new Error(`Invalid ns-about page: ${page}. Valid pages: ${VALID_ABOUT_PAGES.join(", ")}`);
  }

  return { page };
}

/**
 * Build an ns-about:// URL from a page name.
 */
export function buildNsAboutUrl(page: ShellPage): string {
  if (!isValidAboutPage(page)) {
    throw new Error(`Invalid about page: ${page}. Valid pages: ${VALID_ABOUT_PAGES.join(", ")}`);
  }
  return `ns-about://${page}`;
}
