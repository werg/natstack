/**
 * Link builders for the new browser-like navigation protocol.
 *
 * ns://        - Navigate to app panels and workers
 * ns-about://  - Navigate to shell/about pages
 * ns-focus://  - Focus an existing panel without navigating
 */

import type { RepoArgSpec } from "./types.js";

export type NsAction = "navigate" | "child";

export interface BuildNsLinkOptions {
  /** Action: 'navigate' (default) replaces current panel, 'child' creates a new child */
  action?: NsAction;
  /** Context ID for storage partition sharing */
  context?: string;
  /** Git reference (branch, tag, or commit SHA) */
  gitRef?: string;
  /** Repo arguments required by the target manifest */
  repoArgs?: Record<string, RepoArgSpec>;
  /** Environment variables to pass to the panel */
  env?: Record<string, string>;
  /** Panel name/ID */
  name?: string;
  /** If true, create a new context instead of deriving from tree path */
  newContext?: boolean;
  /** If true, panel can be closed and is not persisted */
  ephemeral?: boolean;
  /** If true, immediately focus the new panel after creation (only applies to action=child on app panels) */
  focus?: boolean;
}

/**
 * Build an ns:// URL for navigating to an app panel or worker.
 *
 * @param source - Workspace-relative source path (e.g., "panels/editor", "workers/task")
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
 *
 * buildNsLink("panels/editor", { gitRef: "main", context: "abc" })
 * // => "ns:///panels/editor?context=abc&gitRef=main"
 * ```
 */
export function buildNsLink(source: string, options?: BuildNsLinkOptions): string {
  const encodedPath = encodeURIComponent(source).replace(/%2F/g, "/"); // keep slashes readable
  const searchParams = new URLSearchParams();

  if (options?.action && options.action !== "navigate") {
    searchParams.set("action", options.action);
  }
  if (options?.context) {
    searchParams.set("context", options.context);
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
  if (options?.name) {
    searchParams.set("name", options.name);
  }
  if (options?.newContext) {
    searchParams.set("newContext", "true");
  }
  if (options?.ephemeral) {
    searchParams.set("ephemeral", "true");
  }
  if (options?.focus) {
    searchParams.set("focus", "true");
  }

  const paramsStr = searchParams.toString();
  const params = paramsStr ? `?${paramsStr}` : "";
  return `ns:///${encodedPath}${params}`;
}

/**
 * Valid shell/about page names.
 */
export type AboutPage = "model-provider-config" | "about" | "keyboard-shortcuts" | "help" | "new";

const VALID_ABOUT_PAGES: AboutPage[] = ["model-provider-config", "about", "keyboard-shortcuts", "help", "new"];

/**
 * Build an ns-about:// URL for navigating to a shell/about page.
 *
 * @param page - The about page to navigate to
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
export function buildAboutLink(page: AboutPage): string {
  if (!VALID_ABOUT_PAGES.includes(page)) {
    throw new Error(`Invalid about page: ${page}. Valid pages: ${VALID_ABOUT_PAGES.join(", ")}`);
  }
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
