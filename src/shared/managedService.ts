/**
 * ManagedService interface for declarative service lifecycle management.
 *
 * Services declare their dependencies by name. The ServiceContainer
 * starts them in topological order and stops them in reverse order.
 */

import type { ServiceDefinition } from "./serviceDefinition.js";

/**
 * A service with declarative dependencies and managed lifecycle.
 *
 * The `start()` method receives a resolver function to access already-started
 * dependency instances. This handles both ordering and wiring.
 */
export interface ManagedService<T = unknown> {
  readonly name: string;
  readonly dependencies?: string[];

  /**
   * Start the service. Called after all dependencies have started.
   * @param resolve - Look up a started dependency by name.
   * @returns The service instance (stored for later resolution).
   */
  start(resolve: <D>(name: string) => D): Promise<T>;

  /**
   * Stop the service. Called before any of its dependents are stopped.
   */
  stop?(): Promise<void>;

  /**
   * Optional RPC service definition to register on the dispatcher.
   * If provided, registered after start() completes.
   */
  getServiceDefinition?(): ServiceDefinition;
}
