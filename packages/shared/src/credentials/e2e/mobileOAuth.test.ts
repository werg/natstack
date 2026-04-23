import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CredentialStore } from "../store.js";
import { MockOAuthServer } from "../test-utils/mockOAuthServer.js";
import { MockProvider } from "../test-utils/mockProvider.js";
import type { Credential } from "../types.js";

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

describe("mobile OAuth flow e2e", () => {
  let tempDir: string;
  let credentialDir: string;
  let oauthServer: MockOAuthServer;
  let provider: MockProvider;
  let store: CredentialStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "natstack-mobile-oauth-e2e-"));
    credentialDir = path.join(tempDir, "credentials");
    await mkdir(credentialDir, { recursive: true });

    oauthServer = await MockOAuthServer.start({
      code: "mobile-auth-code",
      accessToken: "mobile-access-token",
      refreshToken: "mobile-refresh-token",
      expiresIn: 3600,
    });

    provider = await MockProvider.start({
      fixtures: {
        "/v1/userinfo": {
          status: 200,
          body: { id: "mobile-user-1", email: "user@example.com" },
        },
      },
    });

    store = new CredentialStore({ basePath: credentialDir });
  });

  afterEach(async () => {
    await provider?.stop();
    await oauthServer?.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("simulates the mobile universal-link callback flow: authorize → callback URL → code exchange → stored credential → authed fetch", async () => {
    const state = randomBytes(16).toString("base64url");
    const { verifier, challenge } = createPkcePair();
    const callbackScheme = "natstack://oauth/callback";

    const authorizeUrl = new URL(oauthServer.authorizeUrl);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "mobile-client-id");
    authorizeUrl.searchParams.set("redirect_uri", callbackScheme);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", state);

    const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" });
    expect(authorizeResponse.status).toBe(302);

    const redirectLocation = authorizeResponse.headers.get("location");
    expect(redirectLocation).toBeTruthy();

    const callbackUrl = new URL(redirectLocation!);
    const code = callbackUrl.searchParams.get("code");
    const returnedState = callbackUrl.searchParams.get("state");

    expect(code).toBe("mobile-auth-code");
    expect(returnedState).toBe(state);

    const tokenResponse = await fetch(oauthServer.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "mobile-client-id",
        code: code!,
        redirect_uri: callbackScheme,
        code_verifier: verifier,
      }),
    });

    expect(tokenResponse.status).toBe(200);

    const tokenPayload = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    };

    expect(tokenPayload.access_token).toBe("mobile-access-token");
    expect(tokenPayload.refresh_token).toBe("mobile-refresh-token");
    expect(tokenPayload.token_type).toBe("Bearer");

    const credential: Credential = {
      providerId: "mock-mobile-provider",
      connectionId: "mobile-primary",
      connectionLabel: "Mobile Device",
      accountIdentity: {
        providerUserId: "mobile-user-1",
        email: "user@example.com",
      },
      accessToken: tokenPayload.access_token,
      refreshToken: tokenPayload.refresh_token,
      scopes: ["profile:read"],
      expiresAt: Date.now() + tokenPayload.expires_in * 1000,
    };

    await store.save(credential);

    const loaded = await store.load(credential.providerId, credential.connectionId);
    expect(loaded).toEqual(credential);

    const apiResponse = await fetch(`${provider.baseUrl}/v1/userinfo`, {
      headers: { authorization: `Bearer ${credential.accessToken}` },
    });

    expect(apiResponse.ok).toBe(true);
    const userData = (await apiResponse.json()) as { id: string; email: string };
    expect(userData.id).toBe("mobile-user-1");
    expect(userData.email).toBe("user@example.com");

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.headers.authorization).toBe(
      `Bearer ${credential.accessToken}`,
    );
  });

  it("handles callback with missing code gracefully", () => {
    const callbackUrl = new URL("natstack://oauth/callback?state=abc123");
    const code = callbackUrl.searchParams.get("code");
    expect(code).toBeNull();
  });

  it("handles callback with missing state gracefully", () => {
    const callbackUrl = new URL("natstack://oauth/callback?code=some-code");
    const state = callbackUrl.searchParams.get("state");
    expect(state).toBeNull();
  });

  it("rejects token exchange with wrong code verifier", async () => {
    const { challenge } = createPkcePair();
    const wrongVerifier = "definitely-wrong-verifier";

    const authorizeUrl = new URL(oauthServer.authorizeUrl);
    authorizeUrl.searchParams.set("redirect_uri", "natstack://oauth/callback");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", "test-state");

    await fetch(authorizeUrl, { redirect: "manual" });

    const tokenResponse = await fetch(oauthServer.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "mobile-client-id",
        code: "mobile-auth-code",
        redirect_uri: "natstack://oauth/callback",
        code_verifier: wrongVerifier,
      }),
    });

    expect(tokenResponse.status).toBe(400);
    const errorBody = (await tokenResponse.json()) as { error: string };
    expect(errorBody.error).toBe("invalid_grant");
  });
});
