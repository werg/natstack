import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebhookSubscription } from "./types.js";
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

  it("adds and lists subscriptions", () => {
    const created = store.add({
      workerId: "worker-1",
      providerId: "github",
      eventType: "push",
      delivery: "https-post",
      secret: "secret-1",
    });

    expect(created.subscriptionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(created.createdAt).toBeTypeOf("number");
    expect(store.list()).toEqual([created]);
  });

  it("filters subscriptions by worker, provider, and event", () => {
    const subscriptions: WebhookSubscription[] = [
      store.add({
        workerId: "worker-1",
        providerId: "github",
        eventType: "push",
        delivery: "https-post",
        secret: "secret-1",
      }),
      store.add({
        workerId: "worker-1",
        providerId: "github",
        eventType: "pull_request",
        delivery: "pubsub-push",
      }),
      store.add({
        workerId: "worker-2",
        providerId: "slack",
        eventType: "message",
        delivery: "https-post",
      }),
    ];

    expect(store.list({ workerId: "worker-1" })).toEqual(subscriptions.slice(0, 2));
    expect(store.list({ providerId: "github", eventType: "push" })).toEqual([
      subscriptions[0],
    ]);
    expect(store.list({ workerId: "worker-2", providerId: "slack" })).toEqual([
      subscriptions[2],
    ]);
  });

  it("finds subscriptions for an event", () => {
    const expected = store.add({
      workerId: "worker-1",
      providerId: "github",
      eventType: "push",
      delivery: "https-post",
    });

    store.add({
      workerId: "worker-2",
      providerId: "github",
      eventType: "pull_request",
      delivery: "https-post",
    });

    expect(store.findForEvent("github", "push")).toEqual([expected]);
  });

  it("removes subscriptions", () => {
    const created = store.add({
      workerId: "worker-1",
      providerId: "github",
      eventType: "push",
      delivery: "https-post",
    });

    store.remove(created.subscriptionId);

    expect(store.list()).toEqual([]);
  });
});
