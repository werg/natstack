import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../db/databaseManager.js";
import { createInMemorySecretsStore } from "../secrets/testing.js";
import { OAuthManager } from "./oauthManager.js";

describe("OAuthManager secret rotation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-manager-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("purges cached and persisted oauth tokens when the nango secret changes", async () => {
    const secrets = createInMemorySecretsStore({ nango: "old-secret" });
    const databaseManager = new DatabaseManager(tmpDir);
    const manager = new OAuthManager({
      nangoUrl: "https://api.nango.dev",
      secrets,
      databaseManager,
    });

    try {
      const handle = (manager as any).ensureDb() as string;
      databaseManager.run(
        handle,
        "INSERT INTO oauth_tokens (provider, connection_id, access_token, expires_at, scopes) VALUES (?, ?, ?, ?, ?)",
        ["notion", "conn-1", "token-1", Date.now() + 60_000, "[]"],
      );
      databaseManager.run(
        handle,
        "INSERT INTO oauth_consent (panel_id, provider, scopes, granted_at, workspace_wide) VALUES (?, ?, ?, ?, ?)",
        ["panel-1", "notion", "[]", Date.now(), 0],
      );
      (manager as any).tokenCache.set("notion:conn-1", {
        token: {
          accessToken: "cached-token",
          expiresAt: Date.now() + 60_000,
          scopes: [],
        },
        fetchedAt: Date.now(),
      });

      await secrets.set("nango", "new-secret");

      const tokenCount = databaseManager.get<{ count: number }>(
        handle,
        "SELECT COUNT(*) AS count FROM oauth_tokens",
      );
      const consentCount = databaseManager.get<{ count: number }>(
        handle,
        "SELECT COUNT(*) AS count FROM oauth_consent",
      );

      expect((manager as any).tokenCache.size).toBe(0);
      expect(tokenCount?.count).toBe(0);
      expect(consentCount?.count).toBe(1);
    } finally {
      manager.close();
      databaseManager.shutdown();
      await secrets.close();
    }
  });

  it("handles initial empty-to-set secret changes without leaving stale tokens behind", async () => {
    const secrets = createInMemorySecretsStore();
    const databaseManager = new DatabaseManager(tmpDir);
    const manager = new OAuthManager({
      nangoUrl: "https://api.nango.dev",
      secrets,
      databaseManager,
    });

    try {
      await secrets.set("nango", "first-secret");
      const handle = (manager as any).ensureDb() as string;
      const tokenCount = databaseManager.get<{ count: number }>(
        handle,
        "SELECT COUNT(*) AS count FROM oauth_tokens",
      );
      expect(tokenCount?.count).toBe(0);
    } finally {
      manager.close();
      databaseManager.shutdown();
      await secrets.close();
    }
  });
});
