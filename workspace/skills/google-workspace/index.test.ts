import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredCredentialSummary } from "@workspace/runtime";

const runtimeMock = vi.hoisted(() => ({
  credentials: {
    beginCreateWithOAuthPkce: vi.fn(),
    beginCreateWithOAuthClientPkce: vi.fn(),
    completeCreateWithOAuthPkce: vi.fn(),
    connectWithOAuthClientPkce: vi.fn(),
    requestOAuthClientConfig: vi.fn(),
    getOAuthClientConfigStatus: vi.fn(),
    listStoredCredentials: vi.fn(),
    revokeCredential: vi.fn(),
    fetch: vi.fn(),
  },
  oauth: {
    createLoopbackCallback: vi.fn(),
  },
  openExternal: vi.fn(),
}));

vi.mock("@workspace/runtime", () => runtimeMock);

import {
  beginGoogleCredentialCreation,
  configureGoogleOAuthClient,
  connectGoogle,
  getGoogleOnboardingStatus,
  verifyGoogleCredential,
} from "./index.js";

const googleCredential: StoredCredentialSummary = {
  id: "cred-google",
  label: "Google Workspace",
  accountIdentity: {
    email: "user@example.com",
    providerUserId: "user-1",
  },
  audience: [
    { url: "https://gmail.googleapis.com/", match: "origin" },
    { url: "https://www.googleapis.com/", match: "origin" },
  ],
  injection: {
    type: "header",
    name: "authorization",
    valueTemplate: "Bearer {token}",
  },
  scopes: [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
  ],
  metadata: {
    providerId: "google-workspace",
  },
};

describe("google-workspace skill facade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMock.credentials.listStoredCredentials.mockResolvedValue([]);
    runtimeMock.credentials.getOAuthClientConfigStatus.mockResolvedValue({
      configId: "google-workspace",
      configured: false,
      fields: {
        clientId: { configured: false, type: "text" },
        clientSecret: { configured: false, type: "secret" },
      },
    });
    runtimeMock.credentials.requestOAuthClientConfig.mockResolvedValue({
      configId: "google-workspace",
      configured: true,
      fields: {
        clientId: { configured: true, type: "text" },
        clientSecret: { configured: true, type: "secret" },
      },
    });
    runtimeMock.credentials.beginCreateWithOAuthClientPkce.mockResolvedValue({
      nonce: "nonce-1",
      state: "nonce-1",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=client-1",
    });
    runtimeMock.credentials.completeCreateWithOAuthPkce.mockResolvedValue(googleCredential);
    runtimeMock.credentials.connectWithOAuthClientPkce.mockResolvedValue(googleCredential);
    runtimeMock.credentials.fetch.mockResolvedValue(
      new Response(JSON.stringify({ email: "user@example.com" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    runtimeMock.oauth.createLoopbackCallback.mockResolvedValue({
      redirectUri: "http://127.0.0.1:12345/oauth/callback",
      waitForCallback: vi.fn().mockResolvedValue({
        code: "code-1",
        state: "nonce-1",
        url: "http://127.0.0.1:12345/oauth/callback?code=code-1&state=nonce-1",
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("reports needs-setup when no OAuth client or Google credential exists", async () => {
    const status = await getGoogleOnboardingStatus();

    expect(status.stage).toBe("needs-setup");
    expect(status.configured).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.nextActions.join(" ")).toContain("SETUP.md");
  });

  it("reports needs-setup when only a Google OAuth client id is configured", async () => {
    runtimeMock.credentials.getOAuthClientConfigStatus.mockResolvedValue({
      configId: "google-workspace",
      configured: false,
      fields: {
        clientId: { configured: true, type: "text" },
        clientSecret: { configured: false, type: "secret" },
      },
    });

    const status = await getGoogleOnboardingStatus();

    expect(status.stage).toBe("needs-setup");
    expect(status.configured).toBe(false);
    expect(status.readyToConnect).toBe(false);
  });

  it("reports ready-to-connect when Google OAuth client id and secret are configured", async () => {
    runtimeMock.credentials.getOAuthClientConfigStatus.mockResolvedValue({
      configId: "google-workspace",
      configured: true,
      fields: {
        clientId: { configured: true, type: "text" },
        clientSecret: { configured: true, type: "secret" },
      },
    });

    const status = await getGoogleOnboardingStatus();

    expect(status.stage).toBe("ready-to-connect");
    expect(status.configured).toBe(true);
    expect(status.readyToConnect).toBe(true);
  });

  it("reports connected when a stored Google credential exists", async () => {
    runtimeMock.credentials.listStoredCredentials.mockResolvedValue([googleCredential]);

    const status = await getGoogleOnboardingStatus();

    expect(status.stage).toBe("connected");
    expect(status.connected).toBe(true);
    expect(status.connectionId).toBe("cred-google");
    expect(status.email).toBe("user@example.com");
  });

  it("reports verified after a live Google userinfo check succeeds", async () => {
    runtimeMock.credentials.listStoredCredentials.mockResolvedValue([googleCredential]);

    const status = await getGoogleOnboardingStatus({ verify: true });

    expect(status.stage).toBe("verified");
    expect(status.verification).toMatchObject({
      valid: true,
      credentialId: "cred-google",
      email: "user@example.com",
    });
  });

  it("normalizes unavailable credential RPC failures into structured onboarding errors", async () => {
    runtimeMock.credentials.listStoredCredentials.mockImplementation(async () => {
      const rpc = undefined as unknown as { call(): unknown };
      return rpc.call();
    });

    const status = await getGoogleOnboardingStatus();

    expect(status.stage).toBe("error");
    expect(status.error).toContain("NatStack credential runtime is unavailable");
    expect(status.error).toContain("Original error");
  });

  it("requests Google OAuth client material through privileged OAuth client config UI", async () => {
    await configureGoogleOAuthClient();

    expect(runtimeMock.credentials.requestOAuthClientConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        configId: "google-workspace",
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        fields: expect.arrayContaining([
          expect.objectContaining({ name: "clientId", type: "text", required: true }),
          expect.objectContaining({ name: "clientSecret", type: "secret", required: true }),
        ]),
      })
    );
  });

  it("uses host-brokered OAuth client config PKCE with Google scopes and URL-bound audiences", async () => {
    await beginGoogleCredentialCreation({
      redirectUri: "http://127.0.0.1:12345/oauth/callback",
    });

    expect(runtimeMock.credentials.beginCreateWithOAuthClientPkce).toHaveBeenCalledWith(
      expect.objectContaining({
        oauth: expect.objectContaining({
          configId: "google-workspace",
          scopes: expect.arrayContaining([
            "https://www.googleapis.com/auth/gmail.modify",
            "https://www.googleapis.com/auth/calendar",
            "https://www.googleapis.com/auth/drive.file",
            "https://www.googleapis.com/auth/userinfo.email",
          ]),
          extraAuthorizeParams: {
            access_type: "offline",
            prompt: "consent",
          },
        }),
        credential: expect.objectContaining({
          metadata: { providerId: "google-workspace" },
          audience: expect.arrayContaining([
            { url: "https://gmail.googleapis.com/", match: "origin" },
            { url: "https://www.googleapis.com/", match: "origin" },
          ]),
        }),
      })
    );
    expect(runtimeMock.credentials.beginCreateWithOAuthPkce).not.toHaveBeenCalled();
  });

  it("connectGoogle returns a setup error instead of starting OAuth without OAuth client config", async () => {
    const result = await connectGoogle();

    expect(result.success).toBe(false);
    expect(result.error).toContain("client material is not configured");
    expect(runtimeMock.credentials.connectWithOAuthClientPkce).not.toHaveBeenCalled();
  });

  it("connectGoogle uses stored OAuth client config without exposing client secret to userland", async () => {
    runtimeMock.credentials.getOAuthClientConfigStatus.mockResolvedValue({
      configId: "google-workspace",
      configured: true,
      fields: {
        clientId: { configured: true, type: "text" },
        clientSecret: { configured: true, type: "secret" },
      },
    });

    const result = await connectGoogle();

    expect(result.success).toBe(true);
    expect(runtimeMock.credentials.connectWithOAuthClientPkce).toHaveBeenCalledWith(
      expect.objectContaining({
        oauth: expect.objectContaining({ configId: "google-workspace" }),
      })
    );
  });

  it("verifyGoogleCredential returns scopes from the stored credential", async () => {
    runtimeMock.credentials.listStoredCredentials.mockResolvedValue([googleCredential]);

    const result = await verifyGoogleCredential("cred-google");

    expect(result).toMatchObject({
      valid: true,
      credentialId: "cred-google",
      email: "user@example.com",
      scopes: googleCredential.scopes,
    });
  });
});
