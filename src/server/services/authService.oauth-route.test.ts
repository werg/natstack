/**
 * authService × NatstackCodexProvider × gateway integration test.
 *
 * Covers:
 *   - `startOAuthLogin` invokes `openBrowser` and `emitOpenExternalTo(url, callerId)`.
 *   - The registered `/oauth/callback` route handler resolves the flow.
 *   - Credentials land in `oauth-tokens.json` at the overridden path.
 *   - Aborting the flow when `emitOpenExternalTo` returns `false` (initiator
 *     disconnected) surfaces a clear error.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AuthServiceImpl, createAuthService } from "./authService.js";
import { RouteRegistry } from "../routeRegistry.js";
import { Gateway } from "../gateway.js";
import { NatstackCodexProvider, __testAccess } from "./oauthProviders/natstackCodexProvider.js";

function buildJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

interface Harness {
  gateway: Gateway;
  gatewayPort: number;
  registry: RouteRegistry;
  tokenServer: HttpServer;
  tokenServerPort: number;
  tokensPath: string;
  publicUrl: string;
  authService: AuthServiceImpl;
  openCalls: string[];
  emitToCalls: Array<{ url: string; callerId: string }>;
  emitToResult: boolean;
}

async function startHarness(opts: { emitDelivers?: boolean } = {}): Promise<Harness> {
  const registry = new RouteRegistry();
  const tmp = await mkdtemp(path.join(tmpdir(), "authsvc-"));
  const tokensPath = path.join(tmp, "oauth-tokens.json");

  // Fake OpenAI token endpoint — also captures the redirect_uri we send.
  const fakeAccess = buildJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_abc" },
  });
  const tokenServer: HttpServer = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      access_token: fakeAccess,
      refresh_token: "r-ok",
      expires_in: 3600,
    }));
  });
  const tokenServerPort: number = await new Promise((resolve) => {
    tokenServer.listen(0, "127.0.0.1", () => {
      const addr = tokenServer.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  // Gateway binds first so we know the port for publicUrl.
  const gateway = new Gateway({
    externalHost: "127.0.0.1",
    bindHost: "127.0.0.1",
    routeRegistry: registry,
  });
  const gatewayPort = await gateway.start(0);
  const publicUrl = `http://127.0.0.1:${gatewayPort}`;

  const openCalls: string[] = [];
  const emitToCalls: Array<{ url: string; callerId: string }> = [];
  const emitToResult = opts.emitDelivers !== false;

  // Swap NatstackCodexProvider's token endpoint by overriding fetchImpl via
  // providerOverrides — we construct our own provider pointing at the fake.
  const customProvider = new NatstackCodexProvider({
    getPublicUrl: () => publicUrl,
    fetchImpl: (async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          access_token: fakeAccess,
          refresh_token: "r-ok",
          expires_in: 3600,
        };
      },
      async text() { return ""; },
    } as unknown as Response)) as typeof fetch,
  });

  const authService = new AuthServiceImpl({
    openBrowser: (url) => { openCalls.push(url); },
    emitOpenExternalTo: (url, callerId) => {
      emitToCalls.push({ url, callerId });
      return emitToResult;
    },
    getPublicUrl: () => publicUrl,
    tokensPath,
    providerOverrides: { "openai-codex": customProvider },
  });

  const pair = createAuthService({ authService });
  registry.registerService(pair.routes);

  return {
    gateway, gatewayPort, registry, tokenServer, tokenServerPort,
    tokensPath, publicUrl, authService, openCalls, emitToCalls, emitToResult,
  };
}

async function stopHarness(h: Harness): Promise<void> {
  await h.gateway.stop();
  await new Promise<void>((resolve) => h.tokenServer.close(() => resolve()));
  try { await rm(path.dirname(h.tokensPath), { recursive: true, force: true }); } catch { /* ignore */ }
}

describe("authService OAuth route", () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await stopHarness(h); });

  it("startOAuthLogin calls openBrowser AND emitOpenExternalTo with callerId", async () => {
    // Kick off login — it'll block until the callback route is hit.
    const loginP = h.authService.startOAuthLogin("openai-codex", "panel-42");
    // Poll until the provider registers the flow.
    const provider = (h.authService as unknown as {
      oauthProviders: Record<string, { provider: NatstackCodexProvider }>;
    }).oauthProviders["openai-codex"]!.provider;
    for (let i = 0; i < 200 && provider[__testAccess]().pendingStates().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(h.openCalls).toHaveLength(1);
    expect(h.openCalls[0]).toContain("https://auth.openai.com/oauth/authorize");
    expect(h.emitToCalls).toHaveLength(1);
    expect(h.emitToCalls[0]!.callerId).toBe("panel-42");
    expect(h.emitToCalls[0]!.url).toBe(h.openCalls[0]);

    // Hit the gateway's /_r/s/auth/oauth/callback route with the registered
    // state + a code. This should resolve the flow and complete login.
    const state = provider[__testAccess]().pendingStates()[0]!;
    const callbackUrl = `${h.publicUrl}/_r/s/auth/oauth/callback?state=${state}&code=c-ok`;
    const resp = await fetch(callbackUrl);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toMatch(/Signed in/i);

    const result = await loginP;
    expect(result.success).toBe(true);

    // Credentials persisted.
    const stored = JSON.parse(await readFile(h.tokensPath, "utf-8"));
    expect(stored["openai-codex"]).toBeTruthy();
    expect(stored["openai-codex"].refresh).toBe("r-ok");
    expect(stored["openai-codex"].accountId).toBe("acct_abc");
  });

  it("aborts with a clear error when emitOpenExternalTo returns false", async () => {
    const h2 = await startHarness({ emitDelivers: false });
    try {
      const { success, error } = await h2.authService.startOAuthLogin(
        "openai-codex",
        "ghost-client",
      );
      expect(success).toBe(false);
      expect(error).toMatch(/initiator disconnected/i);
    } finally {
      await stopHarness(h2);
    }
  });
});
