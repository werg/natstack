import { mkdtemp, chmod, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialStore } from "./store.js";
import type { Credential } from "./types.js";

function makeCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    providerId: "github",
    connectionId: "primary",
    connectionLabel: "Primary GitHub",
    accountIdentity: {
      email: "dev@example.com",
      username: "octocat",
      workspaceName: "natstack",
      providerUserId: "user-123",
    },
    accessToken: "access-token",
    refreshToken: "refresh-token",
    scopes: ["repo", "user:email"],
    expiresAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("CredentialStore", () => {
  let tempDir: string;
  let store: CredentialStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "natstack-credentials-store-"));
    store = new CredentialStore({ basePath: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("saves and loads a credential", async () => {
    const credential = makeCredential();

    await store.save(credential);

    await expect(store.load(credential.providerId, credential.connectionId)).resolves.toEqual(credential);
  });

  it("lists credentials across providers or for a single provider", async () => {
    const githubCredential = makeCredential();
    const slackCredential = makeCredential({
      providerId: "slack",
      connectionId: "workspace",
      connectionLabel: "Slack Workspace",
      scopes: ["channels:read"],
    });

    await store.save(githubCredential);
    await store.save(slackCredential);

    await expect(store.list()).resolves.toEqual([githubCredential, slackCredential]);
    await expect(store.list("github")).resolves.toEqual([githubCredential]);
  });

  it("removes a credential and returns null when it no longer exists", async () => {
    const credential = makeCredential();

    await store.save(credential);
    await store.remove(credential.providerId, credential.connectionId);

    await expect(store.load(credential.providerId, credential.connectionId)).resolves.toBeNull();
    await expect(store.list()).resolves.toEqual([]);
  });

  it("writes through a temp file and leaves the credential file at 0o600", async () => {
    const credential = makeCredential();
    const updatedCredential = makeCredential({ connectionLabel: "Updated Label" });
    const credentialPath = path.join(tempDir, credential.providerId, `${credential.connectionId}.json`);

    await store.save(credential);
    await chmod(credentialPath, 0o644);
    await store.save(updatedCredential);

    const credentialStats = await stat(credentialPath);
    const providerFiles = await readdir(path.join(tempDir, credential.providerId));
    const serializedCredential = JSON.parse(await readFile(credentialPath, "utf8")) as Credential;

    expect(credentialStats.mode & 0o777).toBe(0o600);
    expect(providerFiles).toEqual([`${credential.connectionId}.json`]);
    expect(serializedCredential).toEqual(updatedCredential);
  });
});
