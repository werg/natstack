/**
 * Panel ID generation utilities.
 *
 * Shared between PanelManager (Electron) and HeadlessPanelManager (server).
 * These functions are pure — no Electron or Node.js-specific dependencies
 * beyond `crypto.randomBytes`.
 */

import { randomBytes } from "crypto";

/**
 * Validate and sanitize a panel ID segment (e.g., a user-provided name).
 *
 * Valid segments must match ^[A-Za-z0-9][A-Za-z0-9_~-]*$ (1–64 chars):
 *   - Must start with an alphanumeric character (no leading hyphens, underscores, or dots)
 *   - May contain letters, digits, underscores, hyphens, and tildes
 *   - Tilde is explicitly included because the system itself generates segments of the
 *     form `<page>~<timestamp36>` for about-panels (e.g. "new~lk2f8g")
 *   - The strict allow-list implicitly rejects `.`, `..`, `...`, path separators
 *     (`/`, `\`), and any other shell-special characters — closing a path-traversal
 *     gap where the previous deny-list omitted `..`
 *
 * @decision DEC-01: Allow-list regex over deny-list
 * @rationale: The original deny-list rejected `.`, `/`, `\` but silently allowed `..`,
 *   which breaks the invariant that panel IDs are clean slash-segmented tree paths relied
 *   on by CDP ancestor checks, git-auth prefix checks, and typecheck source extraction.
 *   An allow-list is more robust: unknown-bad inputs are rejected by default.
 */
// Replaced deny-list with strict allow-list to close the `..` path-traversal gap.
// Tilde retained for system-generated about-panel segments.
const VALID_PANEL_ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_~-]*$/;

export function sanitizePanelIdSegment(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed || !VALID_PANEL_ID_SEGMENT.test(trimmed)) {
    throw new Error(`Invalid panel identifier segment: ${segment}`);
  }
  return trimmed;
}

/**
 * Generate a unique nonce for panel ID generation.
 * Format: base36-timestamp-hexrandom (e.g., "lk2f8g-3a1b9c4e")
 */
export function generatePanelNonce(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/**
 * Compute a deterministic panel ID from a source path, optional parent, and
 * optional requested name.
 *
 * ID scheme:
 * - Root panels: `tree/{escapedPath}`
 * - Named children: `{parentId}/{name}`
 * - Auto-named children: `{parentId}/{escapedPath}/{nonce}`
 *
 * @param parent - Only needs `{ id: string }`. Pass null/undefined for root.
 */
export function computePanelId(params: {
  relativePath: string;
  parent?: { id: string } | null;
  requestedId?: string;
  isRoot?: boolean;
}): string {
  const { relativePath, parent, requestedId, isRoot } = params;

  // Escape slashes in path to avoid collisions
  const escapedPath = relativePath.replace(/\//g, "~");

  if (isRoot) {
    if (requestedId) {
      const segment = sanitizePanelIdSegment(requestedId);
      return `tree/${segment}`;
    }
    const nonce = generatePanelNonce();
    return `tree/${escapedPath}/${nonce}`;
  }

  // Parent prefix: use parent's full ID, or "tree" for root panels
  const parentPrefix = parent?.id ?? "tree";

  if (requestedId) {
    const segment = sanitizePanelIdSegment(requestedId);
    return `${parentPrefix}/${segment}`;
  }

  const autoSegment = generatePanelNonce();
  return `${parentPrefix}/${escapedPath}/${autoSegment}`;
}
