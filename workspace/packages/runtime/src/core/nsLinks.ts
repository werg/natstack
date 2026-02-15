/**
 * Link builders for the new browser-like navigation protocol.
 *
 * ns://        - Navigate to app panels
 * ns-about://  - Navigate to shell/about pages
 * ns-focus://  - Focus an existing panel without navigating
 */

import type { RepoArgSpec } from "./types.js";

export type NsAction = "navigate" | "child";

export interface BuildNsLinkOptions {
  /** Action: 'navigate' (default) replaces current panel, 'child' creates a new child */
  action?: NsAction;
  /**
   * Context ID configuration:
   * - true: generate a new unique context
   * - string: use that specific context ID for storage partition sharing
   */
  contextId?: boolean | string;
  /** Git ref (branch/tag/commit) for the panel source */
  gitRef?: string;
  /** Repo arguments required by the target manifest */
  repoArgs?: Record<string, RepoArgSpec>;
  /** Environment variables to pass to the panel (system config) */
  env?: Record<string, string>;
  /** State arguments for the panel (user state, validated against manifest schema) */
  stateArgs?: Record<string, unknown>;
  /** Panel name/ID */
  name?: string;
  /** If true, immediately focus the new panel after creation (only applies to action=child on app panels) */
  focus?: boolean;
}

/**
 * Build an ns:// URL for navigating to an app panel.
 *
 * @param source - Workspace-relative source path (e.g., "panels/editor")
 * @param options - Optional navigation options
 * @returns ns:// URL
 *
 * @example
 * ```ts
 * buildNsLink("panels/editor")
 * // => "ns:///panels/editor"
 *
 * buildNsLink("panels/editor", { action: "child" })
 * // => "ns:///panels/editor?action=child"
 * ```
 */
export function buildNsLink(source: string, options?: BuildNsLinkOptions): string {
  const encodedPath = encodeURIComponent(source).replace(/%2F/g, "/"); // keep slashes readable
  const searchParams = new URLSearchParams();

  if (options?.action && options.action !== "navigate") {
    searchParams.set("action", options.action);
  }
  if (options?.contextId !== undefined) {
    // true -> "true", string -> the string value
    searchParams.set("contextId", String(options.contextId));
  }
  if (options?.gitRef) {
    searchParams.set("gitRef", options.gitRef);
  }
  if (options?.repoArgs) {
    searchParams.set("repoArgs", JSON.stringify(options.repoArgs));
  }
  if (options?.env) {
    searchParams.set("env", JSON.stringify(options.env));
  }
  if (options?.stateArgs) {
    searchParams.set("stateArgs", JSON.stringify(options.stateArgs));
  }
  if (options?.name) {
    searchParams.set("name", options.name);
  }
  if (options?.focus) {
    searchParams.set("focus", "true");
  }

  const paramsStr = searchParams.toString();
  const params = paramsStr ? `?${paramsStr}` : "";
  return `ns:///${encodedPath}${params}`;
}

/**
 * Build an ns-about:// URL for navigating to a shell/about page.
 * About page names are discovered dynamically from workspace manifests.
 *
 * @param page - The about page name to navigate to
 * @returns ns-about:// URL
 *
 * @example
 * ```ts
 * buildAboutLink("about")
 * // => "ns-about://about"
 *
 * buildAboutLink("keyboard-shortcuts")
 * // => "ns-about://keyboard-shortcuts"
 * ```
 */
export function buildAboutLink(page: string): string {
  return `ns-about://${page}`;
}

/**
 * Build an ns-focus:// URL for focusing an existing panel.
 *
 * @param panelId - The panel ID to focus
 * @returns ns-focus:// URL
 *
 * @example
 * ```ts
 * buildFocusLink("tree/root/editor-abc")
 * // => "ns-focus:///tree/root/editor-abc"
 * ```
 */
export function buildFocusLink(panelId: string): string {
  const encodedId = encodeURIComponent(panelId).replace(/%2F/g, "/"); // keep slashes readable
  return `ns-focus:///${encodedId}`;
}
