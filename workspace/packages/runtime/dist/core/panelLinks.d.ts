/**
 * Link builders for HTTP-based panel navigation.
 *
 * Panels are served at `http://{subdomain}.localhost:{port}/{source}/`.
 * These builders produce relative paths for same-context navigation or
 * absolute URLs for cross-context navigation (different subdomain).
 * Query parameters carry options like contextId, stateArgs, etc.
 */
export interface BuildPanelLinkOptions {
    /**
     * Context ID for storage partition sharing.
     * When provided, buildPanelLink produces an absolute URL with the correct
     * subdomain for cross-context navigation. Omit for same-context (relative URL).
     */
    contextId?: string;
    /** State arguments for the panel (user state, validated against manifest schema) */
    stateArgs?: Record<string, unknown>;
    /** Panel name/ID */
    name?: string;
    /** If true, immediately focus the new panel after creation */
    focus?: boolean;
}
/**
 * Convert a contextId to a valid DNS subdomain label.
 *
 * Shared between server (panelHttpServer.ts) and client (panelLinks.ts).
 */
export declare function contextIdToSubdomain(contextId: string): string;
/**
 * Build a URL for navigating to a panel.
 *
 * - Same-context (no contextId): returns a relative URL (e.g., "/panels/chat/")
 * - Cross-context (with contextId): returns an absolute URL with the target subdomain
 *   (e.g., "http://ctx-abc.localhost:5173/panels/chat/?stateArgs=...")
 *
 * @param source - Workspace-relative source path (e.g., "panels/editor")
 * @param options - Optional navigation options
 * @returns Relative or absolute URL
 *
 * @example
 * ```ts
 * // Same-context navigation (relative URL)
 * buildPanelLink("panels/editor")
 * // => "/panels/editor/"
 *
 * // Cross-context navigation (absolute URL)
 * buildPanelLink("panels/chat", { contextId: "abc-123", stateArgs: { foo: 1 } })
 * // => "http://abc-123.localhost:5173/panels/chat/?stateArgs=..."
 * ```
 */
export declare function buildPanelLink(source: string, options?: BuildPanelLinkOptions): string;
//# sourceMappingURL=panelLinks.d.ts.map