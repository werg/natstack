/**
 * Service Policy - Permission checking for services.
 *
 * This module checks which caller types (shell, panel, server) can access
 * which services. The policy is looked up from the service's ServiceDefinition
 * as registered in the dispatcher.
 */

import type { CallerKind } from "./serviceDispatcher.js";

export type ServicePolicy = {
  /** Which caller kinds can access this service */
  allowed: CallerKind[];
  /** Human-readable description */
  description?: string;
};

/**
 * Registry interface for looking up service policies.
 * ServiceDispatcher implements this via getPolicy().
 */
export interface PolicyRegistry {
  getPolicy(service: string): ServicePolicy | undefined;
}

/**
 * Check if a caller kind can access a service.
 * Throws an error if access is denied.
 *
 * Looks up the policy from the registry (ServiceDispatcher).
 */
export function checkServiceAccess(
  service: string,
  callerKind: CallerKind,
  registry: PolicyRegistry,
): void {
  const policy = registry.getPolicy(service);

  if (!policy) {
    throw new Error(
      `Unknown service '${service}'`
    );
  }

  if (!policy.allowed.includes(callerKind)) {
    throw new Error(
      `Service '${service}' is not accessible to ${callerKind} callers`
    );
  }
}
