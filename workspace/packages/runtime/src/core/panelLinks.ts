/**
 * Link builders for HTTP-based panel navigation.
 *
 * Panels are served at `http://{subdomain}.localhost:{port}/{source}/`.
 * These builders produce relative paths (e.g., `/panels/editor/`) that work
 * within the same subdomain origin. Query parameters carry options like
 * action, contextId, repoArgs, etc.
 */

import type { RepoArgSpec } from "./types.js";

export type PanelAction = "navigate" | "child";

export interface BuildPanelLinkOptions {
  /** Action: 'navigate' (default) replaces current panel, 'child' creates a new child */
  action?: PanelAction;
  /**
   * Context ID for storage partition sharing.
   * Panels with the same contextId share localStorage, IndexedDB, etc.
   * Omit to get an auto-generated isolated context.
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
 * Build a relative URL path for navigating to an app panel.
 *
 * @param source - Workspace-relative source path (e.g., "panels/editor")
 * @param options - Optional navigation options
 * @returns Relative path (e.g., "/panels/editor/" or "/panels/editor/?action=child")
 *
 * @example
 * ```ts
 * buildPanelLink("panels/editor")
 * // => "/panels/editor/"
 *
 * buildPanelLink("panels/editor", { action: "child" })
 * // => "/panels/editor/?action=child"
 * ```
 */
export function buildPanelLink(source: string, options?: BuildPanelLinkOptions): string {
  const encodedPath = encodeURIComponent(source).replace(/%2F/g, "/");
  const params = new URLSearchParams();

  if (options?.action && options.action !== "navigate") params.set("action", options.action);
  if (options?.contextId !== undefined) params.set("contextId", String(options.contextId));
  if (options?.repoArgs) params.set("repoArgs", JSON.stringify(options.repoArgs));
  if (options?.env) params.set("env", JSON.stringify(options.env));
  if (options?.stateArgs) params.set("stateArgs", JSON.stringify(options.stateArgs));
  if (options?.name) params.set("name", options.name);
  if (options?.focus) params.set("focus", "true");

  const query = params.toString();
  return `/${encodedPath}/${query ? `?${query}` : ""}`;
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
