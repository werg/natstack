/**
 * Service Policy - Centralized permission definitions for services.
 *
 * This module defines which caller types (shell, panel, worker) can access
 * which services. The policy is checked before dispatching service calls.
 */

import type { CallerKind } from "./serviceDispatcher.js";

export type ServicePolicy = {
  /** Which caller kinds can access this service */
  allowed: CallerKind[];
  /** Human-readable description */
  description?: string;
};

/**
 * Service permission policies.
 *
 * - Shell-only services: app, panel, view, workspace, central, settings, menu
 * - Panel/worker services: bridge
 * - Shared services: ai, db, browser, events, fs
 */
export const SERVICE_POLICIES: Record<string, ServicePolicy> = {
  // ==========================================================================
  // Shell-only services (privileged operations)
  // ==========================================================================

  app: {
    allowed: ["shell"],
    description: "App lifecycle, theme, devtools",
  },
  panel: {
    allowed: ["shell"],
    description: "Panel tree management, reload, close",
  },
  view: {
    allowed: ["shell"],
    description: "View bounds, visibility, theme CSS",
  },
  workspace: {
    allowed: ["shell"],
    description: "Workspace CRUD, folder dialogs",
  },
  central: {
    allowed: ["shell"],
    description: "Central data store (recent workspaces)",
  },
  settings: {
    allowed: ["shell"],
    description: "Settings, API keys, model roles",
  },
  menu: {
    allowed: ["shell"],
    description: "Native menus",
  },
  adblock: {
    allowed: ["shell"],
    description: "Ad blocking configuration and stats",
  },

  // ==========================================================================
  // Panel/worker services (userland operations)
  // ==========================================================================

  bridge: {
    allowed: ["panel", "worker", "shell"],
    description: "Panel lifecycle (createPanel, close, setTitle)",
  },
  typecheck: {
    allowed: ["panel", "worker"],
    description: "Type definition fetching for panels and workers",
  },

  // ==========================================================================
  // Shared services (accessible to all)
  // ==========================================================================

  ai: {
    allowed: ["shell", "panel", "worker"],
    description: "AI/LLM operations",
  },
  db: {
    allowed: ["shell", "panel", "worker"],
    description: "Database operations",
  },
  browser: {
    allowed: ["shell", "panel", "worker"],
    description: "CDP/browser automation",
  },
  events: {
    allowed: ["shell", "panel", "worker"],
    description: "Event subscriptions",
  },
  // Note: fs is handled internally by panels/workers via ZenFS, not via service dispatch
};

/**
 * Check if a caller kind can access a service.
 * Throws an error if access is denied.
 *
 * @param service - The service name
 * @param callerKind - The caller kind (shell, panel, worker)
 * @throws Error if access is denied or service is unknown
 */
export function checkServiceAccess(service: string, callerKind: CallerKind): void {
  const policy = SERVICE_POLICIES[service];

  if (!policy) {
    // Unknown service - let the dispatcher handle it
    // (it will throw "Unknown service" if not registered)
    return;
  }

  if (!policy.allowed.includes(callerKind)) {
    throw new Error(
      `Service '${service}' is not accessible to ${callerKind} callers`
    );
  }
}

/**
 * Check if a service exists in the policy.
 */
export function hasServicePolicy(service: string): boolean {
  return service in SERVICE_POLICIES;
}

/**
 * Get all services accessible to a caller kind.
 */
export function getAccessibleServices(callerKind: CallerKind): string[] {
  return Object.entries(SERVICE_POLICIES)
    .filter(([, policy]) => policy.allowed.includes(callerKind))
    .map(([service]) => service);
}
