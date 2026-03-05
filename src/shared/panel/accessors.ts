/**
 * Panel accessor functions for the unified PanelSnapshot architecture.
 *
 * These functions provide type-safe access to panel state via the
 * single current snapshot.
 */

import type { CreateChildOptions, RepoArgSpec } from "@natstack/types";
import type { Panel, PanelSnapshot, PanelManifest, StateArgsValue } from "../types.js";

/**
 * Get the current snapshot for a panel.
 */
export function getCurrentSnapshot(panel: Panel): PanelSnapshot {
  return panel.snapshot;
}

/**
 * Get the panel source (path or URL) from the current snapshot.
 */
export function getPanelSource(panel: Panel): string {
  return panel.snapshot.source;
}

/**
 * Get the panel options from the current snapshot.
 */
export function getPanelOptions(panel: Panel): PanelSnapshot["options"] {
  return panel.snapshot.options;
}

/**
 * Get panel environment variables from the current snapshot.
 */
export function getPanelEnv(panel: Panel): Record<string, string> | undefined {
  return getPanelOptions(panel).env;
}

/**
 * Get repo args from the current snapshot.
 */
export function getPanelRepoArgs(panel: Panel): Record<string, RepoArgSpec> | undefined {
  return getPanelOptions(panel).repoArgs;
}

/**
 * Get the resolved context ID for a panel.
 */
export function getPanelContextId(panel: Panel): string {
  return panel.snapshot.contextId;
}

/**
 * Get whether a panel should inject host theme variables.
 */
export function getInjectHostThemeVariables(panel: Panel, manifest?: PanelManifest): boolean {
  return manifest?.injectHostThemeVariables !== false;
}

/**
 * Get the about-page name from a panel's source, if it starts with "about/".
 * Returns undefined for non-about sources.
 */
export function getSourcePage(panel: Panel): string | undefined {
  const src = panel.snapshot.source;
  return src.startsWith("about/") ? src.slice(6) : undefined;
}

/**
 * Get the resolved URL for a panel.
 */
export function getBrowserResolvedUrl(panel: Panel): string | undefined {
  return panel.snapshot.resolvedUrl;
}

/**
 * Get the state args for a panel from the current snapshot.
 * Returns undefined if not set.
 */
export function getPanelStateArgs(panel: Panel): StateArgsValue | undefined {
  return panel.snapshot.stateArgs;
}

/**
 * Snapshot options type - CreateChildOptions without runtime-only fields
 */
type SnapshotOptions = Omit<CreateChildOptions, "eventSchemas" | "focus">;

/**
 * Create a snapshot from source, contextId, options, and stateArgs.
 */
export function createSnapshot(
  source: string,
  contextId: string,
  options?: SnapshotOptions,
  stateArgs?: StateArgsValue
): PanelSnapshot {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { eventSchemas, focus, ...persistableOptions } = (options ?? {}) as CreateChildOptions;

  return {
    source,
    contextId,
    options: persistableOptions,
    stateArgs,
  };
}
