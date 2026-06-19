import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialUseGrantStore } from "./credentialUseGrantStore.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-credential-use-grants-"));
}

describe("CredentialUseGrantStore", () => {
  it("persists grants through the atomic JSON writer", () => {
    const statePath = tempDir();
    const grant = {
      bindingId: "binding_fetch",
      use: "fetch" as const,
      resource: "https://api.example.test/",
      action: "use" as const,
      scope: "version" as const,
      callerId: "worker:agent",
      repoPath: "workers/agent.ts",
      effectiveVersion: "ev-1",
      grantedAt: 123,
      grantedBy: "user",
    };

    const store = new CredentialUseGrantStore({ statePath });
    store.upsert("cred_1", grant);

    const filePath = path.join(statePath, "credential-use-grants.json");
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
      grants: [{ credentialId: "cred_1", ...grant }],
    });
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);

    const reloaded = new CredentialUseGrantStore({ statePath });
    expect(reloaded.list("cred_1")).toEqual([grant]);
    expect(reloaded.list("cred_2")).toEqual([]);
  });
});
