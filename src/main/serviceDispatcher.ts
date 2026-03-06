/**
 * ServiceDispatcher - Unified service dispatch for panels and shell.
 *
 * Panels and the shell renderer call main process services
 * like bridge, ai, db, browser, fs. This module provides a single registry
 * and dispatch mechanism that all code paths use.
 */

import type { ServiceDefinition, MethodDef } from "./serviceDefinition.js";
import type { ServicePolicy } from "./servicePolicy.js";

export type CallerKind = "panel" | "shell" | "server";

export type ServiceContext = {
  /** The caller ID (panel/worker tree node ID, or "shell" for the shell renderer) */
  callerId: string;
  /** Whether the caller is a panel, worker, shell, or external server */
  callerKind: CallerKind;
  /** WS client state when caller connected via WebSocket */
  wsClient?: import("../server/rpcServer.js").WsClientState;
};

export type ServiceHandler = (
  ctx: ServiceContext,
  method: string,
  args: unknown[]
) => Promise<unknown>;

export class ServiceError extends Error {
  public readonly service: string;
  public readonly method: string;

  constructor(service: string, method: string, message: string) {
    super(`[${service}.${method}] ${message}`);
    this.service = service;
    this.method = method;
    this.name = "ServiceError";
  }
}

/**
 * Service dispatcher with both legacy register() and new registerService() support.
 */
export class ServiceDispatcher {
  private handlers = new Map<string, ServiceHandler>();
  private definitions = new Map<string, ServiceDefinition>();
  private initialized = false;

  /**
   * Mark the dispatcher as initialized. Must be called after all services are registered.
   */
  markInitialized(): void {
    this.initialized = true;
  }

  /**
   * Register a service handler (legacy path — will be replaced by registerService).
   */
  register(service: string, handler: ServiceHandler): void {
    if (this.handlers.has(service)) {
      console.warn(`[ServiceDispatcher] Overwriting handler for service: ${service}`);
    }
    this.handlers.set(service, handler);
  }

  /**
   * Register a service with full definition (schema, policy, handler).
   */
  registerService(def: ServiceDefinition): void {
    if (this.handlers.has(def.name) || this.definitions.has(def.name)) {
      console.warn(`[ServiceDispatcher] Overwriting handler for service: ${def.name}`);
    }
    this.definitions.set(def.name, def);
    this.handlers.set(def.name, def.handler);
  }

  /**
   * Dispatch a service call.
   */
  async dispatch(
    ctx: ServiceContext,
    service: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    if (!this.initialized) {
      throw new ServiceError(service, method, "Services not yet initialized");
    }

    const handler = this.handlers.get(service);
    if (!handler) {
      throw new ServiceError(service, method, "Unknown service");
    }

    // Validate args against schema if service was registered via registerService
    const def = this.definitions.get(service);
    if (def) {
      const methodDef = def.methods[method];
      if (methodDef) {
        const parsed = methodDef.args.safeParse(args);
        if (!parsed.success) {
          throw new ServiceError(
            service,
            method,
            `Invalid args: ${parsed.error.message}`
          );
        }
      }
    }

    try {
      return await handler(ctx, method, args);
    } catch (error) {
      if (error instanceof ServiceError) {
        throw error;
      }
      throw new ServiceError(
        service,
        method,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Check if a service is registered.
   */
  hasService(service: string): boolean {
    return this.handlers.has(service);
  }

  /**
   * Get all registered service names.
   */
  getServices(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Get all registered service definitions (for introspection/extension discovery).
   */
  getServiceDefinitions(): ServiceDefinition[] {
    return Array.from(this.definitions.values());
  }

  /**
   * Get the Zod schema for a specific method.
   */
  getMethodSchema(service: string, method: string): MethodDef | undefined {
    return this.definitions.get(service)?.methods[method];
  }

  /**
   * Get the policy for a service (from ServiceDefinition if registered via registerService).
   */
  getPolicy(service: string): ServicePolicy | undefined {
    return this.definitions.get(service)?.policy;
  }
}

// Singleton instance
let instance: ServiceDispatcher | null = null;

export function getServiceDispatcher(): ServiceDispatcher {
  if (!instance) {
    instance = new ServiceDispatcher();
  }
  return instance;
}

/**
 * Helper to parse "service.method" format.
 */
export function parseServiceMethod(fullMethod: string): { service: string; method: string } | null {
  const dotIndex = fullMethod.indexOf(".");
  if (dotIndex === -1) {
    return null;
  }
  return {
    service: fullMethod.substring(0, dotIndex),
    method: fullMethod.substring(dotIndex + 1),
  };
}
