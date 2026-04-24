import type { RpcCaller } from "@natstack/rpc";

const CONNECTION_HEADER = "x-natstack-connection";

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

export interface CredentialHandle {
  readonly connectionId: string;
  readonly providerId: string;
  fetch(url: string | URL, init?: RequestInit): Promise<Response>;
}

export interface CredentialClient {
  connect(providerId: string, opts?: { connectionId?: string }): Promise<CredentialHandle>;
  listConnections(providerId?: string): Promise<ConnectionRecord[]>;
  revokeConsent(providerId: string, connectionId?: string): Promise<void>;
  subscribeWebhook(
    providerId: string,
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

export function createCredentialHandle(
  connectionId: string,
  providerId: string,
): CredentialHandle {
  return {
    connectionId,
    providerId,
    fetch(url: string | URL, init?: RequestInit): Promise<Response> {
      const headers = new Headers(init?.headers);
      headers.set(CONNECTION_HEADER, connectionId);
      return fetch(url, { ...init, headers });
    },
  };
}

export function createCredentialClient(rpc: RpcCaller): CredentialClient {
  return {
    async connect(providerId, opts) {
      const result = await rpc.call<{ connectionId: string; providerId: string }>(
        "main",
        "credentials.resolveConnection",
        { providerId, connectionId: opts?.connectionId },
      );
      return createCredentialHandle(result.connectionId, result.providerId);
    },
    async listConnections(providerId) {
      return rpc.call<ConnectionRecord[]>("main", "credentials.listConnections", { providerId });
    },
    async revokeConsent(providerId, connectionId) {
      await rpc.call<void>("main", "credentials.revokeConsent", { providerId, connectionId });
    },
    async subscribeWebhook(providerId, eventType, opts) {
      return rpc.call<{ subscriptionId: string; leaseId?: string }>(
        "main",
        "credentials.subscribeWebhook",
        { providerId, eventType, connectionId: opts.connectionId, handler: opts.handler },
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
}
