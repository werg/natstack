import type { RpcCaller } from "@natstack/rpc";
import type { ProviderManifest } from "@natstack/shared/credentials/types";

export interface ConnectionRecord {
  providerId: string;
  connectionId: string;
  connectionLabel: string;
  accountIdentity: {
    email?: string;
    username?: string;
    workspaceName?: string;
    providerUserId: string;
  };
  scopes: string[];
  expiresAt?: number;
  metadata?: Record<string, string>;
}

export interface ProviderCapabilityMetadata {
  connectionId: string;
  accountIdentity: {
    email?: string;
    username?: string;
    workspaceName?: string;
    providerUserId: string;
  };
  claims?: Record<string, unknown>;
  expiresAt?: number;
}

export type ProviderDescriptor = Pick<
  ProviderManifest,
  "id" | "displayName" | "apiBase" | "flows" | "authInjection" | "capabilityShape" | "scopes" | "webhooks"
>;

export type ProviderRequest = ProviderDescriptor;

export interface CredentialHandle {
  readonly connectionId: string;
  readonly providerId: string;
  readonly provider: ProviderDescriptor;
  fetch(url: string | URL, init?: RequestInit): Promise<Response>;
}

export interface CredentialClient {
  connect(provider: ProviderRequest, opts?: { connectionId?: string }): Promise<CredentialHandle>;
  listConnections(providerId?: string): Promise<ConnectionRecord[]>;
  revokeConsent(providerId: string, connectionId?: string): Promise<void>;
  /** Mint a provider-bound capability. Triggers the consent bar on first use. */
  capabilityFor(
    provider: ProviderRequest,
    opts?: { connectionId?: string; ttlSeconds?: number },
  ): Promise<string>;
  /** A zero-arg async closure for library callbacks (getApiKey, apiKeyFn). */
  hookFor(
    provider: ProviderRequest,
    opts?: { connectionId?: string },
  ): () => Promise<string>;
  /** Server-extracted, non-secret credential metadata (JWT claims, account identity). */
  metadata(
    provider: ProviderRequest,
    opts?: { connectionId?: string },
  ): Promise<ProviderCapabilityMetadata>;
  subscribeWebhook(
    provider: ProviderRequest,
    eventType: string,
    opts: { handler: string; connectionId?: string },
  ): Promise<{ subscriptionId: string; leaseId?: string }>;
  unsubscribeWebhook(subscriptionId: string): Promise<void>;
  listWebhookLeases(filter?: {
    providerId?: string;
    eventType?: string;
    connectionId?: string;
  }): Promise<Array<{
    leaseId: string;
    providerId: string;
    eventType: string;
    connectionId: string;
    delivery: string;
    watchType: string;
    lastDeliveryAt?: number;
    cursor?: string;
  }>>;
}

const CAPABILITY_REFRESH_MARGIN_MS = 30_000;

export function createCredentialClient(
  rpc: RpcCaller,
): CredentialClient {
  async function mintCapability(
    provider: ProviderRequest,
    opts?: { connectionId?: string; ttlSeconds?: number },
  ): Promise<{ token: string; expiresAt: number }> {
    return rpc.call<{ token: string; expiresAt: number }>(
      "main",
      "capabilities.mint",
      {
        provider,
        connectionId: opts?.connectionId,
        ttlSeconds: opts?.ttlSeconds,
      },
    );
  }

  const client: CredentialClient = {
    async connect(provider, opts) {
      const result = await rpc.call<{ connectionId: string; providerId: string }>(
        "main",
        "credentials.resolveConnection",
        { providerId: provider.id, provider, connectionId: opts?.connectionId },
      );
      return createCredentialHandle(result.connectionId, provider, {
        capabilityFor: (pid, o) => client.capabilityFor(pid, o),
      });
    },
    async listConnections(providerId) {
      return rpc.call<ConnectionRecord[]>("main", "credentials.listConnections", { providerId });
    },
    async revokeConsent(providerId, connectionId) {
      await rpc.call<void>("main", "credentials.revokeConsent", { providerId, connectionId });
    },
    async capabilityFor(providerId, opts) {
      const minted = await mintCapability(providerId, opts);
      return minted.token;
    },
    hookFor(providerId, opts) {
      let cached: { token: string; expiresAt: number } | null = null;
      return async () => {
        const now = Date.now();
        if (cached && now < cached.expiresAt - CAPABILITY_REFRESH_MARGIN_MS) {
          return cached.token;
        }
        cached = await mintCapability(providerId, opts);
        return cached.token;
      };
    },
    async metadata(provider, opts) {
      return rpc.call<ProviderCapabilityMetadata>("main", "capabilities.metadata", {
        provider,
        connectionId: opts?.connectionId,
      });
    },
    async subscribeWebhook(provider, eventType, opts) {
      return rpc.call<{ subscriptionId: string; leaseId?: string }>(
        "main",
        "credentials.subscribeWebhook",
        { provider, eventType, connectionId: opts.connectionId, handler: opts.handler },
      );
    },
    async unsubscribeWebhook(subscriptionId) {
      await rpc.call<void>("main", "credentials.unsubscribeWebhook", { subscriptionId });
    },
    async listWebhookLeases(filter) {
      return rpc.call<Array<{
        leaseId: string;
        providerId: string;
        eventType: string;
        connectionId: string;
        delivery: string;
        watchType: string;
        lastDeliveryAt?: number;
        cursor?: string;
      }>>("main", "credentialWebhooks.listLeases", {
        providerId: filter?.providerId,
        eventType: filter?.eventType,
        connectionId: filter?.connectionId,
      });
    },
  };

  return client;
}

export function createCredentialHandle(
  connectionId: string,
  provider: ProviderDescriptor,
  deps: { capabilityFor: (provider: ProviderRequest, opts?: { connectionId?: string }) => Promise<string> },
): CredentialHandle {
  return {
    connectionId,
    providerId: provider.id,
    provider,
    async fetch(url: string | URL, init?: RequestInit): Promise<Response> {
      const cap = await deps.capabilityFor(provider, { connectionId });
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${cap}`);
      return fetch(url, { ...init, headers });
    },
  };
}
