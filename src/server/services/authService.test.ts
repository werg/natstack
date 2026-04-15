/**
 * AuthServiceImpl tests — env-var providers, credential persistence, login
 * lifecycle, idempotency, `waitForProvider` semantics.
 *
 * We inject a mock OAuth provider via `providerOverrides` rather than mocking
 * pi-ai at the module level: after the Phase 2 refactor openai-codex is
 * served by our own `NatstackCodexProvider` — not pi-ai — so the test's
 * injection point is now the provider instance, not the module.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "@mariozechner/pi-ai";
import { AuthServiceImpl } from "./authService.js";

/**
 * Build a controllable mock OAuth provider. `login` calls the supplied
 * `onAuth` callback (mirroring the real flow) then awaits an external
 * settle() call the test triggers.
 */
function makeMockProvider(): {
  provider: OAuthProviderInterface;
  settle: (creds: OAuthCredentials) => void;
  fail: (err: Error) => void;
  loginMock: ReturnType<typeof vi.fn>;
  refreshMock: ReturnType<typeof vi.fn>;
} {
  let resolver: ((creds: OAuthCredentials) => void) | null = null;
  let rejector: ((err: Error) => void) | null = null;
  const loginMock = vi.fn(async (callbacks: OAuthLoginCallbacks) => {
    callbacks.onAuth({ url: "https://auth.example.com/authorize?state=stub" });
    return new Promise<OAuthCredentials>((resolve, reject) => {
      resolver = resolve;
      rejector = reject;
    });
  });
  const refreshMock = vi.fn(async (creds: OAuthCredentials) => creds);
  const provider: OAuthProviderInterface = {
    id: "openai-codex",
    name: "Mock Codex",
    usesCallbackServer: false,
    login: loginMock as OAuthProviderInterface["login"],
    refreshToken: refreshMock as OAuthProviderInterface["refreshToken"],
    getApiKey: (creds) => creds.access,
  };
  return {
    provider,
    settle: (creds) => { resolver?.(creds); },
    fail: (err) => { rejector?.(err); },
    loginMock,
    refreshMock,
  };
}

describe("AuthServiceImpl", () => {
  let tmpDir: string;
  let tokensPath: string;
  let openBrowser: ReturnType<typeof vi.fn>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "authsvc-test-"));
    tokensPath = path.join(tmpDir, "oauth-tokens.json");
    openBrowser = vi.fn();
    for (const v of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_API_KEY",
      "GROQ_API_KEY",
      "MISTRAL_API_KEY",
      "OPENROUTER_API_KEY",
    ]) {
      delete process.env[v];
    }
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeService(providerOverride?: OAuthProviderInterface) {
    return new AuthServiceImpl({
      openBrowser,
      tokensPath,
      getPublicUrl: () => "http://127.0.0.1:3000",
      providerOverrides: providerOverride ? { "openai-codex": providerOverride } : undefined,
    });
  }

  describe("getProviderToken", () => {
    it("throws a clear error when OAuth provider has no stored credentials", async () => {
      const svc = makeService();
      await expect(svc.getProviderToken("openai-codex")).rejects.toThrow(/Not logged in to openai-codex/);
    });

    it("throws when an unknown provider is requested", async () => {
      const svc = makeService();
      await expect(svc.getProviderToken("nonsense-provider")).rejects.toThrow(/Unknown provider/);
    });

    it("reads env-var providers from process.env", async () => {
      process.env["ANTHROPIC_API_KEY"] = "sk-anthropic-test";
      process.env["OPENAI_API_KEY"] = "sk-openai-test";
      const svc = makeService();
      await expect(svc.getProviderToken("anthropic")).resolves.toBe("sk-anthropic-test");
      await expect(svc.getProviderToken("openai")).resolves.toBe("sk-openai-test");
    });

    it("throws a descriptive error when env-var provider is missing its env var", async () => {
      const svc = makeService();
      await expect(svc.getProviderToken("groq")).rejects.toThrow(/No API key configured for groq \(set GROQ_API_KEY\)/);
    });

    it("returns apiKey for OAuth provider with fresh stored credentials (no refresh)", async () => {
      const mock = makeMockProvider();
      const stored = {
        refresh: "rt",
        access: "access-token-v1",
        expires: Date.now() + 3_600_000,
        storedAt: Date.now(),
      };
      await fs.mkdir(path.dirname(tokensPath), { recursive: true });
      await fs.writeFile(tokensPath, JSON.stringify({ "openai-codex": stored }, null, 2));

      const svc = makeService(mock.provider);
      const token = await svc.getProviderToken("openai-codex");
      expect(token).toBe("access-token-v1");
      expect(mock.refreshMock).not.toHaveBeenCalled();

      const onDisk = JSON.parse(await fs.readFile(tokensPath, "utf-8"));
      expect(onDisk["openai-codex"]).toEqual(stored);
    });

    it("persists refreshed credentials when the token has expired", async () => {
      const mock = makeMockProvider();
      mock.refreshMock.mockResolvedValueOnce({
        refresh: "rt-v2",
        access: "access-token-v2",
        expires: Date.now() + 3_600_000,
      });

      const stored = {
        refresh: "rt-v1",
        access: "access-token-v1",
        expires: Date.now() - 1000, // expired
        storedAt: Date.now() - 10_000,
      };
      await fs.mkdir(path.dirname(tokensPath), { recursive: true });
      await fs.writeFile(tokensPath, JSON.stringify({ "openai-codex": stored }, null, 2));

      const svc = makeService(mock.provider);
      const token = await svc.getProviderToken("openai-codex");
      expect(token).toBe("access-token-v2");

      const onDisk = JSON.parse(await fs.readFile(tokensPath, "utf-8"));
      expect(onDisk["openai-codex"].refresh).toBe("rt-v2");
      expect(onDisk["openai-codex"].access).toBe("access-token-v2");
      expect(onDisk["openai-codex"].storedAt).toBeTypeOf("number");
    });
  });

  describe("startOAuthLogin", () => {
    it("drives the provider's login flow, opens the browser, and persists credentials", async () => {
      const mock = makeMockProvider();
      const svc = makeService(mock.provider);
      const pending = svc.startOAuthLogin("openai-codex");

      await new Promise((r) => setTimeout(r, 10));
      expect(openBrowser).toHaveBeenCalledWith("https://auth.example.com/authorize?state=stub");

      mock.settle({ refresh: "rt", access: "at", expires: Date.now() + 3_600_000 });
      const result = await pending;
      expect(result).toEqual({ success: true });

      const onDisk = JSON.parse(await fs.readFile(tokensPath, "utf-8"));
      expect(onDisk["openai-codex"].refresh).toBe("rt");
      expect(onDisk["openai-codex"].access).toBe("at");
    });

    it("returns { success: false, error } when login throws", async () => {
      const mock = makeMockProvider();
      const svc = makeService(mock.provider);
      const pending = svc.startOAuthLogin("openai-codex");
      await new Promise((r) => setTimeout(r, 10));
      mock.fail(new Error("user cancelled"));
      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.error).toBe("user cancelled");
    });

    it("returns { success: false, error } for providers with no OAuth support", async () => {
      const svc = makeService();
      const result = await svc.startOAuthLogin("anthropic");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/OAuth not supported/);
    });
  });

  describe("listProviders", () => {
    it("returns both OAuth and env-var sources with correct status", async () => {
      process.env["ANTHROPIC_API_KEY"] = "sk-anthropic-test";
      const svc = makeService();
      const providers = await svc.listProviders();

      const oauthCodex = providers.find(p => p.provider === "openai-codex");
      expect(oauthCodex).toBeDefined();
      expect(oauthCodex!.kind).toBe("oauth");
      expect(oauthCodex!.status).toBe("disconnected");

      const anthropic = providers.find(p => p.provider === "anthropic");
      expect(anthropic!.status).toBe("configured");
      expect(anthropic!.envVar).toBe("ANTHROPIC_API_KEY");

      const openai = providers.find(p => p.provider === "openai");
      expect(openai!.status).toBe("missing");
    });

    it("marks an OAuth provider as connected after login persists credentials", async () => {
      const mock = makeMockProvider();
      const svc = makeService(mock.provider);
      const pending = svc.startOAuthLogin("openai-codex");
      await new Promise((r) => setTimeout(r, 10));
      mock.settle({ refresh: "rt", access: "at", expires: Date.now() + 3_600_000 });
      await pending;

      const providers = await svc.listProviders();
      const codex = providers.find(p => p.provider === "openai-codex");
      expect(codex!.status).toBe("connected");
    });
  });

  describe("logout", () => {
    it("removes credentials and updates status to disconnected", async () => {
      const mock = makeMockProvider();
      const svc = makeService(mock.provider);
      const pending = svc.startOAuthLogin("openai-codex");
      await new Promise((r) => setTimeout(r, 10));
      mock.settle({ refresh: "rt", access: "at", expires: Date.now() + 3_600_000 });
      await pending;

      await svc.logout("openai-codex");
      const onDisk = JSON.parse(await fs.readFile(tokensPath, "utf-8"));
      expect(onDisk["openai-codex"]).toBeUndefined();
      await expect(svc.getProviderToken("openai-codex")).rejects.toThrow(/Not logged in/);
    });
  });

  describe("startOAuthLogin idempotency", () => {
    it("fast-path: returns success without starting a new flow when credentials already exist", async () => {
      const mock = makeMockProvider();
      const stored = {
        refresh: "rt",
        access: "at",
        expires: Date.now() + 3_600_000,
        storedAt: Date.now(),
      };
      await fs.mkdir(path.dirname(tokensPath), { recursive: true });
      await fs.writeFile(tokensPath, JSON.stringify({ "openai-codex": stored }, null, 2));

      const svc = makeService(mock.provider);
      const result = await svc.startOAuthLogin("openai-codex");
      expect(result).toEqual({ success: true });
      expect(mock.loginMock).not.toHaveBeenCalled();
      expect(openBrowser).not.toHaveBeenCalled();
    });

    it("dedupe: concurrent calls share the same in-flight Promise", async () => {
      const mock = makeMockProvider();
      const svc = makeService(mock.provider);
      const callA = svc.startOAuthLogin("openai-codex");
      const callB = svc.startOAuthLogin("openai-codex");
      await new Promise((r) => setTimeout(r, 10));
      mock.settle({ refresh: "rt", access: "at", expires: Date.now() + 3_600_000 });
      const [resA, resB] = await Promise.all([callA, callB]);
      expect(resA).toEqual({ success: true });
      expect(resB).toEqual({ success: true });
      expect(mock.loginMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("waitForProvider", () => {
    it("returns immediately when an env-var token is already set", async () => {
      process.env["ANTHROPIC_API_KEY"] = "sk-anthropic";
      const svc = makeService();
      await expect(svc.waitForProvider("anthropic")).resolves.toBeUndefined();
    });

    it("returns immediately when OAuth credentials are already stored", async () => {
      const mock = makeMockProvider();
      const stored = {
        refresh: "rt", access: "at",
        expires: Date.now() + 3_600_000, storedAt: Date.now(),
      };
      await fs.mkdir(path.dirname(tokensPath), { recursive: true });
      await fs.writeFile(tokensPath, JSON.stringify({ "openai-codex": stored }, null, 2));
      const svc = makeService(mock.provider);
      await expect(svc.waitForProvider("openai-codex")).resolves.toBeUndefined();
    });

    it("blocks until startOAuthLogin completes, then resolves", async () => {
      const mock = makeMockProvider();
      const svc = makeService(mock.provider);

      const waitPromise = svc.waitForProvider("openai-codex", 5000);
      const loginCall = svc.startOAuthLogin("openai-codex");

      let waitResolved = false;
      void waitPromise.then(() => { waitResolved = true; });
      await new Promise((r) => setTimeout(r, 20));
      expect(waitResolved).toBe(false);

      mock.settle({ refresh: "rt", access: "at", expires: Date.now() + 3_600_000 });
      await loginCall;
      await waitPromise;
      expect(waitResolved).toBe(true);
    });

    it("multiple waiters all unblock when login completes", async () => {
      const mock = makeMockProvider();
      const svc = makeService(mock.provider);
      const waitA = svc.waitForProvider("openai-codex", 5000);
      const waitB = svc.waitForProvider("openai-codex", 5000);
      const waitC = svc.waitForProvider("openai-codex", 5000);
      const loginCall = svc.startOAuthLogin("openai-codex");

      await new Promise((r) => setTimeout(r, 10));
      mock.settle({ refresh: "rt", access: "at", expires: Date.now() + 3_600_000 });
      await loginCall;
      await Promise.all([waitA, waitB, waitC]);
    });

    it("rejects with a timeout error if no login completes in time", async () => {
      const svc = makeService();
      await expect(svc.waitForProvider("openai-codex", 30)).rejects.toThrow(/Timed out/);
    });
  });
});
