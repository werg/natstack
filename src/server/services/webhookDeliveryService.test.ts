import { describe, expect, it, vi } from "vitest";

import type { WebhookEvent, WebhookSubscription } from "../../../packages/shared/src/webhooks/types.js";
import { WebhookDeliveryService } from "./webhookDeliveryService.js";

function createSubscription(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    subscriptionId: "sub-1",
    callerId: "worker:mail-sync",
    providerId: "google-workspace",
    eventType: "message.new",
    connectionId: "conn-1",
    handler: "__webhook__.gmail.message_new",
    delivery: "pubsub-push",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function createEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    provider: "google-workspace",
    connectionId: "conn-1",
    event: "message.new",
    delivery: "pubsub-push",
    leaseId: "lease-1",
    payload: { data: { historyId: "42" } },
    receivedAt: Date.now(),
    ...overrides,
  };
}

describe("WebhookDeliveryService", () => {
  it("routes an event to each subscribed handler", async () => {
    const deliverToCaller = vi.fn();
    const service = new WebhookDeliveryService({
      webhookStore: {
        listSubscriptions: vi.fn(() => [
          createSubscription(),
          createSubscription({
            subscriptionId: "sub-2",
            handler: "__webhook__.gmail.audit",
          }),
        ]),
        deleteSubscription: vi.fn(),
      },
      webhookWatchManager: {
        releaseLease: vi.fn(),
      },
      deliverToCaller,
    });

    const result = await service.deliverEvent(createEvent());

    expect(result).toEqual({
      matched: 2,
      delivered: 2,
      failures: [],
    });
    expect(deliverToCaller).toHaveBeenCalledWith(
      "worker:mail-sync",
      "__webhook__.gmail.message_new",
      expect.objectContaining({ event: "message.new" }),
    );
  });

  it("removes a caller's subscriptions and releases managed leases", async () => {
    const deleteSubscription = vi.fn();
    const releaseLease = vi.fn();
    const service = new WebhookDeliveryService({
      webhookStore: {
        listSubscriptions: vi.fn(() => [
          createSubscription({ leaseId: "lease-1" }),
          createSubscription({ subscriptionId: "sub-2", leaseId: undefined }),
        ]),
        deleteSubscription,
      },
      webhookWatchManager: {
        releaseLease,
      },
      deliverToCaller: vi.fn(),
    });

    await service.cleanupCaller("worker:mail-sync");

    expect(deleteSubscription).toHaveBeenCalledTimes(2);
    expect(releaseLease).toHaveBeenCalledWith("lease-1");
  });
});
