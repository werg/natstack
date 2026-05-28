/**
 * Shared event types for shell/main communication.
 *
 * These types are used by both the renderer (useShellEvent) and main (eventsService).
 * Keep them in sync by importing from this single source of truth.
 */

import type { PendingApproval } from "./approvals.js";
import type { PanelCommandId } from "./panelCommands.js";
import type { PanelRuntimeLeaseChangedEvent } from "./panel/panelLease.js";
import type { PanelRecoverySnapshot, PanelTreeSnapshot } from "./types.js";

/**
 * Known event names that can be subscribed to.
 */
export type EventName =
  | `extensions:${string}`
  | `apps:${string}`
  | "workspace:unit-log"
  | "workspace:revision-bumped"
  | "presence:panel-active"
  | "panel:runtimeLeaseChanged"
  | "panel-title-updated"
  | "panel:snapshot"
  | "system-theme-changed"
  | "panel-tree-updated"
  | "open-workspace-switcher"
  | "toggle-address-bar"
  | "focus-address-bar"
  | "panel-chrome-command"
  | "toggle-panel-devtools"
  | "panel-initialization-error"
  | "navigate-about"
  | "navigate-to-panel"
  | "external-open:open"
  | "browser-panel:open"
  | "browser-import-progress"
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
  command?:
    | { type: "app.applyUpdate"; appId: string }
    | { type: "app.rollback"; appId: string; buildKey?: string }
    | { type: "workspace.restartUnit"; name: string };
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
  /** Runtime kind requesting consent. */
  callerKind: "panel" | "app" | "worker" | "do";
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
  "panel-tree-updated": PanelTreeSnapshot;
  "panel:runtimeLeaseChanged": PanelRuntimeLeaseChangedEvent;
  "panel-title-updated": { panelId: string; title: string; explicit?: boolean };
  "panel:snapshot": PanelRecoverySnapshot;
  "open-workspace-switcher": undefined;
  "toggle-address-bar": undefined;
  "focus-address-bar": undefined;
  "panel-chrome-command": { command: PanelCommandId };
  "toggle-panel-devtools": undefined;
  "panel-initialization-error": { path: string; error: string };
  "navigate-about": { page: string };
  "navigate-to-panel": { panelId: string };
  "external-open:open": {
    url: string;
    callerId: string;
    callerKind:
      | "panel"
      | "app"
      | "worker"
      | "do"
      | "extension"
      | "shell"
      | "shell-remote"
      | "server"
      | "harness";
  };
  "browser-panel:open": {
    url: string;
    parentPanelId: string;
    callerId: string;
    callerKind:
      | "panel"
      | "app"
      | "worker"
      | "do"
      | "extension"
      | "shell"
      | "shell-remote"
      | "server"
      | "harness";
  };
  "browser-import-progress": {
    requestId: string;
    dataType: string;
    phase: string;
    itemsProcessed: number;
    totalItems?: number;
    error?: string;
  };
  // browser-import-complete is now emitted by the
  // `@workspace-extensions/browser-data` extension as
  // `extensions:@workspace-extensions/browser-data::import-complete`.
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
  "workspace:revision-bumped": { workspaceId: string; revision: number };
  "presence:panel-active": { panelId: string; ownerCallerId: string; updatedAt: number };
  [key: `extensions:${string}`]: unknown;
  [key: `apps:${string}`]: unknown;
  "workspace:unit-log": {
    workspaceId: string;
    unitName: string;
    kind: "extension" | "app" | "worker" | "panel";
    timestamp: number;
    level: "debug" | "info" | "warn" | "error";
    message: string;
    fields?: Record<string, unknown>;
    source?: "stdout" | "stderr" | "ctx.log" | "console" | "lifecycle" | "system";
  };
}

/**
 * List of valid event names for runtime validation.
 */
export const VALID_EVENT_NAMES: EventName[] = [
  "system-theme-changed",
  "panel-tree-updated",
  "panel:runtimeLeaseChanged",
  "panel-title-updated",
  "panel:snapshot",
  "open-workspace-switcher",
  "toggle-address-bar",
  "focus-address-bar",
  "panel-chrome-command",
  "toggle-panel-devtools",
  "panel-initialization-error",
  "navigate-about",
  "navigate-to-panel",
  "external-open:open",
  "browser-panel:open",
  "browser-import-progress",
  "browser-data-changed",
  "autofill:save-prompt",
  "notification:show",
  "notification:dismiss",
  "notification:action",
  "server-connection-changed",
  "server-health",
  "shell-approval:pending-changed",
  "workspace:revision-bumped",
  "presence:panel-active",
];

/**
 * Check if a string is a valid event name.
 */
export function isValidEventName(name: string): name is EventName {
  if (name.startsWith("extensions:")) return true;
  if (name.startsWith("apps:")) return true;
  if (name === "workspace:unit-log") return true;
  if (name === "workspace:revision-bumped") return true;
  if (name === "presence:panel-active") return true;
  if (name === "panel:runtimeLeaseChanged") return true;
  if (name === "panel-title-updated") return true;
  if (name === "panel:snapshot") return true;
  return VALID_EVENT_NAMES.includes(name as EventName);
}
