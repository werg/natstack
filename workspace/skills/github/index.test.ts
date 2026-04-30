import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredCredentialSummary } from "@workspace/runtime";

const runtimeMock = vi.hoisted(() => ({
  credentials: {
    requestCredentialInput: vi.fn(),
    listStoredCredentials: vi.fn(),
    revokeCredential: vi.fn(),
    fetch: vi.fn(),
  },
  openExternal: vi.fn(),
}));

vi.mock("@workspace/runtime", () => runtimeMock);

import {
  getGitHubOnboardingStatus,
  openGitHubTokenSettings,
  requestGitHubTokenCredential,
  verifyGitHubCredential,
} from "./index.js";

const githubCredential: StoredCredentialSummary = {
  id: "cred-github",
  label: "GitHub",
  accountIdentity: { providerUserId: "github-pat", username: "octocat" },
  audience: [
    { url: "https://api.github.com/", match: "origin" },
  ],
  injection: {
    type: "header",
    name: "authorization",
    valueTemplate: "Bearer {token}",
  },
  scopes: ["metadata:read", "contents:read"],
  metadata: { providerId: "github" },
};

describe("github skill facade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMock.credentials.listStoredCredentials.mockResolvedValue([]);
    runtimeMock.credentials.requestCredentialInput.mockResolvedValue(githubCredential);
    runtimeMock.credentials.fetch.mockResolvedValue(
      new Response(JSON.stringify({ login: "octocat", id: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  });

  it("reports needs-token when no GitHub credential exists", async () => {
    const status = await getGitHubOnboardingStatus();

    expect(status.stage).toBe("needs-token");
    expect(status.connected).toBe(false);
    expect(status.nextActions.join(" ")).toContain("requestGitHubTokenCredential");
  });

  it("requests API PAT material through privileged credential input UI", async () => {
    await requestGitHubTokenCredential({ mode: "api", presets: ["contents-read", "contents-write"] });

    expect(runtimeMock.credentials.requestCredentialInput).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Add GitHub",
        credential: expect.objectContaining({
          label: "GitHub",
          metadata: expect.objectContaining({ providerId: "github", credentialMode: "api" }),
          audience: expect.arrayContaining([
            { url: "https://api.github.com/", match: "origin" },
          ]),
          bindings: [
            expect.objectContaining({ use: "fetch" }),
          ],
          scopes: expect.arrayContaining(["contents:read", "contents:write"]),
        }),
        fields: [expect.objectContaining({ name: "token", type: "secret", required: true })],
        material: { type: "bearer-token", tokenField: "token" },
      })
    );
  });

  it("can request git-capable PAT permissions separately from API-only setup", async () => {
    await requestGitHubTokenCredential({ mode: "git" });

    expect(runtimeMock.credentials.requestCredentialInput).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: expect.objectContaining({
          scopes: expect.arrayContaining(["metadata:read", "contents:read", "contents:write"]),
          metadata: expect.objectContaining({
            credentialMode: "git",
            permissionPresets: "clone,pull,push",
            gitRemoteOrigin: "https://github.com/",
          }),
          bindings: expect.arrayContaining([
            expect.objectContaining({ use: "fetch" }),
            expect.objectContaining({
              id: "github-git",
              use: "git-http",
              audience: [{ url: "https://github.com/", match: "origin" }],
              injection: {
                type: "basic-auth",
                usernameTemplate: "x-access-token",
                passwordTemplate: "{token}",
              },
            }),
          ]),
        }),
      })
    );
  });

  it("reports verified after a live user check succeeds", async () => {
    runtimeMock.credentials.listStoredCredentials.mockResolvedValue([githubCredential]);

    const status = await getGitHubOnboardingStatus({ verify: true });

    expect(status.stage).toBe("verified");
    expect(status.login).toBe("octocat");
    expect(status.verification).toMatchObject({ valid: true, credentialId: "cred-github" });
  });

  it("verifies a credential through credentials.fetch", async () => {
    const result = await verifyGitHubCredential("cred-github");

    expect(result).toMatchObject({ valid: true, login: "octocat", userId: 1 });
    expect(runtimeMock.credentials.fetch).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({ accept: "application/vnd.github+json" }),
      }),
      { credentialId: "cred-github" }
    );
  });

  it("opens the fine-grained token page externally", async () => {
    await openGitHubTokenSettings();

    expect(runtimeMock.openExternal).toHaveBeenCalledWith(
      "https://github.com/settings/personal-access-tokens/new"
    );
  });
});
