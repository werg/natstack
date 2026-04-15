/**
 * Unit tests for NatstackCodexProvider — PKCE/state generation, flow
 * registration, callback handling, token exchange. Network is stubbed.
 */

import { describe, it, expect, vi } from "vitest";
import { NatstackCodexProvider } from "./natstackCodexProvider.js";
import type { ServerResponse } from "node:http";

const PUBLIC_URL = "https://server.lan:3000";

type MockRes = ServerResponse & { _body: string; _status: number };
function makeRes(): MockRes {
  const res: Partial<MockRes> = {
    _body: "",
    _status: 200,
    statusCode: 200,
    setHeader: vi.fn(),
  };
  res.end = function (this: MockRes, body?: string) {
    this._body = body ?? "";
    this._status = this.statusCode;
    return this;
  } as MockRes["end"];
  return res as MockRes;
}

function makeTokenFetch(response: { ok?: boolean; body?: unknown; status?: number }): typeof fetch {
  return vi.fn(async () => {
    const ok = response.ok ?? true;
    return {
      ok,
      status: response.status ?? (ok ? 200 : 400),
      async json() { return response.body ?? {}; },
      async text() { return typeof response.body === "string" ? response.body : JSON.stringify(response.body); },
    } as unknown as Response;
  }) as typeof fetch;
}

/** Wait until the provider has registered a pending flow. PKCE generation
 *  (crypto.subtle.digest) is asynchronous and takes more than one microtask. */
async function waitForFlow(provider: NatstackCodexProvider, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (provider._pendingStatesForTest().length === 0) {
    if (Date.now() - start > timeoutMs) throw new Error("flow registration timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Build a JWT with an arbitrary payload (no signature verification). */
function buildJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("NatstackCodexProvider", () => {
  it("registers a flow and emits the auth URL via onAuth", async () => {
    const provider = new NatstackCodexProvider({
      getPublicUrl: () => PUBLIC_URL,
      fetchImpl: makeTokenFetch({ body: {} }), // unused in this test
    });
    let capturedUrl = "";
    const p = provider.login({
      onAuth: (info) => { capturedUrl = info.url; },
      onPrompt: async () => { throw new Error("not called"); },
    });
    // Give the onAuth callback a microtask to land.
    await waitForFlow(provider);

    expect(capturedUrl).toContain("https://auth.openai.com/oauth/authorize");
    expect(capturedUrl).toContain(`redirect_uri=${encodeURIComponent(PUBLIC_URL + "/_r/s/auth/oauth/callback")}`);
    expect(capturedUrl).toContain("code_challenge_method=S256");
    expect(capturedUrl).toContain("state=");

    // One flow is registered and waiting.
    expect(provider._pendingStatesForTest()).toHaveLength(1);

    provider.teardown();
    await expect(p).rejects.toThrow(/torn down/i);
  });

  it("rejects callback with no matching state", async () => {
    const provider = new NatstackCodexProvider({ getPublicUrl: () => PUBLIC_URL });
    const res = makeRes();
    await provider.handleCallback(
      { url: "/_r/s/auth/oauth/callback?state=bogus&code=abc" } as any,
      res,
    );
    expect(res.statusCode).toBe(404);
    expect(res._body).toMatch(/No matching OAuth flow/i);
  });

  it("rejects callback with missing code and fails the flow", async () => {
    const provider = new NatstackCodexProvider({ getPublicUrl: () => PUBLIC_URL });
    const loginPromise = provider.login({
      onAuth: () => {},
      onPrompt: async () => { throw new Error("not called"); },
    });
    await waitForFlow(provider);
    const state = provider._pendingStatesForTest()[0]!;

    const res = makeRes();
    await provider.handleCallback(
      { url: `/_r/s/auth/oauth/callback?state=${state}` } as any,
      res,
    );
    expect(res.statusCode).toBe(400);
    await expect(loginPromise).rejects.toThrow(/missing code/i);
  });

  it("completes the full flow on a valid callback", async () => {
    const fakeAccess = buildJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_xyz" },
    });
    const provider = new NatstackCodexProvider({
      getPublicUrl: () => PUBLIC_URL,
      fetchImpl: makeTokenFetch({
        ok: true,
        body: {
          access_token: fakeAccess,
          refresh_token: "r-123",
          expires_in: 3600,
        },
      }),
      nowMs: () => 1_000_000,
    });

    const loginPromise = provider.login({
      onAuth: () => {},
      onPrompt: async () => { throw new Error("not called"); },
    });
    await waitForFlow(provider);
    const state = provider._pendingStatesForTest()[0]!;

    const res = makeRes();
    await provider.handleCallback(
      { url: `/_r/s/auth/oauth/callback?state=${state}&code=the-code` } as any,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res._body).toMatch(/Signed in/i);

    const creds = await loginPromise;
    expect(creds.access).toBe(fakeAccess);
    expect(creds.refresh).toBe("r-123");
    expect(creds.expires).toBe(1_000_000 + 3600 * 1000);
    expect(creds["accountId"]).toBe("acct_xyz");
  });

  it("rejects login when token exchange fails", async () => {
    const provider = new NatstackCodexProvider({
      getPublicUrl: () => PUBLIC_URL,
      fetchImpl: makeTokenFetch({ ok: false, status: 401, body: "denied" }),
    });
    const loginPromise = provider.login({
      onAuth: () => {},
      onPrompt: async () => { throw new Error("not called"); },
    });
    await waitForFlow(provider);
    const state = provider._pendingStatesForTest()[0]!;

    await provider.handleCallback(
      { url: `/_r/s/auth/oauth/callback?state=${state}&code=ok` } as any,
      makeRes(),
    );
    await expect(loginPromise).rejects.toThrow(/token exchange/i);
  });

  it("rejects login when JWT lacks chatgpt_account_id", async () => {
    const fakeAccess = buildJwt({ sub: "no-account" });
    const provider = new NatstackCodexProvider({
      getPublicUrl: () => PUBLIC_URL,
      fetchImpl: makeTokenFetch({
        ok: true,
        body: { access_token: fakeAccess, refresh_token: "r", expires_in: 60 },
      }),
    });
    const loginPromise = provider.login({
      onAuth: () => {},
      onPrompt: async () => { throw new Error("not called"); },
    });
    await waitForFlow(provider);
    const state = provider._pendingStatesForTest()[0]!;
    await provider.handleCallback(
      { url: `/_r/s/auth/oauth/callback?state=${state}&code=ok` } as any,
      makeRes(),
    );
    await expect(loginPromise).rejects.toThrow(/accountId/i);
  });

  it("aborts the flow when signal is aborted", async () => {
    const provider = new NatstackCodexProvider({ getPublicUrl: () => PUBLIC_URL });
    const controller = new AbortController();
    const loginPromise = provider.login({
      onAuth: () => {},
      onPrompt: async () => { throw new Error("not called"); },
      signal: controller.signal,
    });
    await waitForFlow(provider);
    controller.abort();
    await expect(loginPromise).rejects.toThrow(/aborted/i);
  });

  it("getApiKey returns the access token", () => {
    const provider = new NatstackCodexProvider({ getPublicUrl: () => PUBLIC_URL });
    const key = provider.getApiKey({ access: "the-access", refresh: "r", expires: 0 });
    expect(key).toBe("the-access");
  });
});
