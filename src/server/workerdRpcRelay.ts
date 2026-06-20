import type { DORefParam } from "@natstack/shared/userlandServiceRpc";
import {
  envelopeFromMessage,
  type AuthenticatedCaller,
  type CallerKind,
  type RpcEnvelope,
  type RpcResponse,
} from "@natstack/rpc";
import { Agent } from "undici";
import { isInternalDOSource } from "./internalDOs/internalDoLoader.js";

export type DORef = DORefParam;

/**
 * Dispatcher for HELD DO calls (the EvalDO's `executeRun`): no `headersTimeout`/`bodyTimeout`, so the
 * Node→workerd fetch isn't cut at undici's ~300s default while the DO holds the response for a long
 * (possibly 30-min) run. Used only when `deps.heldConnection` is set; all other calls use the default.
 */
export const HELD_CONNECTION_DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export function doRefKey(ref: DORef): string {
  return `${ref.source}:${ref.className}/${ref.objectKey}`;
}

/** Pack a userland DO ref for the UniversalDO facet host (see doDispatch). */
export function encodeUniversalKey(ref: DORef): string {
  return [ref.source, ref.className, ref.objectKey].map(encodeURIComponent).join("|");
}

export function doRefUrl(ref: DORef, method: string): string {
  const methodPath = method.split("/").map(encodeURIComponent).join("/");
  // Userland DOs route through the UniversalDO facet host; internal DOs keep
  // their static per-class `/_w/` namespaces. Kept in sync with doDispatch.ts.
  if (!isInternalDOSource(ref.source)) {
    return `/_u/${encodeURIComponent(encodeUniversalKey(ref))}/${methodPath}`;
  }
  const sourcePath = ref.source.split("/").map(encodeURIComponent).join("/");
  return `/_w/${sourcePath}/${encodeURIComponent(ref.className)}/${encodeURIComponent(ref.objectKey)}/${methodPath}`;
}

/** Canonical RPC target string for a DO (cosmetic on the wire; the DO reads its identity from the URL). */
export function doTargetString(ref: DORef): string {
  return `do:${ref.source}:${ref.className}:${ref.objectKey}`;
}

export interface DurableObjectRelayDeps {
  workerdUrl: string;
  workerdGatewayToken: string;
  workerdDispatchSecret?: string;
  callerId?: string;
  callerKind?: string;
  callerPanelId?: string;
  /** Correlation id for this call; lets the DO match a later deferred reply. */
  requestId?: string;
  /** Optional dedup key, propagated so reissued calls collapse server-side. */
  idempotencyKey?: string;
  /**
   * Held-connection call (the EvalDO's `executeRun`): use a no-`headersTimeout` undici dispatcher so
   * the fetch isn't reaped at undici's ~300s default while the DO holds the response for a long run.
   * The DO side disables its own `respond` reaper too (see `respondTimeoutMs`).
   */
  heldConnection?: boolean;
}

function generateRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function callerFromDeps(deps: DurableObjectRelayDeps): AuthenticatedCaller {
  return {
    callerId: deps.callerId ?? "main",
    callerKind: (deps.callerKind as CallerKind | undefined) ?? "server",
    ...(deps.callerPanelId ? { callerPanelId: deps.callerPanelId } : {}),
  };
}

function describeFetchCause(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const fields = cause as Error & {
    code?: unknown;
    errno?: unknown;
    syscall?: unknown;
    address?: unknown;
    port?: unknown;
  };
  const parts = [`${cause.name}: ${cause.message}`];
  for (const key of ["code", "errno", "syscall", "address", "port"] as const) {
    const value = fields[key];
    if (typeof value === "string" || typeof value === "number") {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join(" ");
}

function describeFetchFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  if (!cause) return message;
  return `${message} (cause: ${describeFetchCause(cause)})`;
}

/**
 * POST an `RpcEnvelope` to a DO's single `__rpc` endpoint (the converged
 * inbound dispatch). Caller attribution rides in `envelope.delivery.caller` /
 * `provenance` — no `X-Natstack-Rpc-Caller-*` headers. The DO feeds the
 * envelope to its `createRpcClient` core (`respond`/`deliver` → `handleEnvelope`
 * → `exposeAll`'d method) and returns a response envelope.
 */
async function postEnvelopeToDO(
  ref: DORef,
  envelope: RpcEnvelope,
  deps: DurableObjectRelayDeps
): Promise<unknown> {
  const url = `${deps.workerdUrl}${doRefUrl(ref, "__rpc")}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deps.workerdGatewayToken}`,
        ...(deps.workerdDispatchSecret
          ? { "X-NatStack-Dispatch-Secret": deps.workerdDispatchSecret }
          : {}),
      },
      body: JSON.stringify(envelope),
      ...(deps.heldConnection ? { dispatcher: HELD_CONNECTION_DISPATCHER } : {}),
    } as RequestInit);
  } catch (error) {
    const wrapped = new Error(
      `DO RPC fetch to ${url} failed: ${describeFetchFailure(error)}`
    ) as Error & { cause?: unknown };
    wrapped.cause = error;
    throw wrapped;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DO RPC relay failed (${res.status}): ${text}`);
  }

  return res.json();
}

function unwrapResponseEnvelope(raw: unknown): unknown {
  const responseEnvelope =
    raw && typeof raw === "object" && "envelope" in raw
      ? (raw as { envelope?: RpcEnvelope }).envelope
      : (raw as RpcEnvelope | undefined);
  const message = responseEnvelope?.message as RpcResponse | undefined;
  if (message && message.type === "response") {
    if ("error" in message) {
      const err = new Error(message.error) as Error & { code?: string; stack?: string };
      if (message.errorCode) err.code = message.errorCode;
      if (message.errorStack) err.stack = message.errorStack;
      throw err;
    }
    return message.result;
  }
  // Defensive: a base that produced a bare `{error}` (e.g. respond timeout).
  if (raw && typeof raw === "object" && "error" in raw) {
    throw new Error(String((raw as { error: unknown }).error));
  }
  return undefined;
}

/** Relay an RpcClient method call to a DO as a request envelope; returns the unwrapped result. */
export async function postToDurableObject(
  ref: DORef,
  method: string,
  args: unknown[],
  deps: DurableObjectRelayDeps
): Promise<unknown> {
  const caller = callerFromDeps(deps);
  const envelope = envelopeFromMessage({
    selfId: caller.callerId,
    from: caller.callerId,
    target: doTargetString(ref),
    caller,
    ...(deps.idempotencyKey ? { idempotencyKey: deps.idempotencyKey } : {}),
    message: {
      type: "request",
      requestId: deps.requestId ?? generateRequestId(),
      fromId: caller.callerId,
      method,
      args,
    },
  });
  return unwrapResponseEnvelope(await postEnvelopeToDO(ref, envelope, deps));
}

/** Relay an event to a DO as an event envelope (fire-and-forget). */
export async function postEventToDurableObject(
  ref: DORef,
  event: string,
  payload: unknown,
  deps: DurableObjectRelayDeps
): Promise<void> {
  const caller = callerFromDeps(deps);
  const envelope = envelopeFromMessage({
    selfId: caller.callerId,
    from: caller.callerId,
    target: doTargetString(ref),
    caller,
    message: { type: "event", fromId: caller.callerId, event, payload },
  });
  await postEnvelopeToDO(ref, envelope, deps);
}
