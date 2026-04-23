export type WebhookDelivery = "https-post" | "pubsub-push";

export interface WebhookSubscription {
  subscriptionId: string;
  callerId: string;
  providerId: string;
  eventType: string;
  connectionId: string;
  handler: string;
  delivery: WebhookDelivery;
  watchType?: string;
  leaseId?: string;
  secret?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WebhookWatchLease {
  leaseId: string;
  providerId: string;
  eventType: string;
  connectionId: string;
  delivery: WebhookDelivery;
  watchType: string;
  identityKey?: string;
  callbackPath?: string;
  remoteChannelId?: string;
  remoteResourceId?: string;
  cursor?: string;
  secret?: string;
  expiresAt?: number;
  lastRenewedAt?: number;
  lastDeliveryAt?: number;
  state?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface WebhookEvent {
  provider: string;
  connectionId: string;
  event: string;
  delivery: WebhookDelivery;
  leaseId?: string;
  identityKey?: string;
  cursor?: string;
  previousCursor?: string;
  payload: unknown;
  headers?: Record<string, string>;
  receivedAt: number;
}

export type WebhookVerifier = (
  payload: Buffer | string,
  headers: Record<string, string>,
  secret: string,
) => boolean;
