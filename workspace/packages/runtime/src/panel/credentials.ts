import type { RpcCaller } from "@natstack/rpc";
import {
  createCredentialClient,
  type ConnectionRecord,
  type CredentialClient,
  type CredentialHandle,
  type ProviderDescriptor,
  type ProviderRequest,
} from "../shared/credentials.js";

let client: CredentialClient | null = null;

function requireClient(): CredentialClient {
  if (!client) {
    throw new Error("Panel credentials have not been initialized");
  }
  return client;
}

function shouldProxyPanelFetch(url: URL): boolean {
  if (url.protocol === "data:") {
    return false;
  }
  if (url.origin === location.origin) {
    return false;
  }
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return false;
  }
  return true;
}

function installPanelFetchProxy(rpc: RpcCaller): void {
  const globals = globalThis as typeof globalThis & {
    __natstackProxyFetchInstalled?: boolean;
  };
  if (globals.__natstackProxyFetchInstalled) {
    return;
  }

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const targetUrl = new URL(request.url, location.href);

    if (!shouldProxyPanelFetch(targetUrl)) {
      return originalFetch(input, init);
    }

    const headers = Object.fromEntries(request.headers.entries());

    const result = await rpc.call<{
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: string;
    }>("main", "credentials.proxyFetch", {
      url: targetUrl.toString(),
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
    });

    return new Response(result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  };

  globals.__natstackProxyFetchInstalled = true;
}

export function initPanelCredentials(rpc: RpcCaller): void {
  if (!client) {
    client = createCredentialClient(rpc);
  }
  installPanelFetchProxy(rpc);
}

export async function connect(providerId: ProviderRequest, opts?: { connectionId?: string }): Promise<CredentialHandle> {
  return requireClient().connect(providerId, opts);
}

export async function revokeConsent(
  providerId: string,
  connectionId?: string,
): Promise<void> {
  await requireClient().revokeConsent(providerId, connectionId);
}

export async function listConnections(providerId?: string): Promise<ConnectionRecord[]> {
  return requireClient().listConnections(providerId);
}

export async function capabilityFor(
  providerId: ProviderRequest,
  opts?: { connectionId?: string; ttlSeconds?: number },
): Promise<string> {
  return requireClient().capabilityFor(providerId, opts);
}

export function hookFor(
  providerId: ProviderRequest,
  opts?: { connectionId?: string },
): () => Promise<string> {
  return requireClient().hookFor(providerId, opts);
}

export async function metadata(
  providerId: ProviderRequest,
  opts?: { connectionId?: string },
) {
  return requireClient().metadata(providerId, opts);
}

export async function subscribeWebhook(
  providerId: ProviderRequest,
  eventType: string,
  opts: { handler: string; connectionId?: string },
): Promise<{ subscriptionId: string; leaseId?: string }> {
  return requireClient().subscribeWebhook(providerId, eventType, opts);
}

export async function unsubscribeWebhook(subscriptionId: string): Promise<void> {
  await requireClient().unsubscribeWebhook(subscriptionId);
}

export async function listWebhookLeases(filter?: {
  providerId?: string;
  eventType?: string;
  connectionId?: string;
}) {
  return requireClient().listWebhookLeases(filter);
}

export { type CredentialHandle, type CredentialClient, type ConnectionRecord, type ProviderDescriptor, type ProviderRequest };
