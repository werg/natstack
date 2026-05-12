/**
 * Panel accessor functions for the PanelSnapshot history architecture.
 */

import type { CreateChildOptions } from "@natstack/types";
import type { Panel, PanelSnapshot, PackageManifest, StateArgsValue } from "../types.js";

/**
 * Get the current snapshot for a panel.
 */
export function getCurrentSnapshot(panel: Pick<Panel, "id" | "history">): PanelSnapshot {
  const snapshot = panel.history.entries[panel.history.index];
  if (!snapshot) {
    throw new Error(`Panel ${panel.id} has no snapshot at history index ${panel.history.index}`);
  }
  return snapshot;
}

export function replaceCurrentSnapshot(panel: Panel, snapshot: PanelSnapshot): void {
  panel.history.entries[panel.history.index] = snapshot;
}

export function replacePanelHistory(panel: Panel, entries: PanelSnapshot[], index: number): void {
  if (entries.length === 0) {
    throw new Error(`Panel ${panel.id} history cannot be empty`);
  }
  const nextIndex = Math.max(0, Math.min(index, entries.length - 1));
  panel.history = { entries, index: nextIndex };
}

export function pushPanelHistorySnapshot(panel: Panel, snapshot: PanelSnapshot): void {
  replacePanelHistory(
    panel,
    panel.history.entries.slice(0, panel.history.index + 1).concat(snapshot),
    panel.history.index + 1,
  );
}

/**
 * Get the panel source (path or URL) from the current snapshot.
 */
export function getPanelSource(panel: Pick<Panel, "id" | "history">): string {
  return getCurrentSnapshot(panel).source;
}

/**
 * Get the panel options from the current snapshot.
 */
export function getPanelOptions(panel: Pick<Panel, "id" | "history">): PanelSnapshot["options"] {
  return getCurrentSnapshot(panel).options;
}

/**
 * Get panel environment variables from the current snapshot.
 */
export function getPanelEnv(panel: Pick<Panel, "id" | "history">): Record<string, string> | undefined {
  return getPanelOptions(panel).env;
}

/**
 * Get the resolved context ID for a panel.
 */
export function getPanelContextId(panel: Pick<Panel, "id" | "history">): string {
  return getCurrentSnapshot(panel).contextId;
}

/**
 * Get whether a panel should inject host theme variables.
 */
export function getInjectHostThemeVariables(panel: Panel, manifest?: PackageManifest): boolean {
  return manifest?.injectHostThemeVariables !== false;
}

/**
 * Get the resolved URL for a panel.
 */
export function getBrowserResolvedUrl(panel: Pick<Panel, "id" | "history">): string | undefined {
  return getCurrentSnapshot(panel).resolvedUrl;
}

export function getPanelRef(panel: Pick<Panel, "id" | "history">): string | undefined {
  return getCurrentSnapshot(panel).options.ref;
}

export function getPanelHistoryState(panel: Panel): { canGoBack: boolean; canGoForward: boolean } {
  return {
    canGoBack: panel.history.index > 0,
    canGoForward: panel.history.index < panel.history.entries.length - 1,
  };
}

/**
 * Get the state args for a panel from the current snapshot.
 * Returns undefined if not set.
 */
export function getPanelStateArgs(panel: Pick<Panel, "id" | "history">): StateArgsValue | undefined {
  return getCurrentSnapshot(panel).stateArgs;
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
