import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredCredentialSummary } from "@workspace/runtime";

const runtimeMock = vi.hoisted(() => ({
  credentials: {
    requestCredentialInput: vi.fn(),
    listStoredCredentials: vi.fn(),
    revokeCredential: vi.fn(),
    gitHttp: vi.fn(),
  },
  createBrowserPanel: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock("@workspace/runtime", () => runtimeMock);

import {
  buildGitHubTokenSettingsUrl,
  getGitHubOnboardingStatus,
  openGitHubTokenSettings,
  requestGitHubTokenCredential,
  verifyGitHubCredential,
  verifyGitHubGitRemoteAccess,
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ login: "octocat", id: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ));
    runtimeMock.credentials.gitHttp.mockReturnValue({
      request: vi.fn().mockResolvedValue({
        url: "https://github.com/octo/project.git/info/refs?service=git-upload-pack",
        method: "GET",
        statusCode: 200,
        statusMessage: "OK",
        headers: {},
        body: (async function* () {})(),
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("stores read-only access as API plus clone/pull capable git transport", async () => {
    await requestGitHubTokenCredential({ accessLevel: "read-only" });

    expect(runtimeMock.credentials.requestCredentialInput).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: expect.objectContaining({
          scopes: expect.arrayContaining(["metadata:read", "contents:read", "issues:read", "pull_requests:read", "actions:read"]),
          metadata: expect.objectContaining({
            accessLevel: "read-only",
            credentialMode: "api-and-git",
            gitRemoteOrigin: "https://github.com/",
          }),
          bindings: expect.arrayContaining([
            expect.objectContaining({ use: "fetch" }),
            expect.objectContaining({ id: "github-git", use: "git-http" }),
          ]),
        }),
      })
    );
  });

  it("can label broad classic PATs separately from fine-grained PATs", async () => {
    await requestGitHubTokenCredential({ accessLevel: "broad", tokenKind: "classic" });

    expect(runtimeMock.credentials.requestCredentialInput).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Save a GitHub classic personal access token for broad GitHub access.",
        credential: expect.objectContaining({
          metadata: expect.objectContaining({ accessLevel: "broad", providerKind: "classic-pat" }),
        }),
      })
    );
  });

  it("builds a prefilled fine-grained token URL from access level", () => {
    const url = new URL(buildGitHubTokenSettingsUrl({
      accessLevel: "code-workflows",
      expiresIn: 30,
      targetName: "octo-org",
    }));

    expect(url.origin + url.pathname).toBe("https://github.com/settings/personal-access-tokens/new");
    expect(url.searchParams.get("name")).toBe("NatStack");
    expect(url.searchParams.get("target_name")).toBe("octo-org");
    expect(url.searchParams.get("expires_in")).toBe("30");
    expect(url.searchParams.get("contents")).toBe("write");
    expect(url.searchParams.get("pull_requests")).toBe("write");
    expect(url.searchParams.get("workflows")).toBe("write");
  });

  it("reports verified after a live user check succeeds", async () => {
    runtimeMock.credentials.listStoredCredentials.mockResolvedValue([githubCredential]);

    const status = await getGitHubOnboardingStatus({ verify: true });

    expect(status.stage).toBe("verified");
    expect(status.login).toBe("octocat");
    expect(status.verification).toMatchObject({ valid: true, credentialId: "cred-github" });
  });

  it("verifies a credential through egress fetch", async () => {
    const result = await verifyGitHubCredential("cred-github");

    expect(result).toMatchObject({ valid: true, login: "octocat", userId: 1 });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "X-NatStack-Use-Credential": "cred-github",
        }),
      })
    );
  });

  it("verifies GitHub git remote read access through credentials.gitHttp", async () => {
    const gitHttp = {
      request: vi.fn().mockResolvedValue({
        url: "https://github.com/octo/project.git/info/refs?service=git-upload-pack",
        method: "GET",
        statusCode: 200,
        statusMessage: "OK",
        headers: {},
        body: (async function* () {})(),
      }),
    };
    runtimeMock.credentials.gitHttp.mockReturnValue(gitHttp);

    const result = await verifyGitHubGitRemoteAccess("https://github.com/octo/project.git", "cred-github");

    expect(result).toMatchObject({
      accessible: true,
      credentialId: "cred-github",
      remoteUrl: "https://github.com/octo/project.git",
      action: "read",
      statusCode: 200,
    });
    expect(runtimeMock.credentials.gitHttp).toHaveBeenCalledWith({ credentialId: "cred-github" });
    expect(gitHttp.request).toHaveBeenCalledWith({
      url: "https://github.com/octo/project.git/info/refs?service=git-upload-pack",
      method: "GET",
      headers: expect.objectContaining({
        accept: "*/*",
        "git-protocol": "version=2",
      }),
    });
  });

  it("rejects non-GitHub git verification URLs", async () => {
    await expect(
      verifyGitHubGitRemoteAccess("https://example.com/octo/project.git", "cred-github")
    ).rejects.toThrow("https://github.com");
  });

  it("opens the fine-grained token page externally", async () => {
    await openGitHubTokenSettings();

    const opened = new URL(runtimeMock.openExternal.mock.calls[0]![0]);
    expect(opened.origin + opened.pathname).toBe("https://github.com/settings/personal-access-tokens/new");
    expect(opened.searchParams.get("contents")).toBe("write");
  });

  it("can open the fine-grained token page internally", async () => {
    await openGitHubTokenSettings({ browser: "internal" });

    const [opened, options] = runtimeMock.createBrowserPanel.mock.calls[0]!;
    expect(new URL(opened).origin + new URL(opened).pathname).toBe("https://github.com/settings/personal-access-tokens/new");
    expect(options).toEqual({ focus: true, name: "GitHub settings" });
    expect(runtimeMock.openExternal).not.toHaveBeenCalled();
  });

  it("can open the classic token page externally", async () => {
    await openGitHubTokenSettings({ tokenKind: "classic", browser: "external" });

    expect(runtimeMock.openExternal).toHaveBeenCalledWith(
      "https://github.com/settings/tokens/new"
    );
  });
});
