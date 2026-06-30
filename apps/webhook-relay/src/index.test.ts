import { describe, expect, it, vi } from "vitest";

import worker, { type Env } from "./index";

// The Worker entry is a thin router: stateful routes go to the global
// RelayRegistry DO; health + the universal-link host are served here. We stub
// the DO namespace so we can assert routing without the workerd runtime.

function makeEnv(overrides: Partial<Env> = {}): { env: Env; stub: { fetch: ReturnType<typeof vi.fn> } } {
  const stub = { fetch: vi.fn(async () => new Response("from-do", { status: 222 })) };
  const env = {
    NATSTACK_RELAY_SIGNING_SECRET: "relay-secret",
    NATSTACK_APPLE_APP_ID: "ABCDE12345.com.natstack.mobile",
    NATSTACK_ANDROID_PACKAGE_NAME: "com.natstack.mobile",
    NATSTACK_ANDROID_SHA256_CERT_FINGERPRINTS: "aa:bb:cc",
    RELAY_REGISTRY: {
      idFromName: vi.fn(() => "global-id"),
      get: vi.fn(() => stub),
    },
    ...overrides,
  } as unknown as Env;
  return { env, stub };
}

describe("webhook relay Worker — routing", () => {
  it("answers health checks without touching the DO", async () => {
    const { env, stub } = makeEnv();
    const resp = await worker.fetch(new Request("https://hooks.snugenv.com/healthz"), env);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("routes webhook ingress to the global RelayRegistry DO", async () => {
    const { env, stub } = makeEnv();
    const resp = await worker.fetch(
      new Request("https://hooks.snugenv.com/i/sub-1?debug=1", { method: "POST", body: "{}" }),
      env,
    );
    expect(stub.fetch).toHaveBeenCalledTimes(1);
    expect((env.RELAY_REGISTRY.idFromName as any)).toHaveBeenCalledWith("global");
    expect(resp.status).toBe(222);
  });

  it("routes the OAuth landing to the DO", async () => {
    const { env, stub } = makeEnv();
    await worker.fetch(new Request("https://hooks.snugenv.com/oauth/callback/tx-1?code=c&state=s"), env);
    expect(stub.fetch).toHaveBeenCalledTimes(1);
  });

  it("routes a backhaul WS upgrade to the DO", async () => {
    const { env, stub } = makeEnv();
    await worker.fetch(
      new Request("https://hooks.snugenv.com/backhaul?serverId=a&ts=1&sig=x", { headers: { upgrade: "websocket" } }),
      env,
    );
    expect(stub.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not expose legacy provider-shaped relay paths", async () => {
    const { env, stub } = makeEnv();
    for (const url of [
      "https://hooks.snugenv.com/calendar/lease-1",
      "https://hooks.snugenv.com/provider/google",
    ]) {
      const resp = await worker.fetch(new Request(url, { method: "POST", body: "{}" }), env);
      expect(resp.status).toBe(404);
    }
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});

describe("webhook relay Worker — universal-link host", () => {
  it("serves the Apple App Site Association anchored on /oauth/callback/*", async () => {
    const { env } = makeEnv();
    const resp = await worker.fetch(
      new Request("https://hooks.snugenv.com/.well-known/apple-app-site-association"),
      env,
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("application/json");
    const doc = (await resp.json()) as any;
    expect(doc.applinks.details[0].appIDs).toEqual(["ABCDE12345.com.natstack.mobile"]);
    expect(doc.applinks.details[0].components[0]["/"]).toBe("/oauth/callback/*");
  });

  it("serves Android assetlinks", async () => {
    const { env } = makeEnv();
    const resp = await worker.fetch(new Request("https://hooks.snugenv.com/.well-known/assetlinks.json"), env);
    expect(resp.status).toBe(200);
    const doc = (await resp.json()) as any;
    expect(doc[0].target.package_name).toBe("com.natstack.mobile");
    expect(doc[0].target.sha256_cert_fingerprints).toEqual(["AA:BB:CC"]);
  });

  it("fails loud (503) when the universal-link host is unconfigured", async () => {
    const { env } = makeEnv({ NATSTACK_APPLE_APP_ID: undefined });
    const resp = await worker.fetch(
      new Request("https://hooks.snugenv.com/.well-known/apple-app-site-association"),
      env,
    );
    expect(resp.status).toBe(503);
  });
});
