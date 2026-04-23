import type { WebhookSubscriptionConfig } from '../credentials/types.js';

export interface WebhookSubscription {
  subscriptionId: string;
  workerId: string;
  providerId: string;
  eventType: string;
  delivery: 'https-post' | 'pubsub-push';
  secret?: string;
  createdAt: number;
}

export interface WebhookEvent {
  provider: string;
  connectionId: string;
  event: string;
  delivery: 'https-post' | 'pubsub-push';
  payload: unknown;
  headers?: Record<string, string>;
  receivedAt: number;
}

export type WebhookVerifier = (
  payload: Buffer | string,
  headers: Record<string, string>,
  secret: string,
) => boolean;
