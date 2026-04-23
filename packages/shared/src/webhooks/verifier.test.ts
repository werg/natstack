import { describe, expect, it } from "vitest";
import {
  WebhookVerifierRegistry,
  githubHmacSha256,
  slackSignatureV0,
} from "./verifier.js";

describe("githubHmacSha256", () => {
  const payload = '{"action":"opened"}';
  const secret = "topsecret";
  const signature =
    "sha256=c8e1211e6d7cf6fa6e3e68f6ee51b98ca2654dde24d4dafde9fad4167df885a9";

  it("verifies a valid GitHub webhook signature", () => {
    expect(
      githubHmacSha256(payload, { "x-hub-signature-256": signature }, secret)
    ).toBe(true);
  });

  it("rejects an invalid GitHub webhook signature", () => {
    expect(
      githubHmacSha256(payload, { "x-hub-signature-256": "sha256=deadbeef" }, secret)
    ).toBe(false);
  });
});

describe("WebhookVerifierRegistry", () => {
  it("registers and uses verifiers by name", () => {
    const registry = new WebhookVerifierRegistry();
    registry.register("slack", slackSignatureV0);

    expect(registry.get("slack")).toBe(slackSignatureV0);
    expect(registry.verify("slack", "payload", {}, "secret")).toBe(true);
    expect(registry.verify("missing", "payload", {}, "secret")).toBe(false);
  });
});
