import {
  createWebhookIngressClient,
  type CreateWebhookIngressSubscriptionRequest,
  type RotateWebhookIngressSecretResult,
  type WebhookIngressClient,
  type WebhookIngressSubscriptionSummary,
} from "../shared/webhooks.js";

type RpcCallPayload = {
  method: string;
  args: unknown[];
};

type WorkerGlobals = typeof globalThis & {
  __natstack_rpc?: (payload: RpcCallPayload) => Promise<unknown>;
  __natstackEnv?: Record<string, string>;
};

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

  const response = await globalThis.fetch(`${serverUrl}/rpc`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "call",
      targetId: "main",
      method,
      args,
    }),
  });

  const body = await response.json() as { result?: unknown; error?: unknown };
  if (body.error) {
    throw new Error(String(body.error));
  }

  return body.result as T;
}

const client: WebhookIngressClient = createWebhookIngressClient({
  call<T>(_targetId: string, method: string, ...args: unknown[]): Promise<T> {
    return callHostRpc<T>(method, ...args);
  },
});

export function createSubscription(
  input: CreateWebhookIngressSubscriptionRequest,
): Promise<WebhookIngressSubscriptionSummary> {
  return client.createSubscription(input);
}

export function listSubscriptions(): Promise<WebhookIngressSubscriptionSummary[]> {
  return client.listSubscriptions();
}

export function revokeSubscription(subscriptionId: string): Promise<void> {
  return client.revokeSubscription(subscriptionId);
}

export function rotateSecret(
  subscriptionId: string,
  secret?: string,
): Promise<RotateWebhookIngressSecretResult> {
  return client.rotateSecret(subscriptionId, secret);
}

export type {
  CreateWebhookIngressSubscriptionRequest,
  RotateWebhookIngressSecretRequest,
  RotateWebhookIngressSecretResult,
  WebhookIngressClient,
  WebhookIngressSubscriptionSummary,
  WebhookTarget,
  WebhookVerifierConfig,
} from "../shared/webhooks.js";
