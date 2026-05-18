import type { DORefParam } from "@natstack/shared/userlandServiceRpc";

export type DORef = DORefParam;

export function doRefKey(ref: DORef): string {
  return `${ref.source}:${ref.className}/${ref.objectKey}`;
}

export function doRefUrl(ref: DORef, method: string): string {
  const sourcePath = ref.source.split("/").map(encodeURIComponent).join("/");
  return `/_w/${sourcePath}/${encodeURIComponent(ref.className)}/${encodeURIComponent(ref.objectKey)}/${encodeURIComponent(method)}`;
}

export interface DurableObjectRelayDeps {
  workerdUrl: string;
  workerdGatewayToken: string;
  workerdDispatchSecret?: string;
  callerId?: string;
  callerKind?: string;
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
    },
    body: JSON.stringify(args),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DO RPC relay failed (${res.status}): ${text}`);
  }

  return res.json();
}
