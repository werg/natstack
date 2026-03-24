/**
 * Svelte-idiomatic stores wrapping @workspace/runtime APIs.
 * These provide reactive state management for Svelte panels.
 */

import { readable } from "svelte/store";
import { getTheme, onThemeChange, onConnectionError } from "@workspace/runtime";
import * as runtime from "@workspace/runtime";

/** Reactive theme store — updates when the host theme changes. */
export const theme = readable(getTheme(), (set) => {
  return onThemeChange((nextTheme) => set(nextTheme));
});

/** Static panel ID store. */
export const panelId = readable(runtime.id);

/** Static context ID store. */
export const contextId = readable(runtime.contextId);

/** Reactive connection error store — null when connected. */
export const connectionError = readable<{ code: number; reason: string; source?: string } | null>(
  null,
  (set) => {
    return onConnectionError((err) => set(err));
  },
);
