import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { parseCanonicalKey } from "@natstack/shared/canonicalKey";
import { UserlandApprovalGrantStore, keyFor } from "./userlandApprovalGrantStore.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-userland-grants-"));
}

const workerAlpha = {
  callerId: "worker:alpha",
  callerKind: "worker" as const,
  repoPath: "workers/alpha",
  effectiveVersion: "hash-1",
};

const appShell = {
  callerId: "app:apps/shell:device-1",
  callerKind: "app" as const,
  repoPath: "apps/shell",
  effectiveVersion: "app-hash-1",
};

describe("UserlandApprovalGrantStore", () => {
  it("records, looks up, lists, and revokes grants", async () => {
    const store = new UserlandApprovalGrantStore({ statePath: tempDir() });
    await store.record(workerAlpha, { id: "team-x:foo", label: "Foo" }, "allow", 10);

    expect(store.lookup(workerAlpha, "team-x:foo")).toMatchObject({ choice: "allow" });
    expect(store.list(workerAlpha)).toHaveLength(1);
    await expect(store.revoke(workerAlpha, "team-x:foo")).resolves.toBe(true);
    await expect(store.revoke(workerAlpha, "team-x:foo")).resolves.toBe(false);
    expect(store.lookup(workerAlpha, "team-x:foo")).toBeNull();
  });

  it("persists caller-scoped grants across store instances", async () => {
    const statePath = tempDir();
    const store = new UserlandApprovalGrantStore({ statePath });
    const panelOne = {
      callerId: "panel-one",
      callerKind: "panel" as const,
      repoPath: "panels/one",
      effectiveVersion: "hash-1",
    };
    await store.record(panelOne, { id: "subject-1" }, "yes", 20);

    const restarted = new UserlandApprovalGrantStore({ statePath });
    expect(restarted.lookup(panelOne, "subject-1")).toMatchObject({ choice: "yes" });

    const raw = JSON.parse(
      fs.readFileSync(path.join(statePath, "userland-approval-grants.json"), "utf8")
    );
    expect(raw.grants[0].principal).toMatchObject({
      callerId: "panel-one",
      repoPath: "panels/one",
      effectiveVersion: "hash-1",
    });
  });

  it("persists app-scoped grants and app issuers", async () => {
    const statePath = tempDir();
    const store = new UserlandApprovalGrantStore({ statePath });
    await store.record(
      appShell,
      { id: "native:notifications", label: "Notifications" },
      "allow",
      20,
      { kind: "app", id: appShell.repoPath, label: "Shell app" }
    );

    const restarted = new UserlandApprovalGrantStore({ statePath });
    expect(
      restarted.lookup(appShell, "native:notifications", {
        kind: "app",
        id: appShell.repoPath,
        label: "Shell app",
      })
    ).toMatchObject({
      choice: "allow",
      principal: {
        callerKind: "app",
        repoPath: appShell.repoPath,
        effectiveVersion: appShell.effectiveVersion,
      },
      issuer: {
        kind: "app",
        id: appShell.repoPath,
      },
    });
  });

  it("matches version-scoped grants by source version instead of caller id", async () => {
    const store = new UserlandApprovalGrantStore({ statePath: tempDir() });
    await store.record(workerAlpha, { id: "team-x:foo" }, "allow", 10, undefined, "version");

    expect(
      store.lookup(
        {
          ...workerAlpha,
          callerId: "worker:beta",
        },
        "team-x:foo"
      )
    ).toMatchObject({ choice: "allow", scope: "version" });
  });

  it("keeps session-scoped grants in memory", async () => {
    const statePath = tempDir();
    const store = new UserlandApprovalGrantStore({ statePath });
    await store.record(workerAlpha, { id: "team-x:foo" }, "allow", 10, undefined, "session");
    expect(store.lookup(workerAlpha, "team-x:foo")).toMatchObject({ scope: "session" });

    const restarted = new UserlandApprovalGrantStore({ statePath });
    expect(restarted.lookup(workerAlpha, "team-x:foo")).toBeNull();
  });

  it("uses the documented flat key shape", () => {
    expect(
      parseCanonicalKey(keyFor(workerAlpha, { kind: "worker", id: "worker:alpha" }, "team-x:foo"))
    ).toEqual([
      "userland-grant",
      "caller",
      "worker:alpha",
      "",
      "worker",
      "worker:alpha",
      "team-x:foo",
    ]);
  });

  it("tolerates malformed files by starting empty and warning", () => {
    const statePath = tempDir();
    fs.writeFileSync(path.join(statePath, "userland-approval-grants.json"), "{nope", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new UserlandApprovalGrantStore({ statePath });

    expect(store.list(workerAlpha)).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
