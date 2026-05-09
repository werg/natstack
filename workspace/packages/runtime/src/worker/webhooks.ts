import {
  createWebhookIngressClient,
  type CreateWebhookIngressSubscriptionRequest,
  type RotateWebhookIngressSecretResult,
  type WebhookIngressClient,
  type WebhookIngressSubscriptionSummary,
} from "../shared/webhooks.js";
import { workerHostRpcCaller } from "./hostRpc.js";

const client: WebhookIngressClient = createWebhookIngressClient(workerHostRpcCaller);

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
