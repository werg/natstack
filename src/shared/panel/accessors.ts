/**
 * Panel accessor functions for the unified PanelSnapshot architecture.
 *
 * These functions provide type-safe access to panel state without
 * requiring knowledge of the internal history-based structure.
 */

import type { CreateChildOptions, RepoArgSpec } from "@natstack/runtime";
import type { Panel, PanelSnapshot, PanelType, ShellPage, PanelManifest, StateArgsValue } from "../ipc/types.js";

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
 * Get the resolved context ID for a panel.
 * Returns the contextId stored in the snapshot.
 */
export function getPanelContextId(panel: Panel): string {
  return getCurrentSnapshot(panel).contextId;
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
 * Get the state args for a panel from the current snapshot.
 * Returns undefined if not set.
 */
export function getPanelStateArgs(panel: Panel): StateArgsValue | undefined {
  const snapshot = getCurrentSnapshot(panel);
  return snapshot.stateArgs;
}

/**
 * Options that are source-scoped (reset on navigation to different source).
 * These should NOT inherit across navigations.
 */
export const SOURCE_SCOPED_OPTIONS = [
  "gitRef",
  "repoArgs",
  "sourcemap",
] as const;

/**
 * Options that persist across navigations (panel-scoped).
 * These inherit unless explicitly overridden.
 * Note: contextId is NOT in options - it's a separate field on the snapshot.
 */
export const PANEL_SCOPED_OPTIONS = [
  "env",
  "unsafe",
  "name",
  "templateSpec",
] as const;

/**
 * Snapshot options type - CreateChildOptions without runtime-only fields
 */
type SnapshotOptions = Omit<CreateChildOptions, "eventSchemas" | "focus">;

/**
 * Create a snapshot from source, type, contextId, options, and stateArgs.
 *
 * @param source - Panel source path or URL
 * @param type - Panel type
 * @param contextId - Resolved context ID string
 * @param options - Creation options (without contextId)
 * @param stateArgs - Validated state args (separate from options for single source of truth)
 */
export function createSnapshot(
  source: string,
  type: PanelType,
  contextId: string,
  options?: SnapshotOptions,
  stateArgs?: StateArgsValue
): PanelSnapshot {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { eventSchemas, focus, ...persistableOptions } = (options ?? {}) as CreateChildOptions;

  return {
    source,
    type,
    contextId,
    options: persistableOptions,
    stateArgs,
  };
}

/**
 * Create a new snapshot for navigation with proper option inheritance.
 * Panel-scoped options inherit, source-scoped options reset.
 * stateArgs is NOT inherited - each navigation has its own stateArgs.
 * contextId is inherited from the previous snapshot (panels keep their context).
 *
 * @param stateArgs - Validated state args for this navigation (not inherited)
 */
export function createNavigationSnapshot(
  panel: Panel,
  source: string,
  type: PanelType,
  newOptions?: CreateChildOptions,
  stateArgs?: StateArgsValue
): PanelSnapshot {
  const prevSnapshot = getCurrentSnapshot(panel);
  const prevOptions = prevSnapshot.options;

  // contextId is inherited from previous snapshot (panels keep their context)
  const contextId = prevSnapshot.contextId;

  // Only inherit panel-scoped options
  const inheritedOptions: Partial<SnapshotOptions> = {
    env: prevOptions.env,
    unsafe: prevOptions.unsafe,
    name: prevOptions.name,
    templateSpec: prevOptions.templateSpec,
  };

  // Merge inherited options with new options (new options override)
  // Filter out undefined values to preserve inheritance (undefined should not overwrite)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { eventSchemas, focus, ...persistableNewOptions } = newOptions ?? {};
  const definedNewOptions = Object.fromEntries(
    Object.entries(persistableNewOptions).filter(([, v]) => v !== undefined)
  );
  const mergedOptions = {
    ...inheritedOptions,
    ...definedNewOptions,
  };

  return {
    source,
    type,
    contextId,
    options: mergedOptions,
    stateArgs, // Not inherited - each navigation has its own stateArgs
  };
}
