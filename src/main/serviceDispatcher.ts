/**
 * ServiceDispatcher - Unified service dispatch for panels, workers, and shell.
 *
 * Panels, workers (via IPC), and the shell renderer call main process services
 * like bridge, ai, db, browser, fs. This module provides a single registry
 * and dispatch mechanism that all code paths use.
 *
 * Benefits:
 * - Single source of truth for service handlers
 * - Consistent error handling
 * - Easier to add new services
 * - No code duplication between panel, worker, and shell paths
 */

export type CallerKind = "panel" | "worker" | "shell";

/** Fixed caller ID for the shell renderer */
export const SHELL_CALLER_ID = "shell-renderer";

export type ServiceContext = {
  /** The caller ID (panel/worker tree node ID, or SHELL_CALLER_ID for shell) */
  callerId: string;
  /** Whether the caller is a panel, worker, or shell */
  callerKind: CallerKind;
  /** Optional: Electron WebContents for streaming features */
  webContents?: Electron.WebContents;
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
 * Singleton service dispatcher.
 */
class ServiceDispatcher {
  private handlers = new Map<string, ServiceHandler>();
  private initialized = false;

  /**
   * Mark the dispatcher as initialized. Must be called after all services are registered.
   */
  markInitialized(): void {
    this.initialized = true;
  }

  /**
   * Register a service handler.
   */
  register(service: string, handler: ServiceHandler): void {
    if (this.handlers.has(service)) {
      console.warn(`[ServiceDispatcher] Overwriting handler for service: ${service}`);
    }
    this.handlers.set(service, handler);
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
