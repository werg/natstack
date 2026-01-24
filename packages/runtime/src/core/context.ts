/**
 * Context ID utilities for NatStack panels and workers.
 *
 * Two formats are supported:
 *
 * 1. Template-based (safe panels ONLY):
 *    safe_tpl_{templateSpecHash}_{instanceId}
 *
 * 2. Unsafe no-context (unsafe panels without templates):
 *    unsafe_noctx_{instanceId}
 *
 * Note: unsafe_tpl_* is INVALID - unsafe panels cannot have templates.
 */

/** Security mode of a context */
export type ContextMode = "safe" | "unsafe";

/** Parsed components of a context ID */
export interface ParsedContextId {
  mode: ContextMode;
  /** Template spec hash, or null for unsafe no-context IDs */
  templateSpecHash: string | null;
  instanceId: string;
}

/**
 * Parse a context ID into its components.
 * Returns null if the context ID is invalid.
 *
 * Handles two formats:
 * - Template-based: {mode}_tpl_{hash}_{instanceId}
 * - Unsafe no-context: unsafe_noctx_{instanceId}
 *
 * @example
 * ```ts
 * const parsed = parseContextId("safe_tpl_a1b2c3d4e5f6_panels~editor");
 * // { mode: "safe", templateSpecHash: "a1b2c3d4e5f6", instanceId: "panels~editor" }
 *
 * const unsafe = parseContextId("unsafe_noctx_panels~terminal");
 * // { mode: "unsafe", templateSpecHash: null, instanceId: "panels~terminal" }
 *
 * const invalid = parseContextId("invalid");
 * // null
 * ```
 */
export function parseContextId(contextId: string): ParsedContextId | null {
  // Safe template-based format: safe_tpl_{hash}_{instanceId}
  // Note: only safe_tpl_* is valid - unsafe panels cannot have templates
  const tplMatch = contextId.match(/^safe_tpl_([a-f0-9]{12})_(.+)$/);
  if (tplMatch && tplMatch[1] && tplMatch[2]) {
    return {
      mode: "safe",
      templateSpecHash: tplMatch[1],
      instanceId: tplMatch[2],
    };
  }

  // Unsafe no-context format: unsafe_noctx_{instanceId}
  const noctxMatch = contextId.match(/^unsafe_noctx_(.+)$/);
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
 *
 * @example
 * ```ts
 * isSafeContext("safe_tpl_a1b2c3d4e5f6_panels~editor"); // true
 * isSafeContext("unsafe_noctx_panels~terminal"); // false
 * ```
 */
export function isSafeContext(contextId: string): boolean {
  const parsed = parseContextId(contextId);
  return parsed?.mode === "safe";
}

/**
 * Check if a context is unsafe (has Node.js access).
 *
 * @example
 * ```ts
 * isUnsafeContext("unsafe_noctx_panels~terminal"); // true
 * isUnsafeContext("safe_tpl_a1b2c3d4e5f6_panels~editor"); // false
 * ```
 */
export function isUnsafeContext(contextId: string): boolean {
  const parsed = parseContextId(contextId);
  return parsed?.mode === "unsafe";
}

/**
 * Get the template spec hash from a context ID.
 * Returns null for unsafe no-context IDs (they don't have templates).
 *
 * @example
 * ```ts
 * getTemplateSpecHash("safe_tpl_a1b2c3d4e5f6_panels~editor"); // "a1b2c3d4e5f6"
 * getTemplateSpecHash("unsafe_noctx_panels~terminal"); // null
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
