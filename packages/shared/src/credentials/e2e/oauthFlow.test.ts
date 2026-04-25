import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditLog } from "../audit.js";
import { checkCapability } from "../capability.js";
import { CredentialStore } from "../store.js";
import { MockOAuthServer } from "../test-utils/mockOAuthServer.js";
import { MockProvider } from "../test-utils/mockProvider.js";
import type { AuditEntry, Credential, EndpointDeclaration, ProviderManifest } from "../types.js";

function createProviderManifest(oauthBaseUrl: string, apiBaseUrl: string): ProviderManifest {
  return {
    id: "mock-oauth",
    displayName: "Mock OAuth Provider",
    clientId: "mock-client-id",
    apiBase: [apiBaseUrl],
    flows: [
      {
        type: "loopback-pkce",
        clientId: "mock-client-id",
        authorizeUrl: `${oauthBaseUrl}/authorize`,
        tokenUrl: `${oauthBaseUrl}/token`,
      },
    ],
    scopes: {
      "profile:read": "Read the authenticated profile",
    },
  };
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

describe("OAuth flow e2e", () => {
  let tempDir: string;
  let credentialDir: string;
  let auditDir: string;
  let oauthServer: MockOAuthServer;
  let provider: MockProvider;
  let store: CredentialStore;
  let auditLog: AuditLog;
  let manifest: ProviderManifest;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "natstack-credentials-e2e-"));
    credentialDir = path.join(tempDir, "credentials");
    auditDir = path.join(tempDir, "audit");

    await mkdir(credentialDir, { recursive: true });
    await mkdir(auditDir, { recursive: true });

    oauthServer = await MockOAuthServer.start({
      code: "test-authorization-code",
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      expiresIn: 1800,
    });
    provider = await MockProvider.start({
      fixtures: {
        "/v1/me": {
          status: 200,
          body: { ok: true, user: "oauth-user" },
        },
      },
    });

    store = new CredentialStore({ basePath: credentialDir });
    auditLog = new AuditLog({ logDir: auditDir });
    manifest = createProviderManifest(`http://127.0.0.1:${oauthServer.port}`, provider.baseUrl);
  });

  afterEach(async () => {
    auditLog?.close();
    await provider?.stop();
    await oauthServer?.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("completes consent, stores the token, fetches with auth, records audit, and enforces capabilities", async () => {
    const flow = manifest.flows.find((candidate) => candidate.type === "loopback-pkce");
    if (!flow?.authorizeUrl || !flow.tokenUrl || !flow.clientId) {
      throw new Error("Expected a loopback PKCE flow with authorizeUrl, tokenUrl, and clientId");
    }

    const redirectUri = "http://127.0.0.1/callback";
    const state = "oauth-flow-state";
    const { verifier, challenge } = createPkcePair();

    const authorizeUrl = new URL(flow.authorizeUrl);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", flow.clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", state);

    const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" });
    expect(authorizeResponse.status).toBe(302);

    const redirectLocation = authorizeResponse.headers.get("location");
    expect(redirectLocation).toBeTruthy();

    const callbackUrl = new URL(redirectLocation!);
    const code = callbackUrl.searchParams.get("code");

    expect(code).toBe("test-authorization-code");
    expect(callbackUrl.searchParams.get("state")).toBe(state);

    const tokenResponse = await fetch(flow.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: flow.clientId,
        code: code ?? "",
        redirect_uri: redirectUri,
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

    expect(tokenPayload).toEqual({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      token_type: "Bearer",
      expires_in: 1800,
    });
    expect(oauthServer.tokenRequestCount).toBe(1);

    const credential: Credential = {
      providerId: manifest.id,
      connectionId: "primary",
      connectionLabel: "Primary Mock OAuth Connection",
      accountIdentity: {
        providerUserId: "oauth-user-123",
        username: "oauth-user",
      },
      accessToken: tokenPayload.access_token,
      refreshToken: tokenPayload.refresh_token,
      scopes: ["profile:read"],
      expiresAt: Date.now() + tokenPayload.expires_in * 1000,
    };

    await store.save(credential);

    const persistedPath = path.join(
      credentialDir,
      credential.providerId,
      `${credential.connectionId}.json`,
    );
    // Audit finding #10: the on-disk file is now an encrypted envelope, not
    // plaintext credential JSON. Verify the envelope shape on disk and rely on
    // store.load() for the round-trip equality check.
    const persistedRaw = JSON.parse(await readFile(persistedPath, "utf8")) as { v?: string; ct?: string };
    expect(persistedRaw.v).toMatch(/^v1-/);
    expect(typeof persistedRaw.ct).toBe("string");

    await expect(store.load(credential.providerId, credential.connectionId)).resolves.toEqual(credential);
    await expect(store.list(credential.providerId)).resolves.toEqual([credential]);

    const apiUrl = `${manifest.apiBase[0]}/v1/me`;
    const apiResponse = await fetch(apiUrl, {
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
      },
    });

    expect(apiResponse.ok).toBe(true);
    expect(apiResponse.status).toBe(200);
    await expect(apiResponse.json()).resolves.toEqual({ ok: true, user: "oauth-user" });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      method: "GET",
      path: "/v1/me",
    });
    expect(provider.requests[0]?.headers["authorization"]).toBe(`Bearer ${credential.accessToken}`);

    const auditEntry: AuditEntry = {
      ts: Date.now(),
      workerId: "worker-oauth-e2e",
      callerId: "oauth-flow-test",
      providerId: credential.providerId,
      connectionId: credential.connectionId,
      method: "GET",
      url: apiUrl,
      status: apiResponse.status,
      durationMs: 5,
      bytesIn: JSON.stringify({ ok: true, user: "oauth-user" }).length,
      bytesOut: 0,
      scopesUsed: credential.scopes,
      retries: 0,
      breakerState: "closed",
    };

    await auditLog.append(auditEntry);

    await expect(
      auditLog.query({
        filter: {
          providerId: credential.providerId,
          connectionId: credential.connectionId,
          method: "GET",
        },
      }),
    ).resolves.toEqual([auditEntry]);

    const declarations: EndpointDeclaration[] = [
      {
        url: `${manifest.apiBase[0]}/v1/**`,
        methods: ["GET"],
      },
    ];

    expect(checkCapability(`${manifest.apiBase[0]}/v1/me?expand=profile`, "GET", declarations)).toBe(
      "allow",
    );
    expect(checkCapability(`${manifest.apiBase[0]}/admin`, "GET", declarations)).toBe("deny");
  });
});
