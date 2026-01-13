/**
 * Page Content Extractor
 *
 * Extracts and summarizes content from browser panels for search indexing.
 * Uses webContents.executeJavaScript to extract text content.
 */

import type { WebContents } from "electron";
import { getPanelSearchIndex } from "./panelSearchIndex.js";

const MAX_CONTENT_LENGTH = 5000;
const EXTRACTION_DELAY_MS = 1000;

/** Debounce timers keyed by panel ID. */
const pendingExtractions = new Map<string, NodeJS.Timeout>();

/**
 * JavaScript to extract page content.
 * Runs in the browser panel's WebContents context.
 */
const EXTRACTION_SCRIPT = `
(function() {
  // Get page title
  const title = document.title || '';

  // Get meta description
  const metaDesc = document.querySelector('meta[name="description"]')?.content || '';

  // Get main content - try common content containers
  const contentSelectors = [
    'main',
    'article',
    '[role="main"]',
    '.content',
    '#content',
    '.post-content',
    '.article-content',
    '.entry-content',
  ];

  let mainContent = '';
  for (const selector of contentSelectors) {
    const el = document.querySelector(selector);
    if (el) {
      mainContent = el.innerText?.trim() || '';
      if (mainContent.length > 100) break;
    }
  }

  // Fallback to body if no main content found
  if (!mainContent || mainContent.length < 100) {
    // Remove script and style content
    const body = document.body.cloneNode(true);
    body.querySelectorAll('script, style, nav, header, footer, aside').forEach(el => el.remove());
    mainContent = body.innerText?.trim() || '';
  }

  // Get headings for keywords
  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .map(h => h.innerText?.trim())
    .filter(t => t && t.length > 0)
    .slice(0, 10)
    .join(' ');

  return {
    title,
    metaDesc,
    mainContent: mainContent.substring(0, ${MAX_CONTENT_LENGTH}),
    headings,
  };
})();
`;

/**
 * Extracted page content.
 */
interface ExtractedContent {
  title: string;
  metaDesc: string;
  mainContent: string;
  headings: string;
}

/**
 * Extract and index page content from a browser panel.
 * Debounced per panel to handle rapid navigation events.
 */
export function extractAndIndexPageContent(
  panelId: string,
  webContents: WebContents
): void {
  clearTimeout(pendingExtractions.get(panelId));

  const timer = setTimeout(async () => {
    pendingExtractions.delete(panelId);

    if (webContents.isDestroyed()) return;

    try {
      const content = (await webContents.executeJavaScript(
        EXTRACTION_SCRIPT,
        true
      )) as ExtractedContent;

      const summary = buildContentSummary(content);
      getPanelSearchIndex().updatePageContent(panelId, summary);
    } catch {
      // Ignore - page navigated or closed
    }
  }, EXTRACTION_DELAY_MS);

  pendingExtractions.set(panelId, timer);
}

/**
 * Build a searchable content summary from extracted content.
 */
function buildContentSummary(content: ExtractedContent): string {
  const parts: string[] = [];

  // Add meta description (often a good summary)
  if (content.metaDesc) {
    parts.push(content.metaDesc);
  }

  // Add headings as keywords
  if (content.headings) {
    parts.push(content.headings);
  }

  // Add main content (truncated)
  if (content.mainContent) {
    // Take first N words of main content
    const words = content.mainContent.split(/\s+/).slice(0, 200).join(" ");
    parts.push(words);
  }

  return parts.join(" ").substring(0, MAX_CONTENT_LENGTH);
}
