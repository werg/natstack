/**
 * Context ID utilities for NatStack panels and workers.
 *
 * Context IDs use the format:
 *    ctx_{instanceId}
 *
 * All panels run in safe sandboxed mode.
 */
/** Parsed components of a context ID */
export interface ParsedContextId {
    instanceId: string;
}
/**
 * Parse a context ID into its components.
 * Returns null if the context ID is invalid.
 *
 * Format: ctx_{instanceId}
 *
 * @example
 * ```ts
 * const parsed = parseContextId("ctx_panels~editor");
 * // { instanceId: "panels~editor" }
 *
 * const invalid = parseContextId("invalid");
 * // null
 * ```
 */
export declare function parseContextId(contextId: string): ParsedContextId | null;
/**
 * Check if a context ID is valid.
 *
 * @example
 * ```ts
 * isValidContextId("ctx_panels~editor"); // true
 * isValidContextId("invalid"); // false
 * ```
 */
export declare function isValidContextId(contextId: string): boolean;
/**
 * Get the instance ID from a context ID.
 *
 * @example
 * ```ts
 * getInstanceId("ctx_panels~editor"); // "panels~editor"
 * getInstanceId("invalid"); // null
 * ```
 */
export declare function getInstanceId(contextId: string): string | null;
//# sourceMappingURL=context.d.ts.map