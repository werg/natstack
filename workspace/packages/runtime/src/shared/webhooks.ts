import type { RpcCaller } from "@natstack/rpc";
import type {
  CreateWebhookIngressSubscriptionRequest,
  RotateWebhookIngressSecretResult,
  WebhookIngressSubscriptionSummary,
} from "@natstack/shared/webhooks/ingress";

export type {
  CreateWebhookIngressSubscriptionRequest,
  RotateWebhookIngressSecretRequest,
  RotateWebhookIngressSecretResult,
  WebhookIngressSubscriptionSummary,
  WebhookTarget,
  WebhookVerifierConfig,
} from "@natstack/shared/webhooks/ingress";

export interface WebhookIngressClient {
  createSubscription(input: CreateWebhookIngressSubscriptionRequest): Promise<WebhookIngressSubscriptionSummary>;
  listSubscriptions(): Promise<WebhookIngressSubscriptionSummary[]>;
  revokeSubscription(subscriptionId: string): Promise<void>;
  rotateSecret(subscriptionId: string, secret?: string): Promise<RotateWebhookIngressSecretResult>;
}

export function createWebhookIngressClient(rpc: RpcCaller): WebhookIngressClient {
  return {
    createSubscription(input) {
      return rpc.call<WebhookIngressSubscriptionSummary>(
        "main",
        "webhookIngress.createSubscription",
        input,
      );
    },
    listSubscriptions() {
      return rpc.call<WebhookIngressSubscriptionSummary[]>(
        "main",
        "webhookIngress.listSubscriptions",
      );
    },
    async revokeSubscription(subscriptionId) {
      await rpc.call<void>(
        "main",
        "webhookIngress.revokeSubscription",
        { subscriptionId },
      );
    },
    rotateSecret(subscriptionId, secret) {
      return rpc.call<RotateWebhookIngressSecretResult>(
        "main",
        "webhookIngress.rotateSecret",
        { subscriptionId, secret },
      );
    },
  };
}
