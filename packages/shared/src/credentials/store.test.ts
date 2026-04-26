import { mkdtemp, chmod, readFile, readdir, rm, stat, mkdir, writeFile } from "node:fs/promises";
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

    expect(credentialStats.mode & 0o777).toBe(0o600);
    expect(providerFiles).toEqual([`${credential.connectionId}.json`]);

    // Audit finding #10: on-disk JSON is now an encrypted envelope, never
    // plaintext credentials. Verify the wire format is the envelope shape
    // and the round-trip via load() returns the original Credential.
    const onDisk = JSON.parse(await readFile(credentialPath, "utf8")) as { v: string; ct: string };
    expect(typeof onDisk.v).toBe("string");
    expect(typeof onDisk.ct).toBe("string");
    expect(onDisk.v).toMatch(/^v1-/);
    // The plaintext access token must NOT appear in the on-disk file.
    const fileBytes = await readFile(credentialPath, "utf8");
    expect(fileBytes).not.toContain(updatedCredential.accessToken);
    if (updatedCredential.refreshToken) {
      expect(fileBytes).not.toContain(updatedCredential.refreshToken);
    }

    await expect(store.load(updatedCredential.providerId, updatedCredential.connectionId)).resolves.toEqual(
      updatedCredential,
    );
  });

  it("rejects providerId / connectionId that do not match the strict identifier regex", async () => {
    const bad = makeCredential({ providerId: "../etc" });
    await expect(store.save(bad)).rejects.toThrow(/Invalid providerId/);

    const bad2 = makeCredential({ connectionId: "a/b" });
    await expect(store.save(bad2)).rejects.toThrow(/Invalid connectionId/);

    await expect(store.load("../etc", "primary")).rejects.toThrow(/Invalid providerId/);
    await expect(store.load("github", "a/b")).rejects.toThrow(/Invalid connectionId/);
  });

  it("accepts real-world provider hostnames and email-shaped connection ids", async () => {
    const credential = makeCredential({
      providerId: "mcp.example.com",
      connectionId: "dev+oauth@example.com",
    });

    await store.save(credential);

    await expect(store.load(credential.providerId, credential.connectionId)).resolves.toEqual(credential);
  });

  it("ignores legacy plaintext credential files", async () => {
    const credential = makeCredential();
    const providerDir = path.join(tempDir, credential.providerId);
    const credentialPath = path.join(providerDir, `${credential.connectionId}.json`);
    await mkdir(providerDir, { recursive: true });
    await writeFile(credentialPath, JSON.stringify(credential), { mode: 0o600 });

    await expect(store.load(credential.providerId, credential.connectionId)).resolves.toBeNull();
    await expect(store.list(credential.providerId)).resolves.toEqual([]);

    const onDisk = JSON.parse(await readFile(credentialPath, "utf8")) as Credential;
    expect(onDisk.accessToken).toBe(credential.accessToken);
  });

  it("ignores encrypted credential files that cannot be authenticated", async () => {
    const credential = makeCredential();
    const providerDir = path.join(tempDir, credential.providerId);
    const credentialPath = path.join(providerDir, `${credential.connectionId}.json`);
    await mkdir(providerDir, { recursive: true });
    await writeFile(credentialPath, JSON.stringify({ v: "v1-aesgcm", ct: Buffer.alloc(64).toString("base64") }), { mode: 0o600 });

    await expect(store.load(credential.providerId, credential.connectionId)).resolves.toBeNull();
    await expect(store.list(credential.providerId)).resolves.toEqual([]);
  });
});
