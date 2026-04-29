import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "./index";
import { canonicalRelayEnvelope, hmacSha256Hex, sha256Hex } from "./envelope";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webhook relay", () => {
  it("signs and forwards generic ingress deliveries", async () => {
    const upstream = vi.fn(async () => new Response("accepted", { status: 202 }));
    vi.stubGlobal("fetch", upstream);

    const response = await worker.fetch(
      new Request("https://hooks.snugenv.com/i/sub-1?debug=1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-provider-signature": "sig",
          cookie: "should-not-forward",
        },
        body: JSON.stringify({ ok: true }),
      }),
      {
        NATSTACK_SERVER_BASE_URL: "https://server.example.test/",
        NATSTACK_RELAY_SIGNING_SECRET: "relay-secret",
      },
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("accepted");
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe("https://server.example.test/_r/s/webhookIngress/sub-1");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(ArrayBuffer);

    const headers = init.headers as Headers;
    const bodySha256 = await sha256Hex(init.body as ArrayBuffer);
    expect(headers.get("x-provider-signature")).toBe("sig");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-natstack-relay-body-sha256")).toBe(bodySha256);
    expect(headers.get("x-natstack-relay-path")).toBe("/i/sub-1");
    expect(headers.get("x-natstack-relay-query")).toBe("debug=1");
    expect(headers.get("x-natstack-relay-method")).toBe("POST");

    const timestamp = headers.get("x-natstack-relay-timestamp")!;
    const expectedSignature = `v1=${await hmacSha256Hex(
      "relay-secret",
      canonicalRelayEnvelope({
        method: "POST",
        path: "/i/sub-1",
        query: "debug=1",
        timestamp,
        bodySha256,
      }),
    )}`;
    expect(headers.get("x-natstack-relay-signature")).toBe(expectedSignature);
  });

  it("fails closed when the relay signing secret is missing", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await worker.fetch(
      new Request("https://hooks.snugenv.com/i/sub-1", {
        method: "POST",
        body: "{}",
      }),
      { NATSTACK_SERVER_BASE_URL: "https://server.example.test" },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "NATSTACK_RELAY_SIGNING_SECRET is not configured",
    });
    expect(upstream).not.toHaveBeenCalled();
  });
});
