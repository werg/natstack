import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { parseCanonicalKey } from "@natstack/shared/canonicalKey";
import { UserlandApprovalGrantStore, keyFor } from "./userlandApprovalGrantStore.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-userland-grants-"));
}

describe("UserlandApprovalGrantStore", () => {
  it("records, looks up, lists, and revokes grants", async () => {
    const store = new UserlandApprovalGrantStore({ statePath: tempDir() });
    await store.record(
      { callerId: "worker:alpha", callerKind: "worker" },
      { id: "team-x:foo", label: "Foo" },
      "allow",
      10
    );

    expect(store.lookup("worker:alpha", "team-x:foo")).toMatchObject({ choice: "allow" });
    expect(store.list("worker:alpha")).toHaveLength(1);
    await expect(store.revoke("worker:alpha", "team-x:foo")).resolves.toBe(true);
    await expect(store.revoke("worker:alpha", "team-x:foo")).resolves.toBe(false);
    expect(store.lookup("worker:alpha", "team-x:foo")).toBeNull();
  });

  it("persists across store instances without repo or version fields", async () => {
    const statePath = tempDir();
    const store = new UserlandApprovalGrantStore({ statePath });
    await store.record(
      { callerId: "panel:one", callerKind: "panel" },
      { id: "subject-1" },
      "yes",
      20
    );

    const restarted = new UserlandApprovalGrantStore({ statePath });
    expect(restarted.lookup("panel:one", "subject-1")).toMatchObject({ choice: "yes" });

    const raw = JSON.parse(
      fs.readFileSync(path.join(statePath, "userland-approval-grants.json"), "utf8")
    );
    expect(raw.grants[0]).not.toHaveProperty("repoPath");
    expect(raw.grants[0]).not.toHaveProperty("effectiveVersion");
    expect(raw.grants[0].principal).not.toHaveProperty("repoPath");
    expect(raw.grants[0].principal).not.toHaveProperty("effectiveVersion");
  });

  it("uses the documented flat key shape", () => {
    expect(parseCanonicalKey(keyFor(
      "worker:alpha",
      { kind: "worker", id: "worker:alpha" },
      "team-x:foo",
    ))).toEqual([
      "userland-grant",
      "worker:alpha",
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

    expect(store.list("worker:alpha")).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
