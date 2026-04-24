import { afterEach, describe, expect, it, vi } from "vitest";

import type { Credential } from "../../../packages/shared/src/credentials/types.js";
import { createCredentialService } from "./credentialService.js";

class MemoryCredentialStore {
  private readonly credentials = new Map<string, Credential>();

  async save(credential: Credential): Promise<void> {
    this.credentials.set(`${credential.providerId}:${credential.connectionId}`, credential);
  }

  async load(providerId: string, connectionId: string): Promise<Credential | null> {
    return this.credentials.get(`${providerId}:${connectionId}`) ?? null;
  }

  async list(providerId?: string): Promise<Credential[]> {
    return [...this.credentials.values()].filter((credential) =>
      providerId ? credential.providerId === providerId : true
    );
  }

  async remove(providerId: string, connectionId: string): Promise<void> {
    this.credentials.delete(`${providerId}:${connectionId}`);
  }
}

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

describe("credentialService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses fixedScope, extra authorize params, and the client loopback redirect for Codex consent", async () => {
    const store = new MemoryCredentialStore();
    const service = createCredentialService({
      credentialStore: store as never,
    });

    const result = await service.handler(
      { callerId: "panel:test", callerKind: "panel" },
      "beginConsent",
      [{
        providerId: "openai-codex",
        scopes: ["ignored-scope"],
        redirect: "client-loopback",
        redirectUri: "http://localhost:1455/auth/callback",
      }],
    ) as { nonce: string; authorizeUrl: string };

    expect(result.nonce).toBeTruthy();

    const authorizeUrl = new URL(result.authorizeUrl);
    expect(authorizeUrl.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(authorizeUrl.searchParams.get("id_token_add_organizations")).toBe("true");
    expect(authorizeUrl.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(authorizeUrl.searchParams.get("originator")).toBe("codex_cli_rs");
  });

  it("stores Codex account metadata and account identity from the token response", async () => {
    const store = new MemoryCredentialStore();
    const service = createCredentialService({
      credentialStore: store as never,
    });

    const begin = await service.handler(
      { callerId: "panel:test", callerKind: "panel" },
      "beginConsent",
      [{
        providerId: "openai-codex",
        scopes: [],
        redirect: "client-loopback",
        redirectUri: "http://localhost:1455/auth/callback",
      }],
    ) as { nonce: string };

    const accessToken = createJwt({
      sub: "codex-user-1",
      "https://api.openai.com/auth.chatgpt_account_id": "acct_123",
    });
    const idToken = createJwt({
      email: "dev@example.com",
      preferred_username: "dev-user",
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: accessToken,
      id_token: idToken,
      refresh_token: "refresh-1",
      expires_in: "3600",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const result = await service.handler(
      { callerId: "panel:test", callerKind: "panel" },
      "completeConsent",
      [{ nonce: begin.nonce, code: "auth-code-1" }],
    ) as { connectionId: string };

    const saved = await store.load("openai-codex", result.connectionId);
    expect(saved).toMatchObject({
      providerId: "openai-codex",
      connectionId: result.connectionId,
      connectionLabel: "ChatGPT",
      refreshToken: "refresh-1",
      metadata: {
        accountId: "acct_123",
      },
      accountIdentity: {
        providerUserId: "acct_123",
        email: "dev@example.com",
        username: "dev-user",
      },
    });
    expect(saved?.expiresAt).toBeGreaterThan(Date.now());
  });
});
