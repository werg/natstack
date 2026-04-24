import { randomBytes, randomUUID } from "node:crypto";

import { buildPublicUrl } from "../publicUrl.js";
import type { CredentialStore } from "../../../packages/shared/src/credentials/store.js";
import type { Credential, ProviderManifest, WebhookSubscriptionConfig } from "../../../packages/shared/src/credentials/types.js";
import type { ProviderRegistry } from "../../../packages/shared/src/credentials/registry.js";
import type { WebhookSubscriptionStore } from "../../../packages/shared/src/webhooks/subscription.js";
import type { WebhookEvent, WebhookWatchLease } from "../../../packages/shared/src/webhooks/types.js";

const RENEWAL_WINDOW_MS = 30 * 60 * 1000;

interface PubsubEnvelope {
  message?: {
    data?: string;
    attributes?: Record<string, string>;
    messageId?: string;
    publishTime?: string;
  };
  subscription?: string;
}

interface GmailPushPayload {
  emailAddress?: string;
  historyId?: string;
}

export interface WebhookWatchManagerDeps {
  credentialStore: Pick<CredentialStore, "load">;
  providerRegistry: Pick<ProviderRegistry, "get">;
  webhookStore: Pick<
    WebhookSubscriptionStore,
    | "countSubscriptionsForLease"
    | "deleteLease"
    | "findLeaseByIdentity"
    | "getLease"
    | "listLeases"
    | "touchLeaseDelivery"
    | "upsertLease"
  >;
  relayBaseUrl?: string;
}

interface EnsureLeaseParams {
  providerId: string;
  eventType: string;
  connectionId: string;
}

export class WebhookWatchManager {
  constructor(private readonly deps: WebhookWatchManagerDeps) {}

  async ensureLease(params: EnsureLeaseParams): Promise<WebhookWatchLease> {
    const { manifest, subscriptionConfig } = this.getSubscriptionConfig(params.providerId, params.eventType);
    const watch = subscriptionConfig.watch;
    if (!watch) {
      throw new Error(`Provider ${params.providerId}:${params.eventType} does not declare a managed watch`);
    }

    const existing = this.deps.webhookStore.listLeases({
      providerId: params.providerId,
      eventType: params.eventType,
      connectionId: params.connectionId,
      watchType: watch.type,
    })[0];

    if (existing && !this.shouldRenew(existing, subscriptionConfig)) {
      return existing;
    }

    switch (watch.type) {
      case "gmail-watch":
        return this.ensureGmailWatch(existing, manifest, subscriptionConfig, params.connectionId);
      case "calendar-watch":
        return this.ensureCalendarWatch(existing, manifest, subscriptionConfig, params.connectionId);
      default:
        throw new Error(`Unsupported watch type: ${watch.type}`);
    }
  }

  async releaseLease(leaseId: string): Promise<void> {
    if (this.deps.webhookStore.countSubscriptionsForLease(leaseId) > 0) {
      return;
    }

    const lease = this.deps.webhookStore.getLease(leaseId);
    if (!lease) {
      return;
    }

    const manifest = this.deps.providerRegistry.get(lease.providerId);
    const credential = await this.requireCredential(lease.providerId, lease.connectionId);

    switch (lease.watchType) {
      case "gmail-watch":
        await this.stopGmailWatch(manifest, credential);
        break;
      case "calendar-watch":
        await this.stopCalendarWatch(manifest, credential, lease);
        break;
      default:
        break;
    }

    this.deps.webhookStore.deleteLease(leaseId);
  }

  async reconcileLeases(): Promise<void> {
    for (const lease of this.deps.webhookStore.listLeases()) {
      if (this.deps.webhookStore.countSubscriptionsForLease(lease.leaseId) === 0) {
        this.deps.webhookStore.deleteLease(lease.leaseId);
        continue;
      }

      const { subscriptionConfig } = this.getSubscriptionConfig(lease.providerId, lease.eventType);
      if (!this.shouldRenew(lease, subscriptionConfig)) {
        continue;
      }

      await this.ensureLease({
        providerId: lease.providerId,
        eventType: lease.eventType,
        connectionId: lease.connectionId,
      });
    }
  }

  async handlePubsubPush(providerId: string, rawBody: string, headers: Record<string, string>): Promise<WebhookEvent | null> {
    const envelope = JSON.parse(rawBody) as PubsubEnvelope;
    const payloadJson = envelope.message?.data
      ? Buffer.from(envelope.message.data, "base64").toString("utf8")
      : "{}";
    const payload = JSON.parse(payloadJson) as GmailPushPayload;
    const identityKey = payload.emailAddress;
    if (!identityKey) {
      return null;
    }

    const lease = this.deps.webhookStore.findLeaseByIdentity(providerId, identityKey);
    if (!lease) {
      return null;
    }

    const previousCursor = lease.cursor;
    this.deps.webhookStore.touchLeaseDelivery(lease.leaseId, {
      cursor: payload.historyId,
      lastDeliveryAt: Date.now(),
    });

    return {
      provider: providerId,
      connectionId: lease.connectionId,
      event: lease.eventType,
      delivery: "pubsub-push",
      leaseId: lease.leaseId,
      identityKey,
      cursor: payload.historyId,
      previousCursor,
      payload: {
        envelope,
        data: payload,
      },
      headers,
      receivedAt: Date.now(),
    };
  }

  async handleChannelPush(leaseId: string, rawBody: string, headers: Record<string, string>): Promise<WebhookEvent | null> {
    const lease = this.deps.webhookStore.getLease(leaseId);
    if (!lease) {
      return null;
    }

    const channelId = this.readHeader(headers, "x-goog-channel-id");
    if (lease.remoteChannelId && channelId && lease.remoteChannelId !== channelId) {
      return null;
    }

    const token = this.readHeader(headers, "x-goog-channel-token");
    if (lease.secret && token !== lease.secret) {
      return null;
    }

    this.deps.webhookStore.touchLeaseDelivery(lease.leaseId, {
      lastDeliveryAt: Date.now(),
    });

    return {
      provider: lease.providerId,
      connectionId: lease.connectionId,
      event: lease.eventType,
      delivery: lease.delivery,
      leaseId: lease.leaseId,
      identityKey: lease.identityKey,
      cursor: lease.cursor,
      payload: rawBody.length > 0 ? safeJson(rawBody) : null,
      headers,
      receivedAt: Date.now(),
    };
  }

  private async ensureGmailWatch(
    existing: WebhookWatchLease | undefined,
    manifest: ProviderManifest,
    subscriptionConfig: WebhookSubscriptionConfig,
    connectionId: string,
  ): Promise<WebhookWatchLease> {
    const topicName = process.env["NATSTACK_GOOGLE_PUBSUB_TOPIC"];
    if (!topicName) {
      throw new Error("NATSTACK_GOOGLE_PUBSUB_TOPIC is required for Gmail push watches");
    }

    const credential = await this.requireCredential(manifest.id, connectionId);
    const response = await this.fetchWithCredential(
      manifest,
      credential,
      "https://gmail.googleapis.com/gmail/v1/users/me/watch",
      {
        method: "POST",
        body: JSON.stringify({ topicName }),
      },
    );

    const payload = await parseJsonResponse<{
      historyId?: string;
      expiration?: string;
    }>(response, "Failed to create Gmail watch");
    const now = Date.now();
    const lease = this.deps.webhookStore.upsertLease({
      leaseId: existing?.leaseId ?? randomUUID(),
      providerId: manifest.id,
      eventType: subscriptionConfig.event,
      connectionId,
      delivery: subscriptionConfig.delivery,
      watchType: subscriptionConfig.watch?.type ?? "gmail-watch",
      identityKey: credential.accountIdentity.email ?? credential.accountIdentity.providerUserId,
      cursor: payload.historyId,
      expiresAt: payload.expiration ? Number(payload.expiration) : undefined,
      lastRenewedAt: now,
      state: { topicName },
    });

    return lease;
  }

  private async ensureCalendarWatch(
    existing: WebhookWatchLease | undefined,
    manifest: ProviderManifest,
    subscriptionConfig: WebhookSubscriptionConfig,
    connectionId: string,
  ): Promise<WebhookWatchLease> {
    const credential = await this.requireCredential(manifest.id, connectionId);
    const leaseId = existing?.leaseId ?? randomUUID();
    const secret = existing?.secret ?? randomBytes(24).toString("hex");
    const callbackPath = existing?.callbackPath ?? this.buildCallbackPath(leaseId);
    const channelId = randomUUID();
    const requestedExpiration = this.computeRequestedExpiration(subscriptionConfig);
    const response = await this.fetchWithCredential(
      manifest,
      credential,
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/watch",
      {
        method: "POST",
        body: JSON.stringify({
          id: channelId,
          type: "web_hook",
          address: this.buildCallbackUrl(callbackPath),
          token: secret,
          expiration: requestedExpiration,
        }),
      },
    );

    const payload = await parseJsonResponse<{
      id?: string;
      resourceId?: string;
      resourceUri?: string;
      expiration?: string;
    }>(response, "Failed to create Calendar watch");

    if (existing?.remoteChannelId && existing.remoteResourceId) {
      await this.stopCalendarWatch(manifest, credential, existing).catch(() => undefined);
    }

    const now = Date.now();
    return this.deps.webhookStore.upsertLease({
      leaseId,
      providerId: manifest.id,
      eventType: subscriptionConfig.event,
      connectionId,
      delivery: subscriptionConfig.delivery,
      watchType: subscriptionConfig.watch?.type ?? "calendar-watch",
      identityKey: credential.accountIdentity.email ?? credential.accountIdentity.providerUserId,
      callbackPath,
      remoteChannelId: payload.id ?? channelId,
      remoteResourceId: payload.resourceId,
      secret,
      expiresAt: payload.expiration ? Number(payload.expiration) : requestedExpiration,
      lastRenewedAt: now,
      state: payload.resourceUri ? { resourceUri: payload.resourceUri } : undefined,
    });
  }

  private async stopGmailWatch(manifest: ProviderManifest | undefined, credential: Credential): Promise<void> {
    if (!manifest) {
      return;
    }

    await this.fetchWithCredential(
      manifest,
      credential,
      "https://gmail.googleapis.com/gmail/v1/users/me/stop",
      { method: "POST" },
    ).catch(() => undefined);
  }

  private async stopCalendarWatch(
    manifest: ProviderManifest | undefined,
    credential: Credential,
    lease: WebhookWatchLease,
  ): Promise<void> {
    if (!manifest || !lease.remoteChannelId || !lease.remoteResourceId) {
      return;
    }

    await this.fetchWithCredential(
      manifest,
      credential,
      "https://www.googleapis.com/calendar/v3/channels/stop",
      {
        method: "POST",
        body: JSON.stringify({
          id: lease.remoteChannelId,
          resourceId: lease.remoteResourceId,
        }),
      },
    ).catch(() => undefined);
  }

  private getSubscriptionConfig(providerId: string, eventType: string): {
    manifest: ProviderManifest;
    subscriptionConfig: WebhookSubscriptionConfig;
  } {
    const manifest = this.deps.providerRegistry.get(providerId);
    if (!manifest) {
      throw new Error(`Unknown provider: ${providerId}`);
    }

    const subscriptionConfig = manifest.webhooks?.subscriptions?.find((entry) => entry.event === eventType);
    if (!subscriptionConfig) {
      throw new Error(`Provider ${providerId} does not declare webhook event ${eventType}`);
    }

    return { manifest, subscriptionConfig };
  }

  private shouldRenew(lease: WebhookWatchLease, subscriptionConfig: WebhookSubscriptionConfig): boolean {
    const now = Date.now();
    if (lease.expiresAt && lease.expiresAt - now <= RENEWAL_WINDOW_MS) {
      return true;
    }

    const renewEveryHours = subscriptionConfig.watch?.renewEveryHours;
    if (!renewEveryHours || !lease.lastRenewedAt) {
      return false;
    }

    return lease.lastRenewedAt + renewEveryHours * 60 * 60 * 1000 <= now;
  }

  private async requireCredential(providerId: string, connectionId: string): Promise<Credential> {
    const credential = await Promise.resolve(this.deps.credentialStore.load(providerId, connectionId));
    if (!credential) {
      throw new Error(`No credential found for ${providerId}:${connectionId}`);
    }
    return credential;
  }

  private computeRequestedExpiration(subscriptionConfig: WebhookSubscriptionConfig): number {
    const renewEveryHours = subscriptionConfig.watch?.renewEveryHours ?? 24;
    return Date.now() + renewEveryHours * 60 * 60 * 1000;
  }

  private buildCallbackPath(leaseId: string): string {
    return `/_r/s/credentialWebhooks/calendar/${leaseId}`;
  }

  private buildCallbackUrl(callbackPath: string): string {
    const relayBaseUrl = normalizeUrlBase(this.deps.relayBaseUrl);
    if (relayBaseUrl) {
      return `${relayBaseUrl}${callbackPath.replace("/_r/s/credentialWebhooks/calendar/", "/calendar/")}`;
    }
    return buildPublicUrl(callbackPath);
  }

  private async fetchWithCredential(
    manifest: ProviderManifest,
    credential: Credential,
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const injection = manifest.authInjection;
    if (injection?.type === "query-param" && injection.paramName) {
      const target = new URL(url);
      target.searchParams.set(injection.paramName, credential.accessToken);
      url = target.toString();
    } else {
      const headerName = injection?.headerName ?? "Authorization";
      const valueTemplate = injection?.valueTemplate ?? "Bearer {token}";
      headers.set(headerName, valueTemplate.replace("{token}", credential.accessToken));
    }

    const response = await fetch(url, { ...init, headers });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Webhook watch request failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`,
      );
    }
    return response;
  }

  private readHeader(headers: Record<string, string>, name: string): string | undefined {
    const direct = headers[name];
    if (direct !== undefined) {
      return direct;
    }

    const lowered = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === lowered) {
        return value;
      }
    }
    return undefined;
  }
}

function normalizeUrlBase(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function parseJsonResponse<T>(response: Response, context: string): Promise<T> {
  try {
    return await response.json() as T;
  } catch (error) {
    throw new Error(`${context}: invalid JSON response (${error instanceof Error ? error.message : String(error)})`);
  }
}

function safeJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return rawBody;
  }
}
