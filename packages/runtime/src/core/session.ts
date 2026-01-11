/**
 * Session ID utilities for NatStack panels and workers.
 *
 * Session IDs follow the format: {mode}_{type}_{identifier}
 * - mode: "safe" | "unsafe" - security context
 * - type: "auto" | "named" - auto = tree-derived, named = explicit
 * - identifier: escaped tree path or random string
 */

/** Security mode of a session */
export type SessionMode = "safe" | "unsafe";

/** How the session was determined */
export type SessionType = "auto" | "named";

/** Parsed components of a session ID */
export interface ParsedSessionId {
  mode: SessionMode;
  type: SessionType;
  identifier: string;
}

/**
 * Parse a session ID into its components.
 * Returns null if the session ID is invalid.
 *
 * @example
 * ```ts
 * const parsed = parseSessionId("safe_auto_panels~editor");
 * // { mode: "safe", type: "auto", identifier: "panels~editor" }
 *
 * const invalid = parseSessionId("invalid");
 * // null
 * ```
 */
export function parseSessionId(sessionId: string): ParsedSessionId | null {
  const match = sessionId.match(/^(safe|unsafe)_(auto|named)_(.+)$/);
  if (!match || !match[1] || !match[2] || !match[3]) return null;
  return {
    mode: match[1] as SessionMode,
    type: match[2] as SessionType,
    identifier: match[3],
  };
}

/**
 * Check if a session ID is valid.
 *
 * @example
 * ```ts
 * isValidSessionId("safe_auto_panels~editor"); // true
 * isValidSessionId("invalid"); // false
 * ```
 */
export function isValidSessionId(sessionId: string): boolean {
  return parseSessionId(sessionId) !== null;
}

/**
 * Check if a session is safe (runs in sandboxed context).
 *
 * @example
 * ```ts
 * isSafeSession("safe_auto_panels~editor"); // true
 * isSafeSession("unsafe_auto_panels~terminal"); // false
 * ```
 */
export function isSafeSession(sessionId: string): boolean {
  const parsed = parseSessionId(sessionId);
  return parsed?.mode === "safe";
}

/**
 * Check if a session is unsafe (has Node.js access).
 *
 * @example
 * ```ts
 * isUnsafeSession("unsafe_auto_panels~terminal"); // true
 * isUnsafeSession("safe_auto_panels~editor"); // false
 * ```
 */
export function isUnsafeSession(sessionId: string): boolean {
  const parsed = parseSessionId(sessionId);
  return parsed?.mode === "unsafe";
}

/**
 * Check if a session is auto-derived (from tree path, deterministic/resumable).
 *
 * @example
 * ```ts
 * isAutoSession("safe_auto_panels~editor"); // true
 * isAutoSession("safe_named_abc123"); // false
 * ```
 */
export function isAutoSession(sessionId: string): boolean {
  const parsed = parseSessionId(sessionId);
  return parsed?.type === "auto";
}

/**
 * Check if a session is named (explicitly created, may be shared).
 *
 * @example
 * ```ts
 * isNamedSession("safe_named_abc123"); // true
 * isNamedSession("safe_auto_panels~editor"); // false
 * ```
 */
export function isNamedSession(sessionId: string): boolean {
  const parsed = parseSessionId(sessionId);
  return parsed?.type === "named";
}
