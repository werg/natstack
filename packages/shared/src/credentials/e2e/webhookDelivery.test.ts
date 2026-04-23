import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { MockWebhookRelay } from "../test-utils/mockWebhookRelay.js";
import { WebhookVerifierRegistry, githubHmacSha256 } from "../../webhooks/verifier.js";
import type { WebhookEvent } from "../../webhooks/types.js";

function createEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    provider: "github",
    connectionId: "connection-123",
    event: "pull_request",
    delivery: "https-post",
    payload: { action: "opened" },
    headers: {},
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function createGitHubSignature(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

describe("webhook delivery e2e", () => {
  it("injects an event into MockWebhookRelay and calls the handler", async () => {
    const handler = vi.fn();
    const relay = new MockWebhookRelay();
    const event = createEvent();

    relay.on("pull_request", handler);
    await relay.inject("pull_request", event);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("routes events to the correct handlers when multiple event types are registered", async () => {
    const pushHandler = vi.fn();
    const pullRequestHandler = vi.fn();
    const relay = new MockWebhookRelay({
      handlers: {
        push: pushHandler,
        pull_request: pullRequestHandler,
      },
    });
    const pushEvent = createEvent({ event: "push", payload: { ref: "refs/heads/main" } });
    const pullRequestEvent = createEvent({
      event: "pull_request",
      payload: { action: "synchronize" },
    });

    await relay.inject("push", pushEvent);
    await relay.inject("pull_request", pullRequestEvent);

    expect(pushHandler).toHaveBeenCalledTimes(1);
    expect(pushHandler).toHaveBeenCalledWith(pushEvent);
    expect(pullRequestHandler).toHaveBeenCalledTimes(1);
    expect(pullRequestHandler).toHaveBeenCalledWith(pullRequestEvent);
  });

  it("passes GitHub signature verification with a valid X-Hub-Signature-256 header", () => {
    const registry = new WebhookVerifierRegistry();
    const secret = "topsecret";
    const body = JSON.stringify({ action: "opened", number: 42 });
    const event = createEvent({
      payload: body,
      headers: {
        "X-Hub-Signature-256": createGitHubSignature(body, secret),
      },
    });

    registry.register("githubHmacSha256", githubHmacSha256);

    expect(
      registry.verify(
        "githubHmacSha256",
        body,
        event.headers ?? {},
        secret
      )
    ).toBe(true);
  });

  it("rejects an invalid GitHub signature", () => {
    const registry = new WebhookVerifierRegistry();
    const secret = "topsecret";
    const body = JSON.stringify({ action: "opened", number: 42 });
    const event = createEvent({
      payload: body,
      headers: {
        "x-hub-signature-256": "sha256=deadbeef",
      },
    });

    registry.register("githubHmacSha256", githubHmacSha256);

    expect(
      registry.verify(
        "githubHmacSha256",
        body,
        event.headers ?? {},
        secret
      )
    ).toBe(false);
  });

  it("records delivered events on the relay", async () => {
    const relay = new MockWebhookRelay();
    const firstEvent = createEvent({ event: "push", payload: { ref: "refs/heads/main" } });
    const secondEvent = createEvent({
      event: "pull_request",
      payload: { action: "closed" },
    });

    await relay.inject("push", firstEvent);
    await relay.inject("pull_request", secondEvent);

    expect(relay.deliveredCount).toBe(2);
    expect(relay.delivered).toHaveLength(2);
    expect(relay.delivered[0]).toMatchObject({
      eventType: "push",
      event: firstEvent,
    });
    expect(relay.delivered[1]).toMatchObject({
      eventType: "pull_request",
      event: secondEvent,
    });
    expect(relay.delivered[0].deliveredAt).toBeTypeOf("number");
    expect(relay.delivered[1].deliveredAt).toBeTypeOf("number");
  });
});
