/**
 * Context ID Generation and Parsing
 *
 * Format:
 *   safe_tpl_{templateSpecHash:12}_{instanceId}
 *   Example: safe_tpl_a1b2c3d4e5f6_panels~editor
 *
 * The instanceId captures everything after the last prefix,
 * so it can contain underscores itself.
 */

import { randomBytes } from "crypto";
import type { ParsedContextId } from "./types.js";

/**
 * Regex to parse template-based context IDs.
 */
const TEMPLATE_CONTEXT_ID_REGEX = /^safe_tpl_([a-f0-9]{12})_(.+)$/;

/**
 * Parse a context ID into its components.
 *
 * @param contextId - The context ID to parse
 * @returns Parsed components or null if not a valid context ID
 */
export function parseContextId(contextId: string): ParsedContextId | null {
  const match = contextId.match(TEMPLATE_CONTEXT_ID_REGEX);
  if (match && match[1] && match[2]) {
    return {
      templateSpecHash: match[1],
      instanceId: match[2],
    };
  }

  return null;
}

/**
 * Check if a context ID is valid.
 *
 * @param contextId - The context ID to check
 * @returns true if the context ID matches the expected format
 */
export function isValidContextId(contextId: string): boolean {
  return TEMPLATE_CONTEXT_ID_REGEX.test(contextId);
}

/**
 * Generate a context ID from template spec hash and instance identifier.
 *
 * @param templateSpecHash - Full SHA256 hash of the template spec (will be truncated to 12 chars)
 * @param instanceId - Instance identifier (can contain underscores, but not empty)
 * @returns The generated context ID
 * @throws Error if instanceId is empty or contains invalid characters
 */
export function createContextId(
  templateSpecHash: string,
  instanceId: string
): string {
  // Validate templateSpecHash
  if (!/^[a-f0-9]{12,}$/i.test(templateSpecHash)) {
    throw new Error(
      `Invalid template spec hash: must be at least 12 hex characters, got "${templateSpecHash}"`
    );
  }

  // Validate instanceId
  if (!instanceId || instanceId.length === 0) {
    throw new Error("Instance ID cannot be empty");
  }

  // Instance ID can contain most characters but should be filesystem-safe
  // Allow: alphanumeric, underscore, hyphen, dot, tilde
  if (!/^[a-zA-Z0-9_\-.~]+$/.test(instanceId)) {
    throw new Error(
      `Invalid instance ID: must contain only alphanumeric characters, underscores, hyphens, dots, and tildes, got "${instanceId}"`
    );
  }

  // Take first 12 characters of hash (lowercase)
  const truncatedHash = templateSpecHash.slice(0, 12).toLowerCase();

  return `safe_tpl_${truncatedHash}_${instanceId}`;
}

/**
 * Generate a unique instance ID for a new context.
 * Uses timestamp + random hex for uniqueness.
 *
 * @param prefix - Optional prefix for the instance ID
 * @returns A unique instance ID
 */
export function generateInstanceId(prefix?: string): string {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(4).toString("hex");
  const suffix = `${timestamp}-${random}`;

  return prefix ? `${prefix}-${suffix}` : suffix;
}

/**
 * Derive an instance ID from a panel ID.
 * Replaces slashes with tildes to create a deterministic, resumable ID.
 *
 * @param panelId - The panel ID to derive from
 * @returns A deterministic instance ID
 */
export function deriveInstanceIdFromPanelId(panelId: string): string {
  // Replace slashes and colons with tildes (same convention as old contextId system)
  // Colons appear in shell panel IDs (e.g., "shell:new~abc123")
  return panelId.replace(/[/:]/g, "~");
}

/**
 * Extract the template spec hash prefix from a context ID.
 * Useful for looking up template builds.
 *
 * @param contextId - The context ID
 * @returns The 12-character template spec hash prefix, or null if invalid
 */
export function getTemplateSpecHashFromContextId(
  contextId: string
): string | null {
  const parsed = parseContextId(contextId);
  return parsed?.templateSpecHash ?? null;
}
