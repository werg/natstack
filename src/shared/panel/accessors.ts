/**
 * Panel accessor functions for the unified PanelSnapshot architecture.
 *
 * These functions provide type-safe access to panel state without
 * requiring knowledge of the internal history-based structure.
 */

import type { CreateChildOptions, RepoArgSpec } from "@natstack/runtime";
import type { Panel, PanelSnapshot, PanelType, ShellPage, PanelManifest } from "../ipc/types.js";

/**
 * Get the current snapshot for a panel.
 * Throws if the panel has no snapshot at the current history index.
 */
export function getCurrentSnapshot(panel: Panel): PanelSnapshot {
  const snapshot = panel.history[panel.historyIndex];
  if (!snapshot) {
    throw new Error(`Panel ${panel.id} has no snapshot at index ${panel.historyIndex}`);
  }
  return snapshot;
}

/**
 * Get the panel type from the current snapshot.
 */
export function getPanelType(panel: Panel): PanelType {
  return getCurrentSnapshot(panel).type;
}

/**
 * Get the panel source (path or URL) from the current snapshot.
 */
export function getPanelSource(panel: Panel): string {
  return getCurrentSnapshot(panel).source;
}

/**
 * Get the panel options from the current snapshot.
 */
export function getPanelOptions(panel: Panel): PanelSnapshot["options"] {
  return getCurrentSnapshot(panel).options;
}

/**
 * Get panel environment variables from the current snapshot.
 */
export function getPanelEnv(panel: Panel): Record<string, string> | undefined {
  return getPanelOptions(panel).env;
}

/**
 * Get the git ref from the current snapshot.
 */
export function getPanelGitRef(panel: Panel): string | undefined {
  return getPanelOptions(panel).gitRef;
}

/**
 * Get repo args from the current snapshot.
 */
export function getPanelRepoArgs(panel: Panel): Record<string, RepoArgSpec> | undefined {
  return getPanelOptions(panel).repoArgs;
}

/**
 * Get the unsafe mode setting from the current snapshot.
 */
export function getPanelUnsafe(panel: Panel): boolean | string | undefined {
  return getPanelOptions(panel).unsafe;
}

/**
 * Get the sourcemap setting from the current snapshot.
 */
export function getPanelSourcemap(panel: Panel): boolean | undefined {
  return getPanelOptions(panel).sourcemap;
}

/**
 * Get the branch from the current snapshot (legacy).
 */
export function getPanelBranch(panel: Panel): string | undefined {
  return getPanelOptions(panel).branch;
}

/**
 * Get the commit from the current snapshot (legacy).
 */
export function getPanelCommit(panel: Panel): string | undefined {
  return getPanelOptions(panel).commit;
}

/**
 * Get the tag from the current snapshot (legacy).
 */
export function getPanelTag(panel: Panel): string | undefined {
  return getPanelOptions(panel).tag;
}

/**
 * Check if a panel is ephemeral (not persisted).
 */
export function isPanelEphemeral(panel: Panel): boolean {
  return getPanelOptions(panel).ephemeral ?? false;
}

/**
 * Get the resolved context ID for a panel.
 *
 * - If contextId is a string, return it directly
 * - If contextId is true, this is an error (should have been resolved at creation)
 * - If contextId is undefined, auto-derive from panel ID
 */
export function getPanelContextId(panel: Panel): string {
  const options = getPanelOptions(panel);
  const mode = options.unsafe ? "unsafe" : "safe";

  if (options.contextId === true) {
    // true means "new unique context" - but this should have been resolved at creation time
    // If we see true here, it means the snapshot wasn't properly resolved
    throw new Error(
      `Panel ${panel.id} has unresolved contextId=true - should have been converted to UUID at creation`
    );
  }
  if (typeof options.contextId === "string") {
    return options.contextId;
  }
  // undefined: auto-derive from panel ID
  return `${mode}_auto_${panel.id.replace(/\//g, "~")}`;
}

/**
 * Check if a panel can navigate back in history.
 */
export function canGoBack(panel: Panel): boolean {
  return panel.historyIndex > 0;
}

/**
 * Check if a panel can navigate forward in history.
 */
export function canGoForward(panel: Panel): boolean {
  return panel.historyIndex < panel.history.length - 1;
}

/**
 * Get whether a panel should inject host theme variables.
 * Derived from panel type and manifest, not snapshot.
 */
export function getInjectHostThemeVariables(panel: Panel, manifest?: PanelManifest): boolean {
  const type = getPanelType(panel);
  if (type === "shell") return true;
  if (type === "browser") return false;
  return manifest?.injectHostThemeVariables !== false;
}

/**
 * Get the shell page name for a shell panel.
 * Returns undefined for non-shell panels.
 */
export function getShellPage(panel: Panel): ShellPage | undefined {
  const snapshot = getCurrentSnapshot(panel);
  return snapshot.page;
}

/**
 * Get the resolved URL for a browser panel.
 * Returns undefined for non-browser panels.
 */
export function getBrowserResolvedUrl(panel: Panel): string | undefined {
  const snapshot = getCurrentSnapshot(panel);
  return snapshot.resolvedUrl;
}

/**
 * Get the pushState for an app panel.
 * Returns undefined if not set.
 */
export function getPushState(panel: Panel): { state: unknown; path: string } | undefined {
  const snapshot = getCurrentSnapshot(panel);
  return snapshot.pushState;
}

/**
 * Options that are source-scoped (reset on navigation to different source).
 * These should NOT inherit across navigations.
 */
export const SOURCE_SCOPED_OPTIONS = [
  "gitRef",
  "branch",
  "commit",
  "tag",
  "repoArgs",
  "sourcemap",
] as const;

/**
 * Options that persist across navigations (panel-scoped).
 * These inherit unless explicitly overridden.
 */
export const PANEL_SCOPED_OPTIONS = [
  "env",
  "contextId",
  "unsafe",
  "name",
  "ephemeral",
] as const;

/**
 * Create a snapshot from source, type, and options.
 * Resolves contextId=true to a UUID.
 */
export function createSnapshot(
  source: string,
  type: PanelType,
  options?: CreateChildOptions
): PanelSnapshot {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { eventSchemas, focus, ...persistableOptions } = options ?? {};

  // Resolve contextId=true to a unique string
  const resolvedOptions = { ...persistableOptions };
  if (resolvedOptions.contextId === true) {
    resolvedOptions.contextId = crypto.randomUUID();
  }

  return {
    source,
    type,
    options: resolvedOptions,
    createdAt: Date.now(),
  };
}

/**
 * Create a new snapshot for navigation with proper option inheritance.
 * Panel-scoped options inherit, source-scoped options reset.
 */
export function createNavigationSnapshot(
  panel: Panel,
  source: string,
  type: PanelType,
  newOptions?: CreateChildOptions
): PanelSnapshot {
  const prevOptions = getPanelOptions(panel);

  // Only inherit panel-scoped options
  const inheritedOptions: Partial<CreateChildOptions> = {
    env: prevOptions.env,
    contextId: prevOptions.contextId,
    unsafe: prevOptions.unsafe,
    name: prevOptions.name,
    ephemeral: prevOptions.ephemeral,
  };

  // Merge inherited options with new options (new options override)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { eventSchemas, focus, ...persistableNewOptions } = newOptions ?? {};
  const mergedOptions = {
    ...inheritedOptions,
    ...persistableNewOptions,
  };

  // Resolve contextId=true
  if (mergedOptions.contextId === true) {
    mergedOptions.contextId = crypto.randomUUID();
  }

  return {
    source,
    type,
    options: mergedOptions,
    createdAt: Date.now(),
  };
}
