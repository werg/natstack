import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { WebhookStoreDO } from "./webhookStoreDO.js";
import type { WebhookIngressSubscription } from "../../../packages/shared/src/webhooks/ingress.js";

type CreateInput = Omit<WebhookIngressSubscription, "subscriptionId" | "createdAt" | "updatedAt">;

function input(overrides: Partial<CreateInput> = {}): CreateInput {
  return {
    label: overrides.label ?? "GitHub push",
    ownerCallerId: overrides.ownerCallerId ?? "panel:abc",
    ownerCallerKind: overrides.ownerCallerKind ?? "panel",
    target: overrides.target ?? {
      source: "workspace/workers/github",
      className: "GithubDO",
      objectKey: "main",
      method: "onPush",
    },
    verifier: overrides.verifier ?? {
      type: "hmac-sha256",
      headerName: "X-Hub-Signature-256",
      secret: "shh",
      prefix: "sha256=",
    },
    replay: overrides.replay,
    publicUrl: overrides.publicUrl ?? "https://example.test/_w/abc",
    revokedAt: overrides.revokedAt,
  };
}

describe("WebhookStoreDO", () => {
  it("creates, reads, lists, replaces, and revokes subscriptions", async () => {
    const { call } = await createTestDO(WebhookStoreDO);

    const a = await call<WebhookIngressSubscription>("create", input({ label: "alpha" }));
    expect(a.subscriptionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.createdAt).toBeGreaterThan(0);
    expect(a.updatedAt).toBe(a.createdAt);

    const b = await call<WebhookIngressSubscription>("create", input({ label: "beta", ownerCallerId: "panel:other" }));
    expect(b.subscriptionId).not.toBe(a.subscriptionId);

    const fetched = await call<WebhookIngressSubscription | null>("get", a.subscriptionId);
    expect(fetched).toMatchObject({ subscriptionId: a.subscriptionId, label: "alpha" });

    const all = await call<WebhookIngressSubscription[]>("list");
    expect(all).toHaveLength(2);
    const ownerScoped = await call<WebhookIngressSubscription[]>("list", "panel:abc");
    expect(ownerScoped).toHaveLength(1);
    expect(ownerScoped[0]!.label).toBe("alpha");

    const rotated: WebhookIngressSubscription = {
      ...a,
      verifier: { type: "hmac-sha256", headerName: "X-Hub-Signature-256", secret: "rotated" },
      updatedAt: a.updatedAt + 1,
    };
    await call("replace", rotated);
    const reread = await call<WebhookIngressSubscription | null>("get", a.subscriptionId);
    expect((reread!.verifier as { secret: string }).secret).toBe("rotated");

    const revoked: WebhookIngressSubscription = { ...rotated, revokedAt: Date.now(), updatedAt: rotated.updatedAt + 1 };
    await call("replace", revoked);
    const afterRevoke = await call<WebhookIngressSubscription | null>("get", a.subscriptionId);
    expect(afterRevoke!.revokedAt).toBeTruthy();
  });

  it("returns null for unknown subscription ids", async () => {
    const { call } = await createTestDO(WebhookStoreDO);
    expect(await call("get", "00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await call("list")).toEqual([]);
  });

  it("preserves complex verifier and replay payloads through JSON round-trip", async () => {
    const { call } = await createTestDO(WebhookStoreDO);
    const created = await call<WebhookIngressSubscription>(
      "create",
      input({
        verifier: {
          type: "timestamped-hmac-sha256",
          signatureHeaderName: "X-Slack-Signature",
          timestampHeaderName: "X-Slack-Request-Timestamp",
          secret: "slack-secret",
          encoding: "hex",
          signedPayload: "slack-v0",
          toleranceMs: 300000,
        },
        replay: { deliveryIdHeader: "X-GitHub-Delivery", ttlMs: 60000 },
      }),
    );

    const fetched = await call<WebhookIngressSubscription | null>("get", created.subscriptionId);
    expect(fetched!.verifier).toMatchObject({
      type: "timestamped-hmac-sha256",
      toleranceMs: 300000,
      signedPayload: "slack-v0",
    });
    expect(fetched!.replay).toEqual({ deliveryIdHeader: "X-GitHub-Delivery", ttlMs: 60000 });
  });
});
