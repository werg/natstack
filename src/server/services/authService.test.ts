/**
 * AuthTokensServiceImpl tests — env-var providers, credential persistence,
 * `persist` from a client-driven flow, refresh-on-expiry,
 * `waitForProvider` semantics.
 *
 * The service no longer drives an interactive login (that moved to the
 * Electron main / mobile shell), so there's no `startOAuthLogin` to test
 * here. We exercise `persist` + `waitForProvider` to cover the unblock
 * path that agent workers rely on.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "@mariozechner/pi-ai";
import { createInMemorySecretsStore } from "@natstack/shared/secrets/testing";
import { AuthTokensServiceImpl } from "./authService.js";

function makeMockProvider(): {
  provider: OAuthProviderInterface;
  refreshMock: ReturnType<typeof vi.fn>;
} {
  const refreshMock = vi.fn(async (creds: OAuthCredentials) => creds);
  const provider: OAuthProviderInterface = {
    id: "openai-codex",
    name: "Mock Codex",
    usesCallbackServer: false,
    login: async (_callbacks: OAuthLoginCallbacks) => {
      throw new Error("login should not run server-side after refactor");
    },
    refreshToken: refreshMock as OAuthProviderInterface["refreshToken"],
    getApiKey: (creds) => creds.access,
  };
  return { provider, refreshMock };
}

describe("AuthTokensServiceImpl", () => {
  let tmpDir: string;
  let tokensPath: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "authtokens-test-"));
    tokensPath = path.join(tmpDir, "oauth-tokens.json");
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

  function makeService(providerOverride?: OAuthProviderInterface, secrets: Record<string, string> = {}) {
    return new AuthTokensServiceImpl({
      tokensPath,
      providerOverrides: providerOverride ? { "openai-codex": providerOverride } : undefined,
      secretsStore: createInMemorySecretsStore(secrets),
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

    it("reads env-var providers from the secrets store without needing process.env", async () => {
      const svc = makeService(undefined, {
        anthropic: "sk-anthropic-secret",
        openai: "sk-openai-secret",
      });
      await expect(svc.getProviderToken("anthropic")).resolves.toBe("sk-anthropic-secret");
      await expect(svc.getProviderToken("openai")).resolves.toBe("sk-openai-secret");
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
        expires: Date.now() - 1000,
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

  describe("persist", () => {
    it("writes credentials supplied by a client-side flow and unblocks waiters", async () => {
      const mock = makeMockProvider();
      const svc = makeService(mock.provider);

      const wait = svc.waitForProvider("openai-codex", 5000);
      let resolved = false;
      void wait.then(() => { resolved = true; });
      await new Promise((r) => setTimeout(r, 20));
      expect(resolved).toBe(false);

      await svc.persist("openai-codex", {
        access: "at",
        refresh: "rt",
        expires: Date.now() + 3_600_000,
        extra: { accountId: "acct-123" },
      });

      await wait;
      expect(resolved).toBe(true);
      const onDisk = JSON.parse(await fs.readFile(tokensPath, "utf-8"));
      expect(onDisk["openai-codex"].access).toBe("at");
      expect(onDisk["openai-codex"].refresh).toBe("rt");
      expect(onDisk["openai-codex"].accountId).toBe("acct-123");
    });

    it("rejects providerIds that aren't OAuth-capable", async () => {
      const svc = makeService();
      await expect(
        svc.persist("anthropic", { access: "a", refresh: "r", expires: Date.now() + 1000 }),
      ).rejects.toThrow(/OAuth not supported/);
    });
  });

  describe("listProviders", () => {
    it("returns both OAuth and env-var sources with correct status", async () => {
      const svc = makeService(undefined, { anthropic: "sk-anthropic-test" });
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

    it("marks an OAuth provider as connected after persist lands credentials", async () => {
      const mock = makeMockProvider();
      const svc = makeService(mock.provider);
      await svc.persist("openai-codex", {
        access: "at",
        refresh: "rt",
        expires: Date.now() + 3_600_000,
      });

      const providers = await svc.listProviders();
      const codex = providers.find(p => p.provider === "openai-codex");
      expect(codex!.status).toBe("connected");
    });
  });

  describe("logout", () => {
    it("removes credentials and updates status to disconnected", async () => {
      const mock = makeMockProvider();
      const svc = makeService(mock.provider);
      await svc.persist("openai-codex", {
        access: "at",
        refresh: "rt",
        expires: Date.now() + 3_600_000,
      });

      await svc.logout("openai-codex");
      const onDisk = JSON.parse(await fs.readFile(tokensPath, "utf-8"));
      expect(onDisk["openai-codex"]).toBeUndefined();
      await expect(svc.getProviderToken("openai-codex")).rejects.toThrow(/Not logged in/);
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

    it("multiple waiters all unblock when persist lands", async () => {
      const mock = makeMockProvider();
      const svc = makeService(mock.provider);
      const waitA = svc.waitForProvider("openai-codex", 5000);
      const waitB = svc.waitForProvider("openai-codex", 5000);
      const waitC = svc.waitForProvider("openai-codex", 5000);

      await new Promise((r) => setTimeout(r, 10));
      await svc.persist("openai-codex", {
        access: "at", refresh: "rt", expires: Date.now() + 3_600_000,
      });
      await Promise.all([waitA, waitB, waitC]);
    });

    it("rejects with a timeout error if no persist lands in time", async () => {
      const svc = makeService();
      await expect(svc.waitForProvider("openai-codex", 30)).rejects.toThrow(/Timed out/);
    });
  });
});
