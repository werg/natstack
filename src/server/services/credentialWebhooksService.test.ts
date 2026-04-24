import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import type { WebhookEvent } from "../../../packages/shared/src/webhooks/types.js";
import { createCredentialWebhooksService } from "./credentialWebhooksService.js";

type TestResponse = ServerResponse & {
  headers: Record<string, string>;
  body: string;
};

function createRequest(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = Readable.from([body]) as Readable & { headers: Record<string, string> };
  req.headers = headers;
  return req as unknown as IncomingMessage;
}

function createResponse(): TestResponse {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    end(chunk?: string) {
      res.body = chunk ?? "";
    },
  };
  return res as unknown as TestResponse;
}

describe("credentialWebhooksService routes", () => {
  it("accepts pubsub webhook ingress and forwards the resulting event to delivery", async () => {
    const event = {
      provider: "google-workspace",
      connectionId: "conn-1",
      event: "message.new",
      delivery: "pubsub-push",
      leaseId: "lease-1",
      payload: { data: { historyId: "42" } },
      receivedAt: 1,
    } satisfies WebhookEvent;
    const delivery = { matched: 1, delivered: 1, failures: [] };
    const { routes } = createCredentialWebhooksService(
      {
        listLeases: vi.fn(() => []),
        listSubscriptions: vi.fn(() => []),
      },
      {
        handleChannelPush: vi.fn(),
        handlePubsubPush: vi.fn(async () => event),
      },
      {
        deliverEvent: vi.fn(async () => delivery),
      },
    );

    const route = routes.find((entry) => entry.path === "/pubsub/:providerId");
    const res = createResponse();
    await route?.handler(
      createRequest(JSON.stringify({ message: { data: "e30=" } }), { "content-type": "application/json" }),
      res,
      { providerId: "google-workspace" },
    );

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(String(res.body))).toEqual({ ok: true, event, delivery });
  });

  it("accepts calendar webhook ingress and forwards the resulting event to delivery", async () => {
    const event = {
      provider: "google-workspace",
      connectionId: "conn-1",
      event: "events.changed",
      delivery: "https-post",
      leaseId: "lease-1",
      payload: {},
      receivedAt: 1,
    } satisfies WebhookEvent;
    const delivery = { matched: 1, delivered: 1, failures: [] };
    const { routes } = createCredentialWebhooksService(
      {
        listLeases: vi.fn(() => []),
        listSubscriptions: vi.fn(() => []),
      },
      {
        handleChannelPush: vi.fn(async () => event),
        handlePubsubPush: vi.fn(),
      },
      {
        deliverEvent: vi.fn(async () => delivery),
      },
    );

    const route = routes.find((entry) => entry.path === "/calendar/:leaseId");
    const res = createResponse();
    await route?.handler(
      createRequest("{}", { "x-goog-channel-id": "channel-1" }),
      res,
      { leaseId: "lease-1" },
    );

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(String(res.body))).toEqual({ ok: true, event, delivery });
  });
});
