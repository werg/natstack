/**
 * Svelte-idiomatic stores wrapping @workspace/runtime APIs.
 * These provide reactive state management for Svelte panels.
 */

import { readable } from "svelte/store";
import { panel } from "@workspace/runtime";
import * as runtime from "@workspace/runtime";

/** Reactive theme store — updates when the host theme changes. */
export const theme = readable(panel.getTheme(), (set) => {
  return panel.onThemeChange((nextTheme) => set(nextTheme));
});

/** Static panel ID store. */
export const panelId = readable(runtime.id);

/** Static context ID store. */
export const contextId = readable(runtime.contextId);

/** Reactive connection error store — null when connected. */
export const connectionError = readable<{ code: number; reason: string; source?: string } | null>(
  null,
  (set) => {
    return panel.onConnectionError((err) => set(err));
  },
);
