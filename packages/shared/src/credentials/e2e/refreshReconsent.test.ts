import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RefreshScheduler } from "../refresh.js";
import { ReconsentHandler } from "../reconsent.js";
import { CredentialStore } from "../store.js";
import { MockOAuthServer } from "../test-utils/mockOAuthServer.js";
import { MockProvider } from "../test-utils/mockProvider.js";
import type { Credential } from "../types.js";

describe("credentials e2e: refresh re-consent loop", () => {
  let tempDir = "";
  let credentialDir = "";
  let oauthServer: MockOAuthServer | undefined;
  let provider: MockProvider | undefined;
  let store: CredentialStore;
  let refreshScheduler: RefreshScheduler;
  let reconsentHandler: ReconsentHandler;
  let reconsentRequests: Array<{ providerId: string; connectionId: string; reason: string }>;

  const providerId = "mock-oauth";
  const connectionId = "primary";

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "natstack-refresh-reconsent-"));
    credentialDir = path.join(tempDir, "credentials");
    await mkdir(credentialDir, { recursive: true });

    oauthServer = await MockOAuthServer.start({
      accessToken: "initial-access-token",
      refreshToken: "initial-refresh-token",
      expiresIn: 60,
      failRefreshAfter: 1,
    });
    provider = await MockProvider.start({
      fixtures: {
        "/v1/me": {
          status: 200,
          body: { ok: true },
        },
      },
    });

    store = new CredentialStore({ basePath: credentialDir });
    reconsentRequests = [];

    refreshScheduler = new RefreshScheduler({
      loadCredential: async (loadedProviderId, loadedConnectionId) => {
        const credential = await store.load(loadedProviderId, loadedConnectionId);
        if (!credential) {
          throw new Error(
            `Expected stored credential for ${loadedProviderId}:${loadedConnectionId}`,
          );
        }
        return credential;
      },
      saveCredential: async (credential) => {
        await store.save(credential);
      },
      executeRefresh: async (credential) => {
        if (!oauthServer) {
          throw new Error("Expected mock OAuth server to be initialized");
        }
        if (!credential.refreshToken) {
          throw new Error("Expected credential to include a refresh token");
        }

        const response = await fetch(oauthServer.tokenUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: credential.refreshToken,
          }),
        });

        const payload = (await response.json()) as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          error?: string;
          error_description?: string;
        };

        if (!response.ok) {
          throw new Error(
            payload.error_description ??
              payload.error ??
              `Token refresh failed with status ${response.status}`,
          );
        }

        if (
          !payload.access_token ||
          !payload.refresh_token ||
          typeof payload.expires_in !== "number"
        ) {
          throw new Error("Mock OAuth server returned an invalid refresh response");
        }

        return {
          ...credential,
          accessToken: payload.access_token,
          refreshToken: payload.refresh_token,
          expiresAt: Date.now() + payload.expires_in * 1000,
        };
      },
      getRefreshBuffer: () => 0,
    });

    reconsentHandler = new ReconsentHandler({
      requestReconsent: async (requestedProviderId, requestedConnectionId, reason) => {
        reconsentRequests.push({
          providerId: requestedProviderId,
          connectionId: requestedConnectionId,
          reason,
        });

        return {
          providerId: requestedProviderId,
          connectionId: requestedConnectionId,
          connectionLabel: "Re-consented Mock OAuth Connection",
          accountIdentity: {
            providerUserId: "user-1",
            username: "oauth-user",
          },
          accessToken: "reconsented-access-token",
          refreshToken: "reconsented-refresh-token",
          scopes: ["profile:read"],
          expiresAt: Date.now() + 60_000,
        };
      },
    });
  });

  afterEach(async () => {
    await provider?.stop();
    await oauthServer?.stop();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("triggers re-consent when token refresh fails", async () => {
    const initialCredential: Credential = {
      providerId,
      connectionId,
      connectionLabel: "Initial Mock OAuth Connection",
      accountIdentity: {
        providerUserId: "user-1",
        username: "oauth-user",
      },
      accessToken: "initial-access-token",
      refreshToken: "initial-refresh-token",
      scopes: ["profile:read"],
      expiresAt: Date.now() + 100,
    };

    await store.save(initialCredential);

    const firstRefreshedCredential = await refreshScheduler.refreshNow(providerId, connectionId);
    const persistedAfterFirstRefresh = await store.load(providerId, connectionId);
    if (!persistedAfterFirstRefresh) {
      throw new Error("Expected credential to be saved after the first refresh");
    }

    expect(firstRefreshedCredential.accessToken).not.toBe(initialCredential.accessToken);
    expect(firstRefreshedCredential.refreshToken).toBeTruthy();
    expect(persistedAfterFirstRefresh).toEqual(firstRefreshedCredential);
    expect(oauthServer!.refreshRequestCount).toBe(1);

    let secondRefreshError: Error | undefined;
    let reconsentedCredential: Credential | undefined;

    try {
      await refreshScheduler.refreshNow(providerId, connectionId);
    } catch (error) {
      secondRefreshError =
        error instanceof Error ? error : new Error(`Unexpected refresh error: ${String(error)}`);
      reconsentedCredential = await reconsentHandler.handleRefreshFailure(providerId, connectionId);
    }

    expect(secondRefreshError).toBeInstanceOf(Error);
    expect(secondRefreshError?.message).toContain("Configured refresh failure threshold reached");
    expect(oauthServer!.refreshRequestCount).toBe(2);
    expect(reconsentRequests).toEqual([
      {
        providerId,
        connectionId,
        reason: "refresh_failed",
      },
    ]);

    if (!reconsentedCredential) {
      throw new Error("Expected re-consent to return a replacement credential");
    }

    expect(reconsentedCredential).toMatchObject({
      providerId,
      connectionId,
      accessToken: "reconsented-access-token",
      refreshToken: "reconsented-refresh-token",
      scopes: ["profile:read"],
    });
    expect(reconsentedCredential.expiresAt).toBeGreaterThan(Date.now());

    if (!provider) {
      throw new Error("Expected mock provider to be initialized");
    }

    const meResponse = await fetch(`${provider.baseUrl}/v1/me`, {
      headers: {
        authorization: `Bearer ${reconsentedCredential.accessToken}`,
      },
    });

    expect(meResponse.status).toBe(200);
    await expect(meResponse.json()).resolves.toEqual({ ok: true });
    expect(provider.requests).toHaveLength(1);

    const recordedRequest = provider.requests[0];
    if (!recordedRequest) {
      throw new Error("Expected the mock provider to record the /v1/me request");
    }

    expect(recordedRequest.path).toBe("/v1/me");
    expect(recordedRequest.headers["authorization"]).toBe(
      `Bearer ${reconsentedCredential.accessToken}`,
    );
  });
});
