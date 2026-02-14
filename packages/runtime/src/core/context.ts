/**
 * Context ID utilities for NatStack panels and workers.
 *
 * Context IDs use the format:
 *    safe_tpl_{templateSpecHash}_{instanceId}
 *
 * All panels run in safe sandboxed mode with template-based contexts.
 */

/** Parsed components of a context ID */
export interface ParsedContextId {
  /** Template spec hash */
  templateSpecHash: string | null;
  instanceId: string;
}

/**
 * Parse a context ID into its components.
 * Returns null if the context ID is invalid.
 *
 * Format: safe_tpl_{hash}_{instanceId}
 *
 * @example
 * ```ts
 * const parsed = parseContextId("safe_tpl_a1b2c3d4e5f6_panels~editor");
 * // { templateSpecHash: "a1b2c3d4e5f6", instanceId: "panels~editor" }
 *
 * const invalid = parseContextId("invalid");
 * // null
 * ```
 */
export function parseContextId(contextId: string): ParsedContextId | null {
  const tplMatch = contextId.match(/^safe_tpl_([a-f0-9]{12})_(.+)$/);
  if (tplMatch && tplMatch[1] && tplMatch[2]) {
    return {
      templateSpecHash: tplMatch[1],
      instanceId: tplMatch[2],
    };
  }

  return null;
}

/**
 * Check if a context ID is valid.
 *
 * @example
 * ```ts
 * isValidContextId("safe_tpl_a1b2c3d4e5f6_panels~editor"); // true
 * isValidContextId("invalid"); // false
 * ```
 */
export function isValidContextId(contextId: string): boolean {
  return parseContextId(contextId) !== null;
}

/**
 * Check if a context is safe (runs in sandboxed context).
 * All contexts are safe - this always returns true for valid context IDs.
 *
 * @example
 * ```ts
 * isSafeContext("safe_tpl_a1b2c3d4e5f6_panels~editor"); // true
 * ```
 */
export function isSafeContext(contextId: string): boolean {
  return parseContextId(contextId) !== null;
}

/**
 * Get the template spec hash from a context ID.
 *
 * @example
 * ```ts
 * getTemplateSpecHash("safe_tpl_a1b2c3d4e5f6_panels~editor"); // "a1b2c3d4e5f6"
 * getTemplateSpecHash("invalid"); // null
 * ```
 */
export function getTemplateSpecHash(contextId: string): string | null {
  const parsed = parseContextId(contextId);
  return parsed?.templateSpecHash ?? null;
}

/**
 * Get the instance ID from a context ID.
 *
 * @example
 * ```ts
 * getInstanceId("safe_tpl_a1b2c3d4e5f6_panels~editor"); // "panels~editor"
 * getInstanceId("invalid"); // null
 * ```
 */
export function getInstanceId(contextId: string): string | null {
  const parsed = parseContextId(contextId);
  return parsed?.instanceId ?? null;
}
