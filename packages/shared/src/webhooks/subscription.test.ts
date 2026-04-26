import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebhookSubscription, WebhookWatchLease } from "./types.js";
import { WebhookSubscriptionStore, type DbAdapter } from "./subscription.js";

describe("WebhookSubscriptionStore", () => {
  let sqlite: Database.Database;
  let adapter: DbAdapter;
  let store: WebhookSubscriptionStore;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    adapter = {
      run(sql: string, params?: unknown[]) {
        if (params && params.length > 0) {
          sqlite.prepare(sql).run(...params);
          return;
        }

        sqlite.prepare(sql).run();
      },
      all<T = unknown>(sql: string, params?: unknown[]) {
        if (params && params.length > 0) {
          return sqlite.prepare(sql).all(...params) as T[];
        }

        return sqlite.prepare(sql).all() as T[];
      },
      exec(sql: string) {
        sqlite.exec(sql);
      },
    };
    store = new WebhookSubscriptionStore(adapter);
    store.init();
  });

  afterEach(() => {
    sqlite.close();
  });

  it("creates and lists subscriptions", () => {
    const created = store.upsertSubscription({
      callerId: "worker:worker-1",
      providerId: "github",
      eventType: "push",
      connectionId: "conn-1",
      handler: "__webhook__.github.push",
      delivery: "https-post",
      secret: "secret-1",
    });

    expect(created.subscriptionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(created.createdAt).toBeTypeOf("number");
    expect(created.updatedAt).toBe(created.createdAt);
    expect(store.listSubscriptions()).toEqual([created]);
  });

  it("filters subscriptions by caller, provider, and event", () => {
    const subscriptions: WebhookSubscription[] = [
      store.upsertSubscription({
        callerId: "worker:worker-1",
        providerId: "github",
        eventType: "push",
        connectionId: "conn-1",
        handler: "__webhook__.github.push",
        delivery: "https-post",
        secret: "secret-1",
      }),
      store.upsertSubscription({
        callerId: "worker:worker-1",
        providerId: "github",
        eventType: "pull_request",
        connectionId: "conn-1",
        handler: "__webhook__.github.pull_request",
        delivery: "pubsub-push",
      }),
      store.upsertSubscription({
        callerId: "worker:worker-2",
        providerId: "slack",
        eventType: "message",
        connectionId: "conn-2",
        handler: "__webhook__.slack.message",
        delivery: "https-post",
      }),
    ];

    expect(store.listSubscriptions({ callerId: "worker:worker-1" })).toEqual(subscriptions.slice(0, 2));
    expect(store.listSubscriptions({ providerId: "github", eventType: "push" })).toEqual([
      subscriptions[0],
    ]);
    expect(store.listSubscriptions({ callerId: "worker:worker-2", providerId: "slack" })).toEqual([
      subscriptions[2],
    ]);
  });

  it("stores and finds watch leases", () => {
    const lease: WebhookWatchLease = store.upsertLease({
      leaseId: "lease-1",
      providerId: "google-workspace",
      eventType: "message.new",
      connectionId: "conn-1",
      delivery: "pubsub-push",
      watchType: "gmail-watch",
      identityKey: "user@example.com",
      cursor: "1234",
      expiresAt: 1_700_000_000_000,
      lastRenewedAt: 1_699_999_000_000,
      state: { topic: "projects/example/topics/gmail" },
    });

    expect(store.getLease("lease-1")).toEqual(lease);
    expect(store.findLeaseByIdentity("google-workspace", "user@example.com")).toEqual(lease);
    expect(store.listLeases({ providerId: "google-workspace" })).toEqual([lease]);
  });

  it("updates lease delivery state", () => {
    store.upsertLease({
      leaseId: "lease-1",
      providerId: "google-workspace",
      eventType: "message.new",
      connectionId: "conn-1",
      delivery: "pubsub-push",
      watchType: "gmail-watch",
      identityKey: "user@example.com",
      cursor: "1234",
    });

    const updated = store.touchLeaseDelivery("lease-1", {
      cursor: "5678",
      lastDeliveryAt: 1_700_000_000_000,
    });

    expect(updated).toMatchObject({
      leaseId: "lease-1",
      cursor: "5678",
      lastDeliveryAt: 1_700_000_000_000,
    });
  });

  it("deletes subscriptions and leases independently", () => {
    const created = store.upsertSubscription({
      callerId: "worker:worker-1",
      providerId: "github",
      eventType: "push",
      connectionId: "conn-1",
      handler: "__webhook__.github.push",
      delivery: "https-post",
    });
    store.upsertLease({
      leaseId: "lease-1",
      providerId: "github",
      eventType: "push",
      connectionId: "conn-1",
      delivery: "https-post",
      watchType: "github-webhook",
    });

    store.deleteSubscription(created.subscriptionId);
    store.deleteLease("lease-1");

    expect(store.listSubscriptions()).toEqual([]);
    expect(store.listLeases()).toEqual([]);
  });

  it("upserts subscriptions by caller, provider, connection, and handler", () => {
    const first = store.upsertSubscription({
      callerId: "worker:worker-1",
      providerId: "google-workspace",
      eventType: "message.new",
      connectionId: "conn-1",
      handler: "__webhook__.gmail.message_new",
      delivery: "pubsub-push",
      leaseId: "lease-1",
    });
    const second = store.upsertSubscription({
      callerId: "worker:worker-1",
      providerId: "google-workspace",
      eventType: "message.new",
      connectionId: "conn-1",
      handler: "__webhook__.gmail.message_new",
      delivery: "pubsub-push",
      leaseId: "lease-2",
    });

    expect(second.subscriptionId).toBe(first.subscriptionId);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.leaseId).toBe("lease-2");
    expect(store.listSubscriptions()).toHaveLength(1);
  });
});
