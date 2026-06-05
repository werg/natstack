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
}

export async function postToDurableObject(
  ref: DORef,
  method: string,
  args: unknown[],
  deps: DurableObjectRelayDeps
): Promise<unknown> {
  const res = await fetch(`${deps.workerdUrl}${doRefUrl(ref, method)}`, {
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
    },
    body: JSON.stringify(args),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DO RPC relay failed (${res.status}): ${text}`);
  }

  return res.json();
}
