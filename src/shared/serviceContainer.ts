/**
 * ServiceContainer — topological lifecycle manager for ManagedServices.
 *
 * Registers services with declared dependencies, starts them in dependency
 * order, and stops them in reverse order. Supports partial-failure cleanup.
 *
 * If a ServiceDispatcher is provided, services that implement
 * getServiceDefinition() will have their RPC definitions auto-registered
 * after start().
 */

import type { ManagedService } from "./managedService.js";
import type { ServiceDispatcher } from "./serviceDispatcher.js";
import { createDevLogger } from "./devLog.js";

const log = createDevLogger("ServiceContainer");

export class ServiceContainer {
  private services = new Map<string, ManagedService>();
  private instances = new Map<string, unknown>();
  private startOrder: string[] = [];
  private started = false;
  private dispatcher: ServiceDispatcher | null;

  constructor(dispatcher?: ServiceDispatcher) {
    this.dispatcher = dispatcher ?? null;
  }

  /**
   * Register a service. Must be called before startAll().
   */
  register(service: ManagedService): void {
    if (this.started) {
      throw new Error(`Cannot register service "${service.name}" after container has started`);
    }
    if (this.services.has(service.name)) {
      throw new Error(`Service "${service.name}" is already registered`);
    }
    this.services.set(service.name, service);
  }

  /**
   * Start all registered services in topological dependency order.
   * On partial failure, already-started services are stopped in reverse order.
   *
   * If a dispatcher was provided, services with getServiceDefinition() have
   * their RPC definitions registered after start().
   */
  async startAll(): Promise<void> {
    if (this.started) {
      throw new Error("Container is already started");
    }

    const order = this.topologicalSort();
    const started: string[] = [];

    try {
      for (const name of order) {
        const service = this.services.get(name)!;
        const resolve = <D>(depName: string): D => {
          if (!this.instances.has(depName)) {
            throw new Error(`Service "${name}" depends on "${depName}" which is not started`);
          }
          return this.instances.get(depName) as D;
        };

        log.info(`[${name}] Starting`);
        const instance = await service.start(resolve);
        this.instances.set(name, instance);
        started.push(name);

        // Auto-register RPC service definition if available
        if (this.dispatcher && service.getServiceDefinition) {
          const def = service.getServiceDefinition();
          this.dispatcher.registerService(def);
          log.info(`[${name}] Registered RPC service "${def.name}"`);
        }
      }

      this.startOrder = started;
      this.started = true;
      log.info(`All ${started.length} services started`);
    } catch (error) {
      log.info(`Startup failed, cleaning up ${started.length} started services...`);
      for (const name of started.reverse()) {
        const service = this.services.get(name);
        if (service?.stop) {
          try {
            await service.stop();
          } catch (e) {
            console.error(`[ServiceContainer] Cleanup error for "${name}":`, e);
          }
        }
      }
      throw error;
    }
  }

  /**
   * Stop all services in reverse dependency order.
   */
  async stopAll(): Promise<void> {
    if (!this.started) return;

    log.info(`Stopping ${this.startOrder.length} services...`);

    for (const name of [...this.startOrder].reverse()) {
      const service = this.services.get(name);
      if (service?.stop) {
        try {
          log.info(`[${name}] Stopping`);
          await service.stop();
        } catch (e) {
          console.error(`[ServiceContainer] Stop error for "${name}":`, e);
        }
      }
    }

    this.instances.clear();
    this.startOrder = [];
    this.started = false;
  }

  /**
   * Get a started service instance by name.
   */
  get<T>(name: string): T {
    if (!this.instances.has(name)) {
      throw new Error(`Service "${name}" is not available (not started or not registered)`);
    }
    return this.instances.get(name) as T;
  }

  /**
   * Check if a service is registered and started.
   */
  has(name: string): boolean {
    return this.instances.has(name);
  }

  /**
   * Topological sort of services by dependencies.
   * Throws on missing dependencies or cycles.
   */
  private topologicalSort(): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (name: string, path: string[]) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Dependency cycle detected: ${[...path, name].join(" → ")}`);
      }

      const service = this.services.get(name);
      if (!service) {
        throw new Error(`Missing dependency: "${name}" (required by "${path[path.length - 1]}")`);
      }

      visiting.add(name);
      for (const dep of service.dependencies ?? []) {
        visit(dep, [...path, name]);
      }
      visiting.delete(name);
      visited.add(name);
      result.push(name);
    };

    for (const name of this.services.keys()) {
      visit(name, []);
    }

    return result;
  }
}
