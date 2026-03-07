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
 */
export function sanitizePanelIdSegment(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed || trimmed === "." || trimmed.includes("/") || trimmed.includes("\\")) {
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
    return `tree/${escapedPath}`;
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

/**
 * Convert a contextId to a valid DNS subdomain label.
 *
 * Modern browsers (Chrome 73+, Firefox 84+) resolve *.localhost → 127.0.0.1
 * per the WHATWG URL Standard, giving each subdomain a distinct origin. This
 * means panels on different contexts get browser-enforced isolation of
 * localStorage, IndexedDB, cookies, and service workers — matching
 * Electron's persist:{contextId} partition behaviour.
 */
export function contextIdToSubdomain(contextId: string): string {
  const label = contextId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
  return label || "default";
}
