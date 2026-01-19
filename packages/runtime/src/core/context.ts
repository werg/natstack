/**
 * Context ID utilities for NatStack panels and workers.
 *
 * Context IDs follow the format: {mode}_{type}_{identifier}
 * - mode: "safe" | "unsafe" - security context
 * - type: "auto" | "named" - auto = tree-derived, named = explicit
 * - identifier: escaped tree path or random string
 */

/** Security mode of a context */
export type ContextMode = "safe" | "unsafe";

/** How the context was determined */
export type ContextType = "auto" | "named";

/** Parsed components of a context ID */
export interface ParsedContextId {
  mode: ContextMode;
  type: ContextType;
  identifier: string;
}

/**
 * Parse a context ID into its components.
 * Returns null if the context ID is invalid.
 *
 * @example
 * ```ts
 * const parsed = parseContextId("safe_auto_panels~editor");
 * // { mode: "safe", type: "auto", identifier: "panels~editor" }
 *
 * const invalid = parseContextId("invalid");
 * // null
 * ```
 */
export function parseContextId(contextId: string): ParsedContextId | null {
  const match = contextId.match(/^(safe|unsafe)_(auto|named)_(.+)$/);
  if (!match || !match[1] || !match[2] || !match[3]) return null;
  return {
    mode: match[1] as ContextMode,
    type: match[2] as ContextType,
    identifier: match[3],
  };
}

/**
 * Check if a context ID is valid.
 *
 * @example
 * ```ts
 * isValidContextId("safe_auto_panels~editor"); // true
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
 * isSafeContext("safe_auto_panels~editor"); // true
 * isSafeContext("unsafe_auto_panels~terminal"); // false
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
 * isUnsafeContext("unsafe_auto_panels~terminal"); // true
 * isUnsafeContext("safe_auto_panels~editor"); // false
 * ```
 */
export function isUnsafeContext(contextId: string): boolean {
  const parsed = parseContextId(contextId);
  return parsed?.mode === "unsafe";
}

/**
 * Check if a context is auto-derived (from tree path, deterministic/resumable).
 *
 * @example
 * ```ts
 * isAutoContext("safe_auto_panels~editor"); // true
 * isAutoContext("safe_named_abc123"); // false
 * ```
 */
export function isAutoContext(contextId: string): boolean {
  const parsed = parseContextId(contextId);
  return parsed?.type === "auto";
}

/**
 * Check if a context is named (explicitly created, may be shared).
 *
 * @example
 * ```ts
 * isNamedContext("safe_named_abc123"); // true
 * isNamedContext("safe_auto_panels~editor"); // false
 * ```
 */
export function isNamedContext(contextId: string): boolean {
  const parsed = parseContextId(contextId);
  return parsed?.type === "named";
}
