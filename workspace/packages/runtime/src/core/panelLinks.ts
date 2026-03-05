/**
 * Link builders for HTTP-based panel navigation.
 *
 * Panels are served at `http://{subdomain}.localhost:{port}/{source}/`.
 * These builders produce relative paths for same-context navigation or
 * absolute URLs for cross-context navigation (different subdomain).
 * Query parameters carry options like contextId, repoArgs, etc.
 */

import type { RepoArgSpec } from "./types.js";

export interface BuildPanelLinkOptions {
  /**
   * Context ID for storage partition sharing.
   * When provided, buildPanelLink produces an absolute URL with the correct
   * subdomain for cross-context navigation. Omit for same-context (relative URL).
   */
  contextId?: string;
  /** Repo arguments required by the target manifest */
  repoArgs?: Record<string, RepoArgSpec>;
  /** Environment variables to pass to the panel (system config) */
  env?: Record<string, string>;
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
export function buildPanelLink(source: string, options?: BuildPanelLinkOptions): string {
  const encodedPath = encodeURIComponent(source).replace(/%2F/g, "/");
  const params = new URLSearchParams();

  if (options?.contextId !== undefined) params.set("contextId", String(options.contextId));
  if (options?.repoArgs) params.set("repoArgs", JSON.stringify(options.repoArgs));
  if (options?.env) params.set("env", JSON.stringify(options.env));
  if (options?.stateArgs) params.set("stateArgs", JSON.stringify(options.stateArgs));
  if (options?.name) params.set("name", options.name);
  if (options?.focus) params.set("focus", "true");

  const query = params.toString();
  const relativePath = `/${encodedPath}/${query ? `?${query}` : ""}`;

  // Cross-context: absolute URL with target subdomain
  if (options?.contextId) {
    const subdomain = contextIdToSubdomain(options.contextId);
    // Derive port from current page context (works in both Electron and browser)
    const port = typeof window !== "undefined" ? window.location.port : "";
    const portSuffix = port ? `:${port}` : "";
    return `http://${subdomain}.localhost${portSuffix}${relativePath}`;
  }

  return relativePath;
}

/**
 * Build a relative URL path for navigating to a shell page.
 *
 * @param page - The shell page name (e.g., "about", "model-provider-config")
 * @returns Relative path (e.g., "/about/about/")
 */
export function buildShellLink(page: string): string {
  return `/about/${encodeURIComponent(page)}/`;
}
