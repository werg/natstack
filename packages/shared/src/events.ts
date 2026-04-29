/**
 * Shared event types for shell/main communication.
 *
 * These types are used by both the renderer (useShellEvent) and main (eventsService).
 * Keep them in sync by importing from this single source of truth.
 */

import type { PendingApproval } from "./approvals.js";

/**
 * Known event names that can be subscribed to.
 */
export type EventName =
  | "system-theme-changed"
  | "panel-tree-updated"
  | "open-workspace-switcher"
  | "toggle-panel-devtools"
  | "panel-initialization-error"
  | "navigate-about"
  | "navigate-to-panel"
  | "external-open:open"
  | "browser-import-progress"
  | "browser-import-complete"
  | "browser-data-changed"
  | "autofill:save-prompt"
  | "notification:show"
  | "notification:dismiss"
  | "notification:action"
  | "server-connection-changed"
  | "server-health"
  | "shell-approval:pending-changed";

/**
 * Action button definition for notifications.
 */
export interface NotificationAction {
  id: string;
  label: string;
  variant?: "solid" | "soft" | "ghost";
}

/**
 * OAuth consent metadata for consent-type notifications.
 */
export interface NotificationConsentData {
  provider: string;
  scopes: string[];
  /** ID of the caller requesting access (panel ID or worker ID) */
  callerId: string;
  /** Human-readable name of the caller */
  callerTitle: string;
  /** Whether the caller is a worker (affects display text) */
  callerKind: "panel" | "worker";
}

/**
 * Payload for showing a notification in the shell chrome area.
 */
export interface NotificationPayload {
  id: string;
  type: "info" | "success" | "warning" | "error" | "consent";
  title: string;
  message?: string;
  /** Structured consent data (only for type: "consent") */
  consent?: NotificationConsentData;
  /** Auto-dismiss after this many ms (0 = manual dismiss only, default varies by type) */
  ttl?: number;
  /** Action buttons */
  actions?: NotificationAction[];
  /** Panel that triggered this notification */
  sourcePanelId?: string;
}

/**
 * Event payloads for type safety.
 */
export interface EventPayloads {
  "system-theme-changed": "light" | "dark";
  "panel-tree-updated": unknown[]; // Panel tree array
  "open-workspace-switcher": void;
  "toggle-panel-devtools": void;
  "panel-initialization-error": { path: string; error: string };
  "navigate-about": { page: string };
  "navigate-to-panel": { panelId: string };
  "external-open:open": {
    url: string;
    callerId: string;
    callerKind: "panel" | "worker" | "shell" | "server" | "harness";
  };
  "browser-import-progress": {
    requestId: string;
    dataType: string;
    phase: string;
    itemsProcessed: number;
    totalItems?: number;
    error?: string;
  };
  "browser-import-complete": {
    dataType: string;
    success: boolean;
    itemCount: number;
    skippedCount: number;
    error?: string;
    warnings: string[];
  }[];
  "browser-data-changed": { dataType: string };
  "autofill:save-prompt": { panelId: string; origin: string; username: string; isUpdate: boolean };
  "notification:show": NotificationPayload;
  "notification:dismiss": { id: string };
  "notification:action": { id: string; actionId: string };
  "server-connection-changed": {
    /** Current connection status */
    status: "connected" | "connecting" | "disconnected";
    /** Whether running in remote mode (false = local server child process) */
    isRemote: boolean;
    /** Remote server hostname (only when isRemote) */
    remoteHost?: string;
  };
  "server-health": {
    /** Server version string from /healthz response body. */
    version?: string;
    /** Process uptime in ms from /healthz. */
    uptimeMs?: number;
    /** workerd status — "running" or "stopped". */
    workerd?: string;
    /** Set when the poll failed; consumers can render "stale" state. */
    error?: string;
    /** Epoch ms when this sample was captured. */
    sampledAt: number;
  };
  "shell-approval:pending-changed": { pending: PendingApproval[] };
}

/**
 * List of valid event names for runtime validation.
 */
export const VALID_EVENT_NAMES: EventName[] = [
  "system-theme-changed",
  "panel-tree-updated",
  "open-workspace-switcher",
  "toggle-panel-devtools",
  "panel-initialization-error",
  "navigate-about",
  "navigate-to-panel",
  "external-open:open",
  "browser-import-progress",
  "browser-import-complete",
  "browser-data-changed",
  "autofill:save-prompt",
  "notification:show",
  "notification:dismiss",
  "notification:action",
  "server-connection-changed",
  "server-health",
  "shell-approval:pending-changed",
];

/**
 * Check if a string is a valid event name.
 */
export function isValidEventName(name: string): name is EventName {
  return VALID_EVENT_NAMES.includes(name as EventName);
}
