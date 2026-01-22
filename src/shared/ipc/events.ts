/**
 * Shared event types for shell/main communication.
 *
 * These types are used by both the renderer (useShellEvent) and main (eventsService).
 * Keep them in sync by importing from this single source of truth.
 */

import type { ShellPage } from "./types.js";

/**
 * Known event names that can be subscribed to.
 */
export type EventName =
  | "system-theme-changed"
  | "panel-tree-updated"
  | "open-workspace-chooser"
  | "toggle-panel-devtools"
  | "panel-initialization-error"
  | "navigate-about"
  | "navigate-to-panel";

/**
 * Event payloads for type safety.
 */
export interface EventPayloads {
  "system-theme-changed": "light" | "dark";
  "panel-tree-updated": unknown[]; // Panel tree array
  "open-workspace-chooser": void;
  "toggle-panel-devtools": void;
  "panel-initialization-error": { path: string; error: string };
  "navigate-about": { page: ShellPage };
  "navigate-to-panel": { panelId: string };
}

/**
 * List of valid event names for runtime validation.
 */
export const VALID_EVENT_NAMES: EventName[] = [
  "system-theme-changed",
  "panel-tree-updated",
  "open-workspace-chooser",
  "toggle-panel-devtools",
  "panel-initialization-error",
  "navigate-about",
  "navigate-to-panel",
];

/**
 * Check if a string is a valid event name.
 */
export function isValidEventName(name: string): name is EventName {
  return VALID_EVENT_NAMES.includes(name as EventName);
}
