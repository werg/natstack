/**
 * Context ID Generation and Parsing
 *
 * Two formats are supported:
 *
 * 1. Template-based (safe panels ONLY):
 *    safe_tpl_{templateSpecHash:12}_{instanceId}
 *    Example: safe_tpl_a1b2c3d4e5f6_panels~editor
 *
 * 2. Unsafe no-context (unsafe panels that don't use templates):
 *    unsafe_noctx_{instanceId}
 *    Example: unsafe_noctx_panels~terminal
 *
 * The instanceId captures everything after the last prefix,
 * so it can contain underscores itself.
 *
 * Note: unsafe_tpl_* is INVALID - unsafe panels cannot have templates.
 */

import { randomBytes } from "crypto";
import type { ContextMode, ParsedContextId } from "./types.js";

/**
 * Regex to parse safe template-based context IDs.
 * Only matches safe_tpl_* - unsafe panels cannot have templates.
 */
const SAFE_TEMPLATE_CONTEXT_ID_REGEX = /^safe_tpl_([a-f0-9]{12})_(.+)$/;

/**
 * Regex to parse unsafe no-context IDs.
 * Captures: instanceId (rest of string)
 */
const UNSAFE_NOCTX_REGEX = /^unsafe_noctx_(.+)$/;

/**
 * Parse a context ID into its components.
 * Handles both template-based and unsafe no-context formats.
 *
 * @param contextId - The context ID to parse
 * @returns Parsed components or null if not a valid context ID
 */
export function parseContextId(contextId: string): ParsedContextId | null {
  // Try safe template-based format first (only safe_tpl_* is valid for templates)
  const tplMatch = contextId.match(SAFE_TEMPLATE_CONTEXT_ID_REGEX);
  if (tplMatch && tplMatch[1] && tplMatch[2]) {
    return {
      mode: "safe",
      templateSpecHash: tplMatch[1],
      instanceId: tplMatch[2],
    };
  }

  // Try unsafe no-context format
  const noctxMatch = contextId.match(UNSAFE_NOCTX_REGEX);
  if (noctxMatch && noctxMatch[1]) {
    return {
      mode: "unsafe",
      templateSpecHash: null, // No template for unsafe no-context IDs
      instanceId: noctxMatch[1],
    };
  }

  return null;
}

/**
 * Check if a context ID is valid.
 *
 * @param contextId - The context ID to check
 * @returns true if the context ID matches one of the expected formats
 */
export function isValidContextId(contextId: string): boolean {
  return SAFE_TEMPLATE_CONTEXT_ID_REGEX.test(contextId) || UNSAFE_NOCTX_REGEX.test(contextId);
}

/**
 * Generate a context ID from template spec hash and instance identifier.
 *
 * @param mode - Security mode (safe or unsafe)
 * @param templateSpecHash - Full SHA256 hash of the template spec (will be truncated to 12 chars)
 * @param instanceId - Instance identifier (can contain underscores, but not empty)
 * @returns The generated context ID
 * @throws Error if instanceId is empty or contains invalid characters
 */
export function createContextId(
  mode: ContextMode,
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

  return `${mode}_tpl_${truncatedHash}_${instanceId}`;
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
  // Replace slashes with tildes (same convention as old contextId system)
  return panelId.replace(/\//g, "~");
}

/**
 * Validate that a context ID has the expected mode.
 * Throws if the context ID is invalid or mode doesn't match.
 *
 * @param contextId - The context ID to validate
 * @param expectedMode - The expected mode
 * @throws Error if the context ID is invalid or mode doesn't match
 */
export function validateContextIdMode(
  contextId: string,
  expectedMode: ContextMode
): void {
  const parsed = parseContextId(contextId);

  if (!parsed) {
    throw new Error(`Invalid context ID format: "${contextId}"`);
  }

  if (parsed.mode !== expectedMode) {
    throw new Error(
      `Context mode mismatch: expected ${expectedMode}, got ${parsed.mode} in "${contextId}"`
    );
  }
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

/**
 * Create a context ID for unsafe panels that don't participate in templates.
 * Format: unsafe_noctx_<sanitized-instanceId>
 *
 * This is a distinct format from template-based IDs (safe_tpl_xxx_yyy)
 * to prevent any confusion or collision.
 *
 * @param instanceId - Instance identifier (typically panelId or derived from it)
 * @returns The generated unsafe no-context ID
 * @throws Error if instanceId is empty after sanitization
 */
export function createUnsafeContextId(instanceId: string): string {
  // Sanitize instanceId: replace invalid chars with underscores
  const sanitized = instanceId.replace(/[^a-zA-Z0-9_~-]/g, "_");
  if (!sanitized) {
    throw new Error("Instance ID cannot be empty after sanitization");
  }
  return `unsafe_noctx_${sanitized}`;
}

/**
 * Check if a context ID is an unsafe no-context ID.
 *
 * @param contextId - The context ID to check
 * @returns true if the context ID is an unsafe no-context ID
 */
export function isUnsafeNoContextId(contextId: string): boolean {
  return contextId.startsWith("unsafe_noctx_");
}
