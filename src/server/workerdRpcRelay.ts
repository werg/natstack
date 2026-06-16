import type { DORefParam } from "@natstack/shared/userlandServiceRpc";
import { isInternalDOSource } from "./internalDOs/internalDoLoader.js";

export type DORef = DORefParam;

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

export async function postToDurableObject(
  ref: DORef,
  method: string,
  args: unknown[],
  deps: DurableObjectRelayDeps
): Promise<unknown> {
  const url = `${deps.workerdUrl}${doRefUrl(ref, method)}`;
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
        ...(deps.callerId ? { "X-Natstack-Rpc-Caller-Id": deps.callerId } : {}),
        ...(deps.callerKind ? { "X-Natstack-Rpc-Caller-Kind": deps.callerKind } : {}),
        ...(deps.callerPanelId ? { "X-Natstack-Rpc-Caller-Panel-Id": deps.callerPanelId } : {}),
        ...(deps.requestId ? { "X-Natstack-Rpc-Request-Id": deps.requestId } : {}),
        ...(deps.idempotencyKey ? { "X-Natstack-Rpc-Idempotency-Key": deps.idempotencyKey } : {}),
      },
      body: JSON.stringify(args),
    });
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
