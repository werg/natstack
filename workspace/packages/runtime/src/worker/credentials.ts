type RpcCallPayload = {
  method: string;
  args: unknown[];
};

type RpcResponse = {
  result?: unknown;
  error?: unknown;
  errorCode?: unknown;
};

type WorkerGlobals = typeof globalThis & {
  __natstack_rpc?: (payload: RpcCallPayload) => Promise<unknown>;
  __natstackEnv?: Record<string, string>;
};
import {
  createCredentialClient,
  type ConnectionRecord,
  type CredentialClient,
  type CredentialHandle,
} from "../shared/credentials.js";

async function callHostRpc<T>(method: string, ...args: unknown[]): Promise<T> {
  const globals = globalThis as WorkerGlobals;
  const payload: RpcCallPayload = { method, args };

  if (typeof globals.__natstack_rpc === "function") {
    return globals.__natstack_rpc(payload) as Promise<T>;
  }

  const env = globals.__natstackEnv;
  const serverUrl = env?.["SERVER_URL"];
  if (!serverUrl) {
    throw new Error("NatStack worker RPC is unavailable: missing __natstack_rpc and SERVER_URL");
  }

  const authToken = env["RPC_AUTH_TOKEN"];
  const headers = new Headers({ "Content-Type": "application/json" });
  if (authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }

  const response = await fetch(`${serverUrl}/rpc`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "call",
      targetId: "main",
      method,
      args,
    }),
  });

  const body = await response.json() as RpcResponse;
  if (body.error) {
    const error = new Error(String(body.error));
    if (typeof body.errorCode !== "undefined") {
      (error as Error & { code?: unknown }).code = body.errorCode;
    }
    throw error;
  }

  return body.result as T;
}

const client: CredentialClient = createCredentialClient({
  call<T>(targetId: string, method: string, ...args: unknown[]): Promise<T> {
    void targetId;
    return callHostRpc<T>(method, ...args);
  },
});

export async function connect(
  providerId: string,
  opts?: { connectionId?: string },
): Promise<CredentialHandle> {
  return client.connect(providerId, opts);
}

export async function revokeConsent(
  providerId: string,
  connectionId?: string,
): Promise<void> {
  await callHostRpc("credentials.revokeConsent", { providerId, connectionId });
}

export async function listConnections(providerId?: string): Promise<ConnectionRecord[]> {
  return client.listConnections(providerId);
}

export async function subscribeWebhook(
  providerId: string,
  eventType: string,
  opts: { handler: string; connectionId?: string },
): Promise<{ subscriptionId: string; leaseId?: string }> {
  return client.subscribeWebhook(providerId, eventType, opts);
}

export async function unsubscribeWebhook(subscriptionId: string): Promise<void> {
  await client.unsubscribeWebhook(subscriptionId);
}

export async function listWebhookLeases(filter?: {
  providerId?: string;
  eventType?: string;
  connectionId?: string;
}) {
  return client.listWebhookLeases(filter);
}

export type { CredentialHandle, ConnectionRecord, CredentialClient };
