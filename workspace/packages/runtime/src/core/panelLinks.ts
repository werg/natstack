/**
 * Link builders for HTTP-based panel navigation.
 *
 * Panels are served at `https?://{host}:{port}/{source}/`.
 * These builders produce relative paths for same-context navigation or
 * absolute URLs for cross-context navigation on the current managed host.
 * Query parameters carry options like contextId, stateArgs, etc.
 */

export interface BuildPanelLinkOptions {
  /**
   * Context ID for storage partition sharing.
   * When provided, buildPanelLink produces an absolute URL on the current
   * managed host for cross-context navigation. Omit for same-context
   * navigation (relative URL).
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
export function contextIdToSubdomain(contextId: string): string {
  const label = contextId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
  return label || "default";
}

/**
 * Build a URL for navigating to a panel.
 *
 * - Same-context (no contextId): returns a relative URL (e.g., "/panels/chat/")
 * - Cross-context (with contextId): returns an absolute URL on the current host
 *   (e.g., "https://natstack.example.com/panels/chat/?contextId=ctx-abc")
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
 * // => "https://natstack.example.com/panels/chat/?contextId=abc-123&stateArgs=..."
 * ```
 */
export function buildPanelLink(source: string, options?: BuildPanelLinkOptions): string {
  const encodedPath = encodeURIComponent(source).replace(/%2F/g, "/");
  const params = new URLSearchParams();

  if (options?.contextId !== undefined) params.set("contextId", String(options.contextId));
  if (options?.stateArgs) params.set("stateArgs", JSON.stringify(options.stateArgs));
  if (options?.name) params.set("name", options.name);
  if (options?.focus) params.set("focus", "true");

  const query = params.toString();
  const relativePath = `/${encodedPath}/${query ? `?${query}` : ""}`;

  // Cross-context: absolute URL on the current managed host
  if (options?.contextId) {
    if (typeof window === "undefined") return relativePath;
    return `${window.location.origin}${relativePath}`;
  }

  return relativePath;
}
