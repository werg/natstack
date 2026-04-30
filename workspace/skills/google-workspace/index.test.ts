import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredCredentialSummary } from "@workspace/runtime";

const runtimeMock = vi.hoisted(() => ({
  credentials: {
    beginCreateWithOAuthPkce: vi.fn(),
    completeCreateWithOAuthPkce: vi.fn(),
    listStoredCredentials: vi.fn(),
    revokeCredential: vi.fn(),
    fetch: vi.fn(),
  },
  oauth: {
    createLoopbackCallback: vi.fn(),
  },
  openExternal: vi.fn(),
  workspace: {
    getConfig: vi.fn(),
  },
}));

vi.mock("@workspace/runtime", () => runtimeMock);

import {
  beginGoogleCredentialCreation,
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
    runtimeMock.workspace.getConfig.mockResolvedValue({ id: "test" });
    runtimeMock.credentials.listStoredCredentials.mockResolvedValue([]);
    runtimeMock.credentials.beginCreateWithOAuthPkce.mockResolvedValue({
      nonce: "nonce-1",
      state: "nonce-1",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=client-1",
    });
    runtimeMock.credentials.completeCreateWithOAuthPkce.mockResolvedValue(googleCredential);
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

  it("reports ready-to-connect when a Google OAuth client is configured", async () => {
    runtimeMock.workspace.getConfig.mockResolvedValue({
      id: "test",
      credentials: {
        providers: {
          "google-workspace": { clientId: "client-1" },
        },
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

  it("uses host-brokered PKCE with Google scopes and URL-bound audiences", async () => {
    await beginGoogleCredentialCreation({
      clientId: "client-1",
      redirectUri: "http://127.0.0.1:12345/oauth/callback",
    });

    expect(runtimeMock.credentials.beginCreateWithOAuthPkce).toHaveBeenCalledWith(
      expect.objectContaining({
        oauth: expect.objectContaining({
          clientId: "client-1",
          scopes: expect.arrayContaining([
            "https://www.googleapis.com/auth/gmail.modify",
            "https://www.googleapis.com/auth/calendar",
            "https://www.googleapis.com/auth/drive.file",
            "https://www.googleapis.com/auth/userinfo.email",
          ]),
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
  });

  it("connectGoogle returns a setup error instead of starting OAuth without a client id", async () => {
    const result = await connectGoogle();

    expect(result.success).toBe(false);
    expect(result.error).toContain("client_id is not configured");
    expect(runtimeMock.oauth.createLoopbackCallback).not.toHaveBeenCalled();
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
