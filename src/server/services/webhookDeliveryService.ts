import type { WebhookSubscriptionStore } from "../../../packages/shared/src/webhooks/subscription.js";
import type { WebhookEvent } from "../../../packages/shared/src/webhooks/types.js";
import type { WebhookWatchManager } from "./webhookWatchManager.js";

interface DeliveryResult {
  matched: number;
  delivered: number;
  failures: Array<{ subscriptionId: string; error: string }>;
}

interface WebhookDeliveryServiceDeps {
  webhookStore: Pick<
    WebhookSubscriptionStore,
    "listSubscriptions" | "deleteSubscription"
  >;
  webhookWatchManager: Pick<WebhookWatchManager, "releaseLease">;
  deliverToCaller: (callerId: string, handler: string, event: WebhookEvent) => Promise<void>;
}

export class WebhookDeliveryService {
  constructor(private readonly deps: WebhookDeliveryServiceDeps) {}

  async deliverEvent(event: WebhookEvent): Promise<DeliveryResult> {
    const subscriptions = event.leaseId
      ? this.deps.webhookStore.listSubscriptions({ leaseId: event.leaseId })
      : this.deps.webhookStore.listSubscriptions({
          providerId: event.provider,
          eventType: event.event,
          connectionId: event.connectionId,
        });

    const failures: Array<{ subscriptionId: string; error: string }> = [];
    let delivered = 0;

    for (const subscription of subscriptions) {
      try {
        await this.deps.deliverToCaller(subscription.callerId, subscription.handler, event);
        delivered += 1;
      } catch (error) {
        failures.push({
          subscriptionId: subscription.subscriptionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      matched: subscriptions.length,
      delivered,
      failures,
    };
  }

  async cleanupCaller(callerId: string): Promise<void> {
    const subscriptions = this.deps.webhookStore.listSubscriptions({ callerId });
    for (const subscription of subscriptions) {
      this.deps.webhookStore.deleteSubscription(subscription.subscriptionId);
      if (subscription.leaseId) {
        await this.deps.webhookWatchManager.releaseLease(subscription.leaseId);
      }
    }
  }
}
