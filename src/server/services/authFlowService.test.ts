import { describe, it, expect, vi } from "vitest";
import type { AuthFlowCredentials, AuthFlowSession } from "@natstack/auth-flow";
import { createAuthFlowService } from "./authFlowService.js";

interface MockAuthTokens {
  persist: ReturnType<typeof vi.fn>;
  listProviders: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
}

function makeSession(redirectUri: string): AuthFlowSession {
  return {
    providerId: "openai-codex",
    redirectUri,
    state: "test-state",
    verifier: "test-verifier",
  };
}

function makeCredentials(): AuthFlowCredentials {
  return {
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
    accountId: "acct-123",
  } as AuthFlowCredentials;
}

describe("authFlowService", () => {
  function makeDeps() {
    const authTokens: MockAuthTokens = {
      persist: vi.fn(async () => {}),
      listProviders: vi.fn(async () => [{ provider: "openai-codex", kind: "oauth", status: "disconnected", displayName: "OpenAI Codex" }]),
      logout: vi.fn(async () => {}),
    };
    const buildAuthUrl = vi.fn(async (redirectUri: string) => ({
      authUrl: `https://example.test/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`,
      session: makeSession(redirectUri),
    }));
    const exchangeCode = vi.fn(async () => makeCredentials());

    const service = createAuthFlowService({
      authTokens: authTokens as never,
      providers: {
        "openai-codex": {
          buildAuthUrl,
          exchangeCode,
        },
      },
    });

    return { authTokens, buildAuthUrl, exchangeCode, service };
  }

  it("starts and completes an OAuth flow on the server, then persists credentials", async () => {
    const { service, authTokens, exchangeCode } = makeDeps();
    const redirectUri = "http://localhost:1455/auth/callback";

    const started = await service.handler(
      { callerId: "shell", callerKind: "shell" },
      "startOAuthLogin",
      ["openai-codex", redirectUri],
    ) as { flowId: string; authUrl: string };

    expect(started.flowId).toBeTypeOf("string");
    expect(started.authUrl).toContain("https://example.test/authorize");

    const completed = await service.handler(
      { callerId: "shell", callerKind: "shell" },
      "completeOAuthLogin",
      [started.flowId, { callbackUrl: `${redirectUri}?state=test-state&code=auth-code` }],
    );

    expect(completed).toEqual({ success: true });
    expect(exchangeCode).toHaveBeenCalledWith({
      code: "auth-code",
      verifier: "test-verifier",
      redirectUri,
    });
    expect(authTokens.persist).toHaveBeenCalledWith("openai-codex", {
      access: "access-token",
      refresh: "refresh-token",
      expires: expect.any(Number),
      extra: { accountId: "acct-123" },
    });
  });

  it("rejects callback completion when the OAuth state does not match", async () => {
    const { service, authTokens, exchangeCode } = makeDeps();
    const redirectUri = "http://localhost:1455/auth/callback";

    const started = await service.handler(
      { callerId: "shell", callerKind: "shell" },
      "startOAuthLogin",
      ["openai-codex", redirectUri],
    ) as { flowId: string };

    await expect(
      service.handler(
        { callerId: "shell", callerKind: "shell" },
        "completeOAuthLogin",
        [started.flowId, { callbackUrl: `${redirectUri}?state=wrong-state&code=auth-code` }],
      ),
    ).rejects.toThrow(/state mismatch/i);

    expect(exchangeCode).not.toHaveBeenCalled();
    expect(authTokens.persist).not.toHaveBeenCalled();
  });

  it("delegates listProviders and logout to authTokens", async () => {
    const { service, authTokens } = makeDeps();

    const providers = await service.handler(
      { callerId: "shell", callerKind: "shell" },
      "listProviders",
      [],
    );
    expect(providers).toEqual(await authTokens.listProviders.mock.results[0]?.value);

    await service.handler(
      { callerId: "shell", callerKind: "shell" },
      "logout",
      ["openai-codex"],
    );
    expect(authTokens.logout).toHaveBeenCalledWith("openai-codex");
  });
});
