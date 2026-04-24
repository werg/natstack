/**
 * ServiceDispatcher - Unified service dispatch for panels and shell.
 *
 * Panels and the shell renderer call main process services
 * like bridge, ai, db, browser, fs. This module provides a single registry
 * and dispatch mechanism that all code paths use.
 */

import { z } from "zod";
import type { ServiceDefinition, MethodDef } from "./serviceDefinition.js";
import type { ServicePolicy } from "./servicePolicy.js";
import { checkServiceAccess } from "./servicePolicy.js";

/**
 * Normalize an args array for wire compatibility with a Zod tuple schema.
 *
 * RPC args arrive as JSON arrays where:
 * - Trailing optional args may be omitted entirely (shorter array)
 * - `undefined` values become `null` after JSON round-trip
 *
 * This function pads short arrays to the expected tuple length and replaces
 * trailing `null` with `undefined` so Zod's `.optional()` accepts them.
 */
function normalizeArgs(args: unknown[], schema: z.ZodType): unknown[] {
  if (!(schema instanceof z.ZodTuple)) return args;

  const items = (schema as z.ZodTuple)._def.items as z.ZodType[];
  if (args.length >= items.length) {
    // Full-length array — just fix null→undefined for optional positions
    return args.map((arg, i) => {
      if (arg === null && i < items.length && items[i]!.isOptional()) {
        return undefined;
      }
      return arg;
    });
  }

  // Short array — pad with undefined for missing optional trailing args
  const padded = [...args];
  for (let i = args.length; i < items.length; i++) {
    padded.push(undefined);
  }
  // Also fix null→undefined in the provided args
  return padded.map((arg, i) => {
    if (arg === null && i < items.length && items[i]!.isOptional()) {
      return undefined;
    }
    return arg;
  });
}

export type CallerKind = "panel" | "shell" | "server" | "worker" | "harness";

/**
 * WebSocket client state exposed to service handlers.
 * The full WsClientState in src/server/rpcServer.ts extends this with the
 * concrete WebSocket type. Here `ws` is typed as `unknown` so shared code
 * doesn't depend on the ws package -- server-side consumers cast as needed.
 */
export interface WsClientInfo {
  ws: unknown;
  callerId: string;
  callerKind: CallerKind;
  authenticated: boolean;
}

export type ServiceContext = {
  /** The caller ID (panel/worker tree node ID, or "shell" for the shell renderer) */
  callerId: string;
  /** Whether the caller is a panel, worker, shell, or external server */
  callerKind: CallerKind;
  /** WS client state when caller connected via WebSocket */
  wsClient?: WsClientInfo;
};

export type ServiceHandler = (
  ctx: ServiceContext,
  method: string,
  args: unknown[]
) => Promise<unknown>;

export class ServiceError extends Error {
  public readonly service: string;
  public readonly method: string;
  /** Preserved error code from the original error (e.g. "ENOENT") */
  public readonly code?: string;

  constructor(service: string, method: string, message: string, code?: string) {
    super(`[${service}.${method}] ${message}`);
    this.service = service;
    this.method = method;
    this.code = code;
    this.name = "ServiceError";
  }
}

/**
 * Structured access-denied error thrown when a caller's `callerKind` is not
 * permitted by a service / method policy. Carries `code: "EACCES"` so transports
 * can map this to a 403 / structured RPC error code rather than a bare string.
 */
export class ServiceAccessError extends ServiceError {
  constructor(service: string, method: string, callerKind: CallerKind, message?: string) {
    super(
      service,
      method,
      message ?? `Service '${service}.${method}' is not accessible to ${callerKind} callers`,
      "EACCES",
    );
    this.name = "ServiceAccessError";
  }
}

/**
 * Service dispatcher — all services registered via registerService().
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
   * Register a service with full definition (schema, policy, handler).
   *
   * If a service with the same name was already registered, the previous
   * definition is replaced and a warning is logged (audit finding #35 /
   * 02-Low-15: silent overrides should be audible). The previous
   * definition is returned so callers can detect the replacement.
   */
  registerService(def: ServiceDefinition): ServiceDefinition | undefined {
    const previous = this.definitions.get(def.name);
    if (previous || this.handlers.has(def.name)) {
      // Keep the word "Overwriting" so existing audits/log queries still
      // match. The new "Replacing" verb makes the audit-finding-#35 fix
      // (warn-then-replace-and-return-previous) visible.
      console.warn(
        `[ServiceDispatcher] Overwriting handler for service: ${def.name} ` +
        `(replacing previous registration; description: ${previous?.description ?? "<unknown>"})`,
      );
    }
    this.definitions.set(def.name, def);
    this.handlers.set(def.name, def.handler);
    return previous;
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

    // Single-choke-point policy enforcement (audit findings #3 / #18).
    // Every dispatch path — Electron IPC, WS, HTTP-RPC, IpcDispatcher,
    // serverClient forward — flows through here, so this is the one place
    // policy MUST be checked. Transports may also keep their own
    // checkServiceAccess() call as defense-in-depth, but this is the
    // load-bearing check.
    try {
      checkServiceAccess(service, ctx.callerKind, this, method);
    } catch (error) {
      throw new ServiceAccessError(
        service,
        method,
        ctx.callerKind,
        error instanceof Error ? error.message : String(error),
      );
    }

    // Validate args against schema if method has a definition
    const def = this.definitions.get(service);
    if (def) {
      const methodDef = def.methods[method];
      if (methodDef) {
        // Normalize args for wire compatibility: RPC args arrive as JSON arrays
        // where trailing optional args may be omitted (shorter array) or null
        // (JSON serialization of undefined). Pad short arrays to match the
        // tuple length and replace null with undefined so Zod's .optional()
        // accepts them.
        const normalized = normalizeArgs(args, methodDef.args);
        const parsed = methodDef.args.safeParse(normalized);
        if (!parsed.success) {
          throw new ServiceError(
            service,
            method,
            `Invalid args: ${parsed.error.message}`
          );
        }
        // Use normalized args so handlers see undefined (not null) for optional params
        args = normalized;
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
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
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
   * Get the policy for a service (from ServiceDefinition).
   */
  getPolicy(service: string): ServicePolicy | undefined {
    return this.definitions.get(service)?.policy;
  }

  getMethodPolicy(service: string, method: string): ServicePolicy | undefined {
    const def = this.definitions.get(service);
    if (!def) return undefined;
    return def.methods[method]?.policy;
  }
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
