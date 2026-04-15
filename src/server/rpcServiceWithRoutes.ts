/**
 * `rpcServiceWithRoutes` — ManagedService adapter for the `{ definition,
 * routes? }` factory shape (Phase 1.3 convention).
 *
 * Server-local because route concerns don't belong in `@natstack/shared`.
 * Factories that need to expose HTTP routes (currently only auth's OAuth
 * callback; more later) return the pair; bootstrap wraps it with this helper
 * so the service definition lands on the dispatcher AND routes land on the
 * registry in one declaration.
 */

import type { ManagedService } from "@natstack/shared/managedService";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { RouteRegistry, ServiceRouteDecl } from "./routeRegistry.js";

export interface ServiceWithRoutes {
  definition: ServiceDefinition;
  routes?: ServiceRouteDecl[];
}

/**
 * Turn a `{ definition, routes? }` factory output into a ManagedService that
 * registers the RPC definition on the dispatcher (via the container) and the
 * routes on the shared route registry. Route registration runs at
 * `container.startAll()` time, unregistration in `stop()`.
 */
export function rpcServiceWithRoutes(
  pair: ServiceWithRoutes,
  routeRegistry: RouteRegistry,
  deps?: string[],
): ManagedService {
  const serviceName = pair.definition.name;
  return {
    name: serviceName,
    dependencies: deps,
    async start() {
      if (pair.routes && pair.routes.length > 0) {
        routeRegistry.registerService(pair.routes);
      }
    },
    async stop() {
      if (pair.routes && pair.routes.length > 0) {
        routeRegistry.unregisterService(serviceName);
      }
    },
    getServiceDefinition() {
      return pair.definition;
    },
  };
}
