import { describe, expect, it, vi } from "vitest";

import type { WebhookWatchLease } from "../../../packages/shared/src/webhooks/types.js";
import { WebhookWatchManager } from "./webhookWatchManager.js";

function createLease(overrides: Partial<WebhookWatchLease> = {}): WebhookWatchLease {
  return {
    leaseId: "lease-1",
    providerId: "google-workspace",
    eventType: "message.new",
    connectionId: "conn-1",
    delivery: "pubsub-push",
    watchType: "gmail-watch",
    identityKey: "user@example.com",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("WebhookWatchManager", () => {
  it("routes Gmail Pub/Sub deliveries by identity key and updates the cursor", async () => {
    const touchLeaseDelivery = vi.fn();
    const manager = new WebhookWatchManager({
      credentialStore: { load: vi.fn() },
      providerRegistry: { get: vi.fn() },
      webhookStore: {
        countSubscriptionsForLease: vi.fn(),
        deleteLease: vi.fn(),
        findLeaseByIdentity: vi.fn(() => createLease()),
        getLease: vi.fn(),
        listLeases: vi.fn(() => []),
        touchLeaseDelivery,
        upsertLease: vi.fn(),
      },
    });

    const payload = Buffer.from(
      JSON.stringify({ emailAddress: "user@example.com", historyId: "4242" }),
      "utf8",
    ).toString("base64");

    const event = await manager.handlePubsubPush(
      "google-workspace",
      JSON.stringify({ message: { data: payload } }),
      { "content-type": "application/json" },
    );

    expect(event).toMatchObject({
      provider: "google-workspace",
      connectionId: "conn-1",
      event: "message.new",
      identityKey: "user@example.com",
    });
    expect(touchLeaseDelivery).toHaveBeenCalledWith("lease-1", {
      cursor: "4242",
      lastDeliveryAt: expect.any(Number),
    });
  });

  it("validates Calendar channel tokens before accepting a delivery", async () => {
    const touchLeaseDelivery = vi.fn();
    const manager = new WebhookWatchManager({
      credentialStore: { load: vi.fn() },
      providerRegistry: { get: vi.fn() },
      webhookStore: {
        countSubscriptionsForLease: vi.fn(),
        deleteLease: vi.fn(),
        findLeaseByIdentity: vi.fn(),
        getLease: vi.fn(() =>
          createLease({
            eventType: "events.changed",
            delivery: "https-post",
            watchType: "calendar-watch",
            secret: "expected-token",
            remoteChannelId: "channel-1",
          })
        ),
        listLeases: vi.fn(() => []),
        touchLeaseDelivery,
        upsertLease: vi.fn(),
      },
    });

    const rejected = await manager.handleChannelPush("lease-1", "{}", {
      "x-goog-channel-id": "channel-1",
      "x-goog-channel-token": "wrong-token",
    });
    expect(rejected).toBeNull();

    const accepted = await manager.handleChannelPush("lease-1", "{}", {
      "x-goog-channel-id": "channel-1",
      "x-goog-channel-token": "expected-token",
    });
    expect(accepted).toMatchObject({
      leaseId: "lease-1",
      event: "events.changed",
      delivery: "https-post",
    });
    expect(touchLeaseDelivery).toHaveBeenCalledTimes(1);
  });
});
