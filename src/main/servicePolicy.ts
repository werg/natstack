/**
 * Service Policy - Centralized permission definitions for services.
 *
 * This module defines which caller types (shell, panel, server) can access
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
 * - Panel services: bridge
 * - Shared services: ai, db, browser, events, build
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
  // Panel services (userland operations)
  // ==========================================================================

  bridge: {
    allowed: ["panel", "shell", "server"],
    description: "Panel lifecycle (createPanel, close, navigation)",
  },
  fs: {
    allowed: ["panel", "server"],
    description: "Per-context filesystem operations (sandboxed to context folder)",
  },
  typecheck: {
    allowed: ["panel", "server"],
    description: "Type definition fetching for panels",
  },
  agentSettings: {
    allowed: ["shell", "panel", "server"],
    description: "Agent preferences and configuration",
  },

  // ==========================================================================
  // Shared services (accessible to all)
  // ==========================================================================

  ai: {
    allowed: ["shell", "panel", "server"],
    description: "AI/LLM operations",
  },
  db: {
    allowed: ["shell", "panel", "server"],
    description: "Database operations",
  },
  browser: {
    allowed: ["shell", "panel", "server"],
    description: "CDP/browser automation",
  },
  events: {
    allowed: ["shell", "panel", "server"],
    description: "Event subscriptions",
  },
  build: {
    allowed: ["panel", "shell", "server"],
    description: "Build system (getBuild, recompute, gc, getAboutPages)",
  },

  // ==========================================================================
  // Server-only services (admin operations proxied from Electron)
  // ==========================================================================

  tokens: {
    allowed: ["server"],
    description: "Token management (create/revoke panel tokens)",
  },
  git: {
    allowed: ["shell", "panel", "server"],
    description: "Git operations and scoped filesystem access for panels",
  },
};

/**
 * Check if a caller kind can access a service.
 * Throws an error if access is denied.
 */
export function checkServiceAccess(service: string, callerKind: CallerKind): void {
  const policy = SERVICE_POLICIES[service];

  if (!policy) {
    // Unknown service - let the dispatcher handle it
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
