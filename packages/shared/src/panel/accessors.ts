/**
 * Panel accessor functions for the shared panel snapshot.
 */

import type { CreateChildOptions } from "@natstack/types";
import type { Panel, PanelSnapshot, PackageManifest, StateArgsValue } from "../types.js";

/**
 * Get the current snapshot for a panel.
 */
export function getCurrentSnapshot(panel: Pick<Panel, "id" | "snapshot" | "history">): PanelSnapshot {
  if (panel.history) {
    const snapshot = panel.history.entries[panel.history.index];
    if (!snapshot) {
      throw new Error(`Panel ${panel.id} has no snapshot at history index ${panel.history.index}`);
    }
    return snapshot;
  }
  return panel.snapshot;
}

export function replaceCurrentSnapshot(panel: Panel, snapshot: PanelSnapshot): void {
  if (panel.history) {
    panel.history.entries[panel.history.index] = snapshot;
  }
  panel.snapshot = snapshot;
}

export function replacePanelHistory(panel: Panel, entries: PanelSnapshot[], index: number): void {
  if (entries.length === 0) {
    throw new Error(`Panel ${panel.id} history cannot be empty`);
  }
  const nextIndex = Math.max(0, Math.min(index, entries.length - 1));
  panel.history = { entries, index: nextIndex };
  panel.snapshot = entries[nextIndex]!;
}

export function pushPanelHistorySnapshot(panel: Panel, snapshot: PanelSnapshot): void {
  const history = panel.history ?? { entries: [panel.snapshot], index: 0 };
  replacePanelHistory(
    panel,
    history.entries.slice(0, history.index + 1).concat(snapshot),
    history.index + 1,
  );
}

/**
 * Get the panel source (path or URL) from the current snapshot.
 */
export function getPanelSource(panel: Pick<Panel, "id" | "snapshot" | "history">): string {
  return getCurrentSnapshot(panel).source;
}

/**
 * Get the panel options from the current snapshot.
 */
export function getPanelOptions(panel: Pick<Panel, "id" | "snapshot" | "history">): PanelSnapshot["options"] {
  return getCurrentSnapshot(panel).options;
}

/**
 * Get panel environment variables from the current snapshot.
 */
export function getPanelEnv(panel: Pick<Panel, "id" | "snapshot" | "history">): Record<string, string> | undefined {
  return getPanelOptions(panel).env;
}

/**
 * Get the resolved context ID for a panel.
 */
export function getPanelContextId(panel: Pick<Panel, "id" | "snapshot" | "history">): string {
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
export function getBrowserResolvedUrl(panel: Pick<Panel, "id" | "snapshot" | "history">): string | undefined {
  return getCurrentSnapshot(panel).resolvedUrl;
}

export function getPanelRef(panel: Pick<Panel, "id" | "snapshot" | "history">): string | undefined {
  return getCurrentSnapshot(panel).options.ref;
}

export function getPanelHistoryState(panel: Panel): { canGoBack: boolean; canGoForward: boolean } {
  return {
    canGoBack: Boolean(panel.navigation?.canGoBack || (panel.history && panel.history.index > 0)),
    canGoForward: Boolean(panel.navigation?.canGoForward || (panel.history && panel.history.index < panel.history.entries.length - 1)),
  };
}

/**
 * Get the state args for a panel from the current snapshot.
 * Returns undefined if not set.
 */
export function getPanelStateArgs(panel: Pick<Panel, "id" | "snapshot" | "history">): StateArgsValue | undefined {
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
