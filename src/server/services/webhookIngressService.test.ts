import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseManager } from "@natstack/shared/db/databaseManager";
import type {
  RotateWebhookIngressSecretResult,
  WebhookIngressSubscriptionSummary,
} from "@natstack/shared/webhooks/ingress";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Gateway } from "../gateway.js";
import { RouteRegistry } from "../routeRegistry.js";
import { createWebhookIngressService } from "./webhookIngressService.js";

const RELAY_SECRET = "relay-secret";

interface Harness {
  gateway: Gateway;
  port: number;
  service: ReturnType<typeof createWebhookIngressService>;
  deliveries: unknown[];
}

async function startHarness(): Promise<Harness> {
  const registry = new RouteRegistry();
  const deliveries: unknown[] = [];
  const service = createWebhookIngressService({
    relaySigningSecret: RELAY_SECRET,
    codeIdentityResolver: {
      resolveByCallerId: (callerId) => ({
        callerId,
        callerKind: "worker",
        repoPath: callerId === "worker:other" ? "workers/other" : "workers/hooks",
        effectiveVersion: "test",
      }),
    },
    now: () => 1_700_000_000_000,
    dispatchToTarget: async (_target, event) => {
      deliveries.push(event);
    },
  });
  registry.registerService(service.routes);
  const gateway = new Gateway({
    externalHost: "127.0.0.1",
    bindHost: "127.0.0.1",
    routeRegistry: registry,
  });
  const port = await gateway.start(0);
  return { gateway, port, service, deliveries };
}

async function stopHarness(h: Harness): Promise<void> {
  await h.gateway.stop();
}

function relayHeaders(path: string, body: string, extra: Record<string, string> = {}): Record<string, string> {
  const bodySha = crypto.createHash("sha256").update(body).digest("hex");
  const timestamp = "1700000000000";
  const canonical = ["POST", path, "", timestamp, bodySha].join("\n");
  const signature = `v1=${crypto.createHmac("sha256", RELAY_SECRET).update(canonical).digest("hex")}`;
  return {
    "x-natstack-relay-method": "POST",
    "x-natstack-relay-path": path,
    "x-natstack-relay-query": "",
    "x-natstack-relay-timestamp": timestamp,
    "x-natstack-relay-body-sha256": bodySha,
    "x-natstack-relay-signature": signature,
    ...extra,
  };
}

describe("webhookIngressService", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await stopHarness(h);
  });

  it("creates redacted generic subscriptions", async () => {
    const summary = await h.service.definition.handler(
      { callerId: "worker:owner", callerKind: "worker" },
      "createSubscription",
      [{
        label: "GitHub push",
        target: {
          source: "workers/hooks",
          className: "HookWorker",
          objectKey: "default",
          method: "githubPush",
        },
        verifier: {
          type: "hmac-sha256",
          headerName: "x-hub-signature-256",
          secret: "provider-secret",
          prefix: "sha256=",
        },
        replay: { deliveryIdHeader: "x-github-delivery" },
      }],
    );

    expect(summary).toMatchObject({
      label: "GitHub push",
      publicUrl: expect.stringMatching(/^https:\/\/hooks\.snugenv\.com\/i\//),
      verifier: {
        type: "hmac-sha256",
        headerName: "x-hub-signature-256",
        hasSecret: true,
      },
    });
    expect(JSON.stringify(summary)).not.toContain("provider-secret");
  });

  it("rejects userland targets outside the caller source", async () => {
    await expect(h.service.definition.handler(
      { callerId: "worker:other", callerKind: "worker" },
      "createSubscription",
      [{
        target: {
          source: "workers/hooks",
          className: "HookWorker",
          objectKey: "default",
          method: "githubPush",
        },
        verifier: {
          type: "bearer",
          headerName: "authorization",
          token: "provider-token",
        },
      }],
    )).rejects.toThrow("webhook subscription target must belong to caller source");
  });

  it("rotates webhook verifier secrets", async () => {
    const summary = await h.service.definition.handler(
      { callerId: "worker:owner", callerKind: "worker" },
      "createSubscription",
      [{
        label: "Rotate me",
        target: {
          source: "workers/hooks",
          className: "HookWorker",
          objectKey: "default",
          method: "githubPush",
        },
        verifier: {
          type: "bearer",
          headerName: "authorization",
          token: "provider-token",
        },
      }],
    ) as WebhookIngressSubscriptionSummary;

    const result = await h.service.definition.handler(
      { callerId: "worker:owner", callerKind: "worker" },
      "rotateSecret",
      [{ subscriptionId: summary.subscriptionId, secret: "rotated-secret" }],
    ) as RotateWebhookIngressSecretResult;

    expect(result).toMatchObject({
      secret: "rotated-secret",
      subscription: {
        subscriptionId: summary.subscriptionId,
        verifier: { hasSecret: true },
      },
    });
    expect(h.service.internal.store.get(summary.subscriptionId)?.verifier).toMatchObject({
      token: "rotated-secret",
    });
  });

  it("accepts signed relay delivery with a valid provider signature", async () => {
    const [subscription] = h.service.internal.store.list("worker:owner");
    const body = JSON.stringify({ action: "opened" });
    const providerSig = `sha256=${crypto
      .createHmac("sha256", "provider-secret")
      .update(body)
      .digest("hex")}`;

    const response = await fetch(`http://127.0.0.1:${h.port}/_r/s/webhookIngress/${subscription!.subscriptionId}`, {
      method: "POST",
      headers: relayHeaders(`/i/${subscription!.subscriptionId}`, body, {
        "x-hub-signature-256": providerSig,
        "x-github-delivery": "delivery-1",
      }),
      body,
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      subscriptionId: subscription!.subscriptionId,
    });
    expect(h.deliveries).toHaveLength(1);
    expect(h.deliveries[0]).toMatchObject({
      subscriptionId: subscription!.subscriptionId,
      json: { action: "opened" },
    });
  });

  it("rejects replayed deliveries", async () => {
    const [subscription] = h.service.internal.store.list("worker:owner");
    const body = JSON.stringify({ action: "opened-again" });
    const providerSig = `sha256=${crypto
      .createHmac("sha256", "provider-secret")
      .update(body)
      .digest("hex")}`;

    const response = await fetch(`http://127.0.0.1:${h.port}/_r/s/webhookIngress/${subscription!.subscriptionId}`, {
      method: "POST",
      headers: relayHeaders(`/i/${subscription!.subscriptionId}`, body, {
        "x-hub-signature-256": providerSig,
        "x-github-delivery": "delivery-1",
      }),
      body,
    });

    expect(response.status).toBe(409);
  });

  it("rejects invalid relay envelopes before provider verification", async () => {
    const [subscription] = h.service.internal.store.list("worker:owner");
    const response = await fetch(`http://127.0.0.1:${h.port}/_r/s/webhookIngress/${subscription!.subscriptionId}`, {
      method: "POST",
      headers: {
        ...relayHeaders(`/i/${subscription!.subscriptionId}`, "{}"),
        "x-natstack-relay-signature": "v1=bad",
      },
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(h.deliveries).toHaveLength(1);
  });

  it("persists subscriptions through the workspace database manager", async () => {
    const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "webhook-ingress-"));
    try {
      const databaseManager = new DatabaseManager(statePath);
      const codeIdentityResolver = {
        resolveByCallerId: (callerId: string) => ({
          callerId,
          callerKind: "worker" as const,
          repoPath: "workers/hooks",
          effectiveVersion: "test",
        }),
      };
      const first = createWebhookIngressService({ databaseManager, codeIdentityResolver });
      const summary = await first.definition.handler(
        { callerId: "worker:persistent", callerKind: "worker" },
        "createSubscription",
        [{
          label: "Persistent hook",
          target: {
            source: "workers/hooks",
            className: "HookWorker",
            objectKey: "default",
            method: "githubPush",
          },
          verifier: {
            type: "bearer",
            headerName: "authorization",
            token: "provider-token",
          },
        }],
      );
      databaseManager.shutdown();

      const reopenedManager = new DatabaseManager(statePath);
      const second = createWebhookIngressService({
        databaseManager: reopenedManager,
        codeIdentityResolver,
      });
      const subscriptions = await second.definition.handler(
        { callerId: "worker:persistent", callerKind: "worker" },
        "listSubscriptions",
        [],
      );

      expect(subscriptions).toEqual([summary]);
      reopenedManager.shutdown();
    } finally {
      fs.rmSync(statePath, { recursive: true, force: true });
    }
  });
});
