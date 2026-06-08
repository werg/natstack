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
import type { CallerKind, CodeIdentityCallerKind } from "./principalKinds.js";
import type { AuthenticatedCaller } from "@natstack/rpc";
export type { CallerKind } from "./principalKinds.js";

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

export interface VerifiedCodeIdentity {
  /** Concrete caller this source/build attribution was verified for. */
  callerId: string;
  callerKind: CodeIdentityCallerKind;
  /** Workspace source path that produced this runtime. */
  repoPath: string;
  /** Effective build/content version for policy and audit. */
  effectiveVersion: string;
}

export interface VerifiedCaller {
  runtime: {
    /** Concrete runtime principal, e.g. a panel id or do:source:Class:objectKey. */
    id: string;
    kind: CallerKind;
  };
  /** Code/build identity verified at the trust boundary, when applicable. */
  code?: VerifiedCodeIdentity;
}

export function createVerifiedCaller(
  callerId: string,
  callerKind: CallerKind,
  code?: VerifiedCodeIdentity | null,
): VerifiedCaller {
  return {
    runtime: { id: callerId, kind: callerKind },
    ...(code ? { code } : {}),
  };
}

/**
 * Project a server-side `VerifiedCaller` to the canonical inbound-caller shape
 * (`AuthenticatedCaller`) shared with the bridge and Durable Objects. This is
 * the single vocabulary for "who's calling" across all three layers; the
 * server's `VerifiedCaller` keeps its richer capability/code identity on top.
 */
export function authenticatedCallerOf(caller: VerifiedCaller): AuthenticatedCaller {
  return { callerId: caller.runtime.id, callerKind: caller.runtime.kind };
}

/**
 * WebSocket client state exposed to service handlers.
 * The full WsClientState in src/server/rpcServer.ts extends this with the
 * concrete WebSocket type. Here `ws` is typed as `unknown` so shared code
 * doesn't depend on the ws package -- server-side consumers cast as needed.
 */
export interface WsClientInfo {
  ws: unknown;
  caller: VerifiedCaller;
  connectionId: string;
  authenticated: boolean;
}

/**
 * Sentinel a service handler returns (via `ctx.deferral.run`) to signal that
 * the call will complete out-of-band: the transport sends a `{deferred,requestId}`
 * ack instead of a response body, and the eventual result is delivered to the
 * caller through `onDeferredResult`. Used for human-gated calls (approvals,
 * credential use) so a hibernatable DO caller need not hold an inbound request open.
 */
export const DEFERRED_RESULT: unique symbol = Symbol.for("natstack.rpc.deferredResult");

export interface DeferredResult {
  readonly [DEFERRED_RESULT]: true;
  readonly requestId: string;
}

export function isDeferredResult(value: unknown): value is DeferredResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[DEFERRED_RESULT] === true
  );
}

export interface DeferralApi {
  /**
   * True when this call can complete out-of-band — the caller stamped a
   * `requestId` and is a principal that can receive an inbound `onDeferredResult`
   * (a DO/worker). Handlers must check this before calling `run`.
   */
  readonly canDefer: boolean;
  /**
   * Park the call: run `work` detached and deliver its eventual result (or error)
   * to the caller via `onDeferredResult`. Returns the sentinel the handler must
   * return so the transport sends a deferred ack instead of a body. Reissued or
   * concurrent calls sharing an `idempotencyKey` collapse onto one `work` run.
   */
  run(work: (signal: AbortSignal) => Promise<unknown>): DeferredResult;
}

/**
 * Run `produce` inline, or — when the caller opted into deferral and the call
 * would otherwise block on a human — park it via `ctx.deferral.run` and return
 * the sentinel for the transport to ack. `needsApproval` is the cheap pre-check
 * that decides; when false (e.g. a grant already exists) the fast path runs
 * inline with no extra round-trip. This keeps UX identical for the common case
 * and only changes the hold-open behavior when an approval is actually pending.
 */
export function deferIfNeeded<T>(
  ctx: ServiceContext,
  needsApproval: boolean,
  produce: (signal: AbortSignal) => Promise<T>,
): Promise<T> | DeferredResult {
  if (needsApproval && ctx.deferral?.canDefer) {
    return ctx.deferral.run(produce);
  }
  return produce(new AbortController().signal);
}

export type ServiceContext = {
  /** Canonical verified identity. Boundary code constructs this once. */
  caller: VerifiedCaller;
  /**
   * Upstream userland caller for an extension-originated service call. Set
   * only after the server validates an extension's opaque parent invocation
   * token against the active invocation table.
   */
  chainCaller?: VerifiedCodeIdentity;
  /** WS transport instance ID when caller connected via WebSocket. */
  connectionId?: string;
  /** WS client state when caller connected via WebSocket */
  wsClient?: WsClientInfo;
  /** Correlation id stamped by the caller; present on deferrable calls. */
  requestId?: string;
  /** Dedup key stamped by the caller, when provided. */
  idempotencyKey?: string;
  /**
   * Out-of-band completion controller, present only when the caller can receive
   * a deferred reply. Handlers gate on `deferral?.canDefer` before deferring.
   */
  deferral?: DeferralApi;
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

  constructor(
    service: string,
    method: string,
    message: string,
    code?: string,
    cause?: unknown,
  ) {
    super(`[${service}.${method}] ${message}`);
    this.service = service;
    this.method = method;
    this.code = code;
    this.name = "ServiceError";
    if (cause instanceof Error) {
      (this as Error & { cause?: unknown }).cause = cause;
      if (cause.stack) {
        this.stack = `${this.message}\nCaused by: ${cause.stack}`;
      }
    }
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
      checkServiceAccess(service, ctx.caller.runtime.kind, this, method);
    } catch (error) {
      throw new ServiceAccessError(
        service,
        method,
        ctx.caller.runtime.kind,
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
        error,
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
