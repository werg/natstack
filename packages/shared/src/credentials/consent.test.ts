import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsentGrantStore } from "./consent.js";
import type { DatabaseHandle } from "./consent.js";

const GITHUB_FINGERPRINT = "github-audience";
const SLACK_FINGERPRINT = "slack-audience";

class BetterSqliteHandle implements DatabaseHandle {
  constructor(private readonly db: Database.Database) {}

  run(sql: string, params: readonly unknown[] = []): void {
    this.db.prepare(sql).run(...params);
  }

  all<T>(sql: string, params: readonly unknown[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }
}

describe("ConsentGrantStore", () => {
  let db: Database.Database;
  let store: ConsentGrantStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new ConsentGrantStore(new BetterSqliteHandle(db));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it("grants consent and lists repo grants", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    await store.grant({
      codeIdentity: "repo-1",
      codeIdentityType: "repo",
      providerId: "github",
      providerFingerprint: GITHUB_FINGERPRINT,
      connectionId: "primary",
      scopes: ["repo", "user:email"],
      grantedAt: 0,
      grantedBy: "panel-1",
    });

    await expect(store.list("repo-1")).resolves.toEqual([
      {
        codeIdentity: "repo-1",
        codeIdentityType: "repo",
        providerId: "github",
        providerFingerprint: GITHUB_FINGERPRINT,
        connectionId: "primary",
        scopes: ["repo", "user:email"],
        grantedAt: 1_700_000_000_000,
        grantedBy: "panel-1",
      },
    ]);
  });

  it("upserts an existing grant", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValueOnce(1_700_000_000_000);
    await store.grant({
      codeIdentity: "repo-1",
      codeIdentityType: "repo",
      providerId: "github",
      providerFingerprint: GITHUB_FINGERPRINT,
      connectionId: "primary",
      scopes: ["repo"],
      grantedAt: 0,
      grantedBy: "panel-1",
    });

    nowSpy.mockReturnValueOnce(1_700_000_000_500);
    await store.grant({
      codeIdentity: "repo-1",
      codeIdentityType: "repo",
      providerId: "github",
      providerFingerprint: GITHUB_FINGERPRINT,
      connectionId: "primary",
      scopes: ["repo", "user:email"],
      grantedAt: 0,
      grantedBy: "panel-2",
    });

    await expect(store.list("repo-1")).resolves.toEqual([
      {
        codeIdentity: "repo-1",
        codeIdentityType: "repo",
        providerId: "github",
        providerFingerprint: GITHUB_FINGERPRINT,
        connectionId: "primary",
        scopes: ["repo", "user:email"],
        grantedAt: 1_700_000_000_500,
        grantedBy: "panel-2",
      },
    ]);
  });

  it("revokes provider grants for a code identity", async () => {
    await store.grant({
      codeIdentity: "repo-1",
      codeIdentityType: "repo",
      providerId: "github",
      providerFingerprint: GITHUB_FINGERPRINT,
      connectionId: "primary",
      scopes: ["repo"],
      grantedAt: 0,
      grantedBy: "panel-1",
    });
    await store.grant({
      codeIdentity: "repo-1",
      codeIdentityType: "repo",
      providerId: "slack",
      providerFingerprint: SLACK_FINGERPRINT,
      connectionId: "workspace",
      scopes: ["channels:read"],
      grantedAt: 0,
      grantedBy: "panel-1",
    });

    await store.revoke("repo-1", "github");
    await expect(store.list("repo-1")).resolves.toEqual([
      {
        codeIdentity: "repo-1",
        codeIdentityType: "repo",
        providerId: "slack",
        providerFingerprint: SLACK_FINGERPRINT,
        connectionId: "workspace",
        scopes: ["channels:read"],
        grantedAt: expect.any(Number),
        grantedBy: "panel-1",
      },
    ]);
  });

  it("checks repo and version grants for a provider", async () => {
    await store.grant({
      codeIdentity: "hash-1",
      codeIdentityType: "hash",
      providerId: "github",
      providerFingerprint: GITHUB_FINGERPRINT,
      connectionId: "versioned",
      scopes: ["user:email", "repo", "repo"],
      grantedAt: 0,
      grantedBy: "panel-1",
    });

    await expect(store.check({
      repoPath: "repo-1",
      effectiveVersion: "hash-1",
      providerId: "github",
      providerFingerprint: GITHUB_FINGERPRINT,
    })).resolves.toEqual({
      codeIdentity: "hash-1",
      codeIdentityType: "hash",
      providerId: "github",
      providerFingerprint: GITHUB_FINGERPRINT,
      connectionId: "versioned",
      scopes: ["repo", "user:email"],
      grantedAt: expect.any(Number),
      grantedBy: "panel-1",
    });

    await store.grant({
      codeIdentity: "repo-1",
      codeIdentityType: "repo",
      providerId: "github",
      providerFingerprint: GITHUB_FINGERPRINT,
      connectionId: "repo-default",
      scopes: ["repo"],
      grantedAt: 0,
      grantedBy: "panel-2",
    });

    await expect(store.check({
      repoPath: "repo-1",
      effectiveVersion: "hash-1",
      providerId: "github",
      providerFingerprint: GITHUB_FINGERPRINT,
    })).resolves.toEqual({
      codeIdentity: "repo-1",
      codeIdentityType: "repo",
      providerId: "github",
      providerFingerprint: GITHUB_FINGERPRINT,
      connectionId: "repo-default",
      scopes: ["repo"],
      grantedAt: expect.any(Number),
      grantedBy: "panel-2",
    });
  });

  it("supports transient grants", async () => {
    await store.grant({
      codeIdentity: "hash-1",
      codeIdentityType: "hash",
      providerId: "slack",
      providerFingerprint: SLACK_FINGERPRINT,
      connectionId: "transient",
      scopes: ["channels:read"],
      grantedAt: 0,
      grantedBy: "panel-1",
      transient: true,
    });

    await expect(store.check({
      repoPath: "repo-1",
      effectiveVersion: "hash-1",
      providerId: "slack",
      providerFingerprint: SLACK_FINGERPRINT,
    })).resolves.toEqual({
      codeIdentity: "hash-1",
      codeIdentityType: "hash",
      providerId: "slack",
      providerFingerprint: SLACK_FINGERPRINT,
      connectionId: "transient",
      scopes: ["channels:read"],
      grantedAt: expect.any(Number),
      grantedBy: "panel-1",
      transient: true,
    });
  });

  it("requires matching provider fingerprint when supplied", async () => {
    await store.grant({
      codeIdentity: "repo-1",
      codeIdentityType: "repo",
      providerId: "github",
      providerFingerprint: "audience-a",
      providerAudience: ["https://api.github.com/"],
      connectionId: "primary",
      scopes: ["repo"],
      grantedAt: 0,
      grantedBy: "panel-1",
    });

    await expect(store.check({
      repoPath: "repo-1",
      effectiveVersion: "hash-1",
      providerId: "github",
      providerFingerprint: "audience-b",
    })).resolves.toBeNull();

    await expect(store.check({
      repoPath: "repo-1",
      effectiveVersion: "hash-1",
      providerId: "github",
      providerFingerprint: "audience-a",
    })).resolves.toMatchObject({
      providerId: "github",
      providerFingerprint: "audience-a",
      providerAudience: ["https://api.github.com/"],
      connectionId: "primary",
    });
  });
});
