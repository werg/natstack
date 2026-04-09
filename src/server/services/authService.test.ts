import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Mock pi-ai's oauth subpath before importing the module under test so the
// mock takes effect. (pi-ai 0.66+ exposes the runtime oauth helpers via the
// `@mariozechner/pi-ai/oauth` deep import; only types live on the root.)
vi.mock("@mariozechner/pi-ai/oauth", () => {
  const mockLogin = vi.fn();
  const mockGetOAuthApiKey = vi.fn();
  return {
    openaiCodexOAuthProvider: {
      id: "openai-codex",
      name: "OpenAI Codex",
      login: mockLogin,
      refreshToken: vi.fn(),
      getApiKey: vi.fn(),
      usesCallbackServer: true,
    },
    getOAuthApiKey: mockGetOAuthApiKey,
  };
});

// Import after mocking.
import { AuthServiceImpl } from "./authService.js";
import * as piAiOauth from "@mariozechner/pi-ai/oauth";

const mockedLogin = (piAiOauth as unknown as { openaiCodexOAuthProvider: { login: ReturnType<typeof vi.fn> } }).openaiCodexOAuthProvider.login;
const mockedGetOAuthApiKey = (piAiOauth as unknown as { getOAuthApiKey: ReturnType<typeof vi.fn> }).getOAuthApiKey;

describe("AuthServiceImpl", () => {
  let tmpDir: string;
  let tokensPath: string;
  let openBrowser: ReturnType<typeof vi.fn>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "authsvc-test-"));
    tokensPath = path.join(tmpDir, "oauth-tokens.json");
    openBrowser = vi.fn();
    mockedLogin.mockReset();
    mockedGetOAuthApiKey.mockReset();

    // Clear env-var providers so tests start from a known state.
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
    // Restore env.
    process.env = { ...originalEnv };
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeService() {
    return new AuthServiceImpl({ openBrowser, tokensPath });
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

    it("returns apiKey from pi-ai for OAuth provider with stored credentials (no refresh)", async () => {
      const stored = {
        refresh: "refresh-token-v1",
        access: "access-token-v1",
        expires: Date.now() + 3_600_000,
        storedAt: Date.now(),
      };
      await fs.mkdir(path.dirname(tokensPath), { recursive: true });
      await fs.writeFile(tokensPath, JSON.stringify({ "openai-codex": stored }, null, 2));

      // When no refresh happens, pi-ai returns the SAME reference.
      mockedGetOAuthApiKey.mockImplementation(async (providerId, creds) => {
        const current = creds[providerId];
        return { newCredentials: current, apiKey: "extracted-api-key-v1" };
      });

      const svc = makeService();
      const token = await svc.getProviderToken("openai-codex");

      expect(token).toBe("extracted-api-key-v1");
      expect(mockedGetOAuthApiKey).toHaveBeenCalledWith("openai-codex", { "openai-codex": stored });

      // Credentials on disk should be unchanged.
      const onDisk = JSON.parse(await fs.readFile(tokensPath, "utf-8"));
      expect(onDisk["openai-codex"]).toEqual(stored);
    });

    it("persists refreshed credentials when pi-ai returns new ones", async () => {
      const stored = {
        refresh: "refresh-token-v1",
        access: "access-token-v1",
        expires: Date.now() - 1000, // expired
        storedAt: Date.now() - 10_000,
      };
      await fs.mkdir(path.dirname(tokensPath), { recursive: true });
      await fs.writeFile(tokensPath, JSON.stringify({ "openai-codex": stored }, null, 2));

      const refreshed = {
        refresh: "refresh-token-v2",
        access: "access-token-v2",
        expires: Date.now() + 3_600_000,
      };
      mockedGetOAuthApiKey.mockResolvedValue({
        newCredentials: refreshed,
        apiKey: "extracted-api-key-v2",
      });

      const svc = makeService();
      const token = await svc.getProviderToken("openai-codex");

      expect(token).toBe("extracted-api-key-v2");

      // Verify the new credentials were persisted to disk.
      const onDisk = JSON.parse(await fs.readFile(tokensPath, "utf-8"));
      expect(onDisk["openai-codex"].refresh).toBe("refresh-token-v2");
      expect(onDisk["openai-codex"].access).toBe("access-token-v2");
      expect(onDisk["openai-codex"].storedAt).toBeTypeOf("number");
    });
  });

  describe("startOAuthLogin", () => {
    it("drives pi-ai's login flow, opens the browser via the dep, and persists credentials", async () => {
      const credentials = {
        refresh: "rt",
        access: "at",
        expires: Date.now() + 3_600_000,
      };
      mockedLogin.mockImplementation(async (callbacks: {
        onAuth: (info: { url: string }) => void;
      }) => {
        // Simulate pi-ai emitting the auth URL, then completing.
        callbacks.onAuth({ url: "https://auth.openai.com/login?code=abc" });
        return credentials;
      });

      const svc = makeService();
      const result = await svc.startOAuthLogin("openai-codex");

      expect(result).toEqual({ success: true });
      expect(openBrowser).toHaveBeenCalledWith("https://auth.openai.com/login?code=abc");

      const onDisk = JSON.parse(await fs.readFile(tokensPath, "utf-8"));
      expect(onDisk["openai-codex"].refresh).toBe("rt");
      expect(onDisk["openai-codex"].access).toBe("at");
    });

    it("returns { success: false, error } when pi-ai login throws", async () => {
      mockedLogin.mockRejectedValue(new Error("user cancelled"));

      const svc = makeService();
      const result = await svc.startOAuthLogin("openai-codex");

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
      // openai-codex has no stored credentials → disconnected.
      // openai has no env var → missing.

      const svc = makeService();
      const providers = await svc.listProviders();

      const oauthCodex = providers.find(p => p.provider === "openai-codex");
      expect(oauthCodex).toBeDefined();
      expect(oauthCodex!.kind).toBe("oauth");
      expect(oauthCodex!.status).toBe("disconnected");

      const anthropic = providers.find(p => p.provider === "anthropic");
      expect(anthropic).toBeDefined();
      expect(anthropic!.kind).toBe("env-var");
      expect(anthropic!.status).toBe("configured");
      expect(anthropic!.envVar).toBe("ANTHROPIC_API_KEY");

      const openai = providers.find(p => p.provider === "openai");
      expect(openai).toBeDefined();
      expect(openai!.status).toBe("missing");
    });

    it("marks an OAuth provider as connected after login persists credentials", async () => {
      const credentials = { refresh: "rt", access: "at", expires: Date.now() + 3_600_000 };
      mockedLogin.mockResolvedValue(credentials);

      const svc = makeService();
      await svc.startOAuthLogin("openai-codex");

      const providers = await svc.listProviders();
      const codex = providers.find(p => p.provider === "openai-codex");
      expect(codex!.status).toBe("connected");
    });
  });

  describe("logout", () => {
    it("removes credentials and updates status to disconnected", async () => {
      const credentials = { refresh: "rt", access: "at", expires: Date.now() + 3_600_000 };
      mockedLogin.mockResolvedValue(credentials);

      const svc = makeService();
      await svc.startOAuthLogin("openai-codex");
      await svc.logout("openai-codex");

      const onDisk = JSON.parse(await fs.readFile(tokensPath, "utf-8"));
      expect(onDisk["openai-codex"]).toBeUndefined();

      await expect(svc.getProviderToken("openai-codex")).rejects.toThrow(/Not logged in/);
    });
  });

  describe("startOAuthLogin idempotency", () => {
    it("fast-path: returns success without starting a new flow when credentials already exist", async () => {
      // Pre-populate credentials so the fast path triggers.
      const stored = {
        refresh: "rt",
        access: "at",
        expires: Date.now() + 3_600_000,
        storedAt: Date.now(),
      };
      await fs.mkdir(path.dirname(tokensPath), { recursive: true });
      await fs.writeFile(tokensPath, JSON.stringify({ "openai-codex": stored }, null, 2));
      mockedGetOAuthApiKey.mockResolvedValue({
        newCredentials: stored,
        apiKey: "extracted-key",
      });

      const svc = makeService();
      const result = await svc.startOAuthLogin("openai-codex");

      expect(result).toEqual({ success: true });
      // pi-ai's login should NOT have been called — fast path bypassed it.
      expect(mockedLogin).not.toHaveBeenCalled();
      expect(openBrowser).not.toHaveBeenCalled();
    });

    it("dedupe: concurrent calls share the same in-flight Promise", async () => {
      // Make pi-ai's login take a beat so both calls overlap.
      let resolveLogin: ((creds: unknown) => void) | undefined;
      const loginPromise = new Promise((resolve) => { resolveLogin = resolve; });
      mockedLogin.mockReturnValue(loginPromise);

      const svc = makeService();
      const callA = svc.startOAuthLogin("openai-codex");
      const callB = svc.startOAuthLogin("openai-codex");

      // Resolve once. Both calls should settle.
      resolveLogin!({ refresh: "rt", access: "at", expires: Date.now() + 3_600_000 });
      const [resA, resB] = await Promise.all([callA, callB]);

      expect(resA).toEqual({ success: true });
      expect(resB).toEqual({ success: true });
      // Critical: pi-ai's login was only called ONCE despite two concurrent callers.
      expect(mockedLogin).toHaveBeenCalledTimes(1);
    });
  });

  describe("waitForProvider", () => {
    it("returns immediately when an env-var token is already set", async () => {
      process.env["ANTHROPIC_API_KEY"] = "sk-anthropic";
      const svc = makeService();
      await expect(svc.waitForProvider("anthropic")).resolves.toBeUndefined();
    });

    it("returns immediately when OAuth credentials are already stored", async () => {
      const stored = {
        refresh: "rt",
        access: "at",
        expires: Date.now() + 3_600_000,
        storedAt: Date.now(),
      };
      await fs.mkdir(path.dirname(tokensPath), { recursive: true });
      await fs.writeFile(tokensPath, JSON.stringify({ "openai-codex": stored }, null, 2));
      mockedGetOAuthApiKey.mockResolvedValue({
        newCredentials: stored,
        apiKey: "k",
      });

      const svc = makeService();
      await expect(svc.waitForProvider("openai-codex")).resolves.toBeUndefined();
    });

    it("blocks until startOAuthLogin completes, then resolves", async () => {
      let resolveLogin: ((creds: unknown) => void) | undefined;
      const loginPromise = new Promise((resolve) => { resolveLogin = resolve; });
      mockedLogin.mockReturnValue(loginPromise);

      const svc = makeService();

      // Park a waiter and a login concurrently.
      const waitPromise = svc.waitForProvider("openai-codex", 5000);
      const loginCall = svc.startOAuthLogin("openai-codex");

      // Waiter should still be pending.
      let waitResolved = false;
      void waitPromise.then(() => { waitResolved = true; });
      await new Promise((r) => setTimeout(r, 20));
      expect(waitResolved).toBe(false);

      // Complete the login.
      resolveLogin!({ refresh: "rt", access: "at", expires: Date.now() + 3_600_000 });
      await loginCall;
      await waitPromise;
      expect(waitResolved).toBe(true);
    });

    it("multiple waiters all unblock when login completes", async () => {
      let resolveLogin: ((creds: unknown) => void) | undefined;
      const loginPromise = new Promise((resolve) => { resolveLogin = resolve; });
      mockedLogin.mockReturnValue(loginPromise);

      const svc = makeService();
      const waitA = svc.waitForProvider("openai-codex", 5000);
      const waitB = svc.waitForProvider("openai-codex", 5000);
      const waitC = svc.waitForProvider("openai-codex", 5000);
      const loginCall = svc.startOAuthLogin("openai-codex");

      resolveLogin!({ refresh: "rt", access: "at", expires: Date.now() + 3_600_000 });
      await loginCall;
      await Promise.all([waitA, waitB, waitC]);
      // If any of them hadn't resolved, Promise.all would have hung — passing
      // implies all three notified.
    });

    it("rejects with a timeout error if no login completes in time", async () => {
      const svc = makeService();
      await expect(svc.waitForProvider("openai-codex", 30)).rejects.toThrow(/Timed out/);
    });
  });
});
