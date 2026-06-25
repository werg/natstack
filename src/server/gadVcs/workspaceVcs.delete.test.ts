import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../../workspace/workers/gad-store/index.js";
import { WorkspaceVcs } from "./workspaceVcs.js";
import { VCS_MAIN_HEAD, logIdForRepo, vcsContextHead, type GadCaller } from "./store.js";
import type { StateAdvancedEvent } from "../buildV2/stateTrigger.js";

type TestGad = Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;

function callerFor(gad: TestGad): GadCaller {
  return {
    async call<T>(method: string, input: unknown): Promise<T> {
      const instance = gad.instance as unknown as Record<string, (arg: unknown) => unknown>;
      const fn = instance[method];
      if (typeof fn !== "function") throw new Error(`no such gad method: ${method}`);
      return (await fn.call(gad.instance, input)) as T;
    },
  };
}

const USER = { id: "user", kind: "user" };

/**
 * Whole-repo deletion is a SEVERE, global-state action: it archives a repo's
 * history (to a recoverable, non-`main` head) and drops the repo from the
 * composed workspace view. This is the explicit, approval-gated counterpart to
 * `snapshotDir`'s deliberate refusal to INFER deletions from a missing dir.
 */
describe("WorkspaceVcs — whole-repo deletion", () => {
  let root: string;
  let workspaceRoot: string;
  let vcs: WorkspaceVcs;
  let gad: TestGad;
  let caller: GadCaller;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-del-"));
    workspaceRoot = path.join(root, "source");
    await fsp.mkdir(path.join(workspaceRoot, "packages/foo"), { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "packages/foo/index.ts"), "export const x = 1;\n");
    await fsp.mkdir(path.join(workspaceRoot, "packages/bar"), { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "packages/bar/index.ts"), "export const y = 1;\n");
    await fsp.mkdir(path.join(workspaceRoot, "meta"), { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "meta/natstack.yml"), "name: test\n");

    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    caller = callerFor(gad);
    vcs = new WorkspaceVcs({
      blobsDir: path.join(root, "blobs"),
      workspaceRoot,
      contextsRoot: path.join(root, ".contexts"),
      buildSourcesRoot: path.join(root, "build-sources"),
    });
    await vcs.attachGad(caller); // bootstraps per-repo mains from disk
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const repoPaths = async () => (await vcs.discoverRepos()).map((r) => r.repoPath);
  const worktreeHead = (repoPath: string, head: string) =>
    caller.call<{ stateHash: string } | null>("resolveWorktreeHead", {
      logId: logIdForRepo(repoPath),
      head,
    });
  // Fork a repo onto a context head (what an agent's context does): a working
  // edit folded into a deliberate commit, which is what creates the ctx head.
  async function forkCtx(ctxId: string, repoPath: string, file: string, body: string) {
    const head = vcsContextHead(ctxId);
    await vcs.recordEdit({
      head,
      actor: USER,
      repoPath,
      edits: [{ kind: "write", path: file, content: { kind: "text", text: body } }],
    });
    return vcs.commit({ head, repoPath, message: `fork ${repoPath}`, actor: USER });
  }

  it("archives history, drops the repo from global state, and removes its working tree", async () => {
    expect(await repoPaths()).toContain("packages/foo");

    const events: StateAdvancedEvent[] = [];
    const off = vcs.onStateAdvanced((e) => events.push(e));

    const result = await vcs.deleteRepo({ repoPath: "packages/foo", actor: USER });
    off();

    // Archived (recoverable) + reported the removed path.
    expect(result.archived).toBe(true);
    expect(result.archiveHead).toBeTruthy();
    expect(result.removedPaths).toContain("packages/foo/index.ts");

    // Dropped from the composed workspace view / global state.
    expect(await repoPaths()).not.toContain("packages/foo");
    expect(await repoPaths()).toContain("packages/bar");
    expect(await vcs.resolveHead(VCS_MAIN_HEAD, "packages/foo")).toBeNull();
    const view = await vcs.workspaceView();
    expect(await vcs.readFile(view.stateHash, "packages/foo/index.ts")).toBeNull();
    expect(await vcs.readFile(view.stateHash, "packages/bar/index.ts")).not.toBeNull();

    // The live `main` worktree head is gone; the archive head carries history.
    expect(await worktreeHead("packages/foo", VCS_MAIN_HEAD)).toBeNull();
    expect(await worktreeHead("packages/foo", result.archiveHead!)).not.toBeNull();

    // A `main` advance was emitted with the removed file (so build/tree react).
    const mainAdvance = events.find((e) => e.head === VCS_MAIN_HEAD);
    expect(mainAdvance?.changedPaths).toContain("packages/foo/index.ts");

    // On-disk subtree removed.
    await expect(fsp.access(path.join(workspaceRoot, "packages/foo"))).rejects.toThrow();
  });

  it("lets a fresh repo at the same path start clean (no inherited history)", async () => {
    await vcs.deleteRepo({ repoPath: "packages/foo", actor: USER });

    // Re-create the repo on disk with new content and re-seed its main.
    await fsp.mkdir(path.join(workspaceRoot, "packages/foo"), { recursive: true });
    await fsp.writeFile(
      path.join(workspaceRoot, "packages/foo/index.ts"),
      "export const reborn = true;\n"
    );
    await vcs.ensureRepoLogsFromDisk();

    expect(await repoPaths()).toContain("packages/foo");
    // The new main's log is fresh — a single seed commit, not the old lineage.
    const log = await vcs.readVcsLog(50, VCS_MAIN_HEAD, "packages/foo");
    expect(log.length).toBe(1);
    const view = await vcs.workspaceView();
    expect((await vcs.readFile(view.stateHash, "packages/foo/index.ts"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("reborn"),
    });
  });

  it("runs the authorization hook before any mutation and aborts cleanly on denial", async () => {
    const seen: Array<{ repoPath: string; fileCount: number; stateHash: string }> = [];
    await expect(
      vcs.deleteRepo({
        repoPath: "packages/foo",
        actor: USER,
        beforeDelete: async (info) => {
          seen.push(info);
          throw new Error("denied by user");
        },
      })
    ).rejects.toThrow(/denied by user/);

    // The hook saw the real target + file count (no dependents in this harness).
    expect(seen).toEqual([
      { repoPath: "packages/foo", fileCount: 1, stateHash: expect.any(String), dependents: [] },
    ]);
    // Nothing changed: repo still present in global state, main ref intact, tree on disk.
    expect(await repoPaths()).toContain("packages/foo");
    expect(await worktreeHead("packages/foo", VCS_MAIN_HEAD)).not.toBeNull();
    await expect(fsp.access(path.join(workspaceRoot, "packages/foo"))).resolves.toBeUndefined();
  });

  it("refuses to delete the meta repo and unknown repos", async () => {
    await expect(vcs.deleteRepo({ repoPath: "meta", actor: USER })).rejects.toThrow(/meta/);
    await expect(vcs.deleteRepo({ repoPath: "packages/ghost", actor: USER })).rejects.toThrow(
      /no committed `main`/
    );
  });

  it("refuses to resurrect a deleted repo via a stale context's push", async () => {
    // An agent forked the repo onto its context head BEFORE the deletion.
    await forkCtx("agent-1", "packages/foo", "index.ts", "export const x = 99;\n");
    await vcs.deleteRepo({ repoPath: "packages/foo", actor: USER });

    // The stale context still carries its ctx head; a push must NOT recreate main.
    await expect(
      vcs.push({
        repoPaths: ["packages/foo"],
        sourceHead: vcsContextHead("agent-1"),
        actor: USER,
      })
    ).rejects.toThrow(/was deleted/);
    // main stays absent — no silent resurrection.
    expect(await vcs.resolveHead(VCS_MAIN_HEAD, "packages/foo")).toBeNull();
    expect(await repoPaths()).not.toContain("packages/foo");
  });

  it("flags a deleted repo in contextStatus (distinct from a brand-new unpushed repo)", async () => {
    await vcs.pinContext("agent-1");
    // The context forks an existing repo AND creates a brand-new one.
    await forkCtx("agent-1", "packages/foo", "index.ts", "export const x = 2;\n");
    await forkCtx("agent-1", "packages/newbie", "index.ts", "export const n = 1;\n");
    // The existing repo is deleted out from under the context.
    await vcs.deleteRepo({ repoPath: "packages/foo", actor: USER });

    const status = await vcs.contextStatus("agent-1");
    // The deleted repo is flagged so the agent sees it BEFORE a push fails.
    expect(status.find((s) => s.repoPath === "packages/foo")).toMatchObject({ deleted: true });
    // A brand-new unpushed repo also has no main, but is NOT flagged deleted.
    expect(status.find((s) => s.repoPath === "packages/newbie")).toMatchObject({
      deleted: false,
      forked: true,
    });
    // An untouched existing repo is not flagged either.
    expect(status.find((s) => s.repoPath === "packages/bar")?.deleted ?? false).toBe(false);
  });

  it("restores a deleted repo from its archive, re-adding it to global state", async () => {
    await vcs.deleteRepo({ repoPath: "packages/foo", actor: USER });
    expect(await repoPaths()).not.toContain("packages/foo");

    const result = await vcs.restoreRepo({ repoPath: "packages/foo", actor: USER });
    expect(result.restored).toBe(true);
    expect(result.fromArchiveHead).toBeTruthy();
    expect(result.restoredPaths).toContain("packages/foo/index.ts");

    // Back in global state with its original content + working tree.
    expect(await repoPaths()).toContain("packages/foo");
    const view = await vcs.workspaceView();
    expect((await vcs.readFile(view.stateHash, "packages/foo/index.ts"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("x = 1"),
    });
    expect(await worktreeHead("packages/foo", VCS_MAIN_HEAD)).not.toBeNull();
    await expect(
      fsp.access(path.join(workspaceRoot, "packages/foo/index.ts"))
    ).resolves.toBeUndefined();
    // A push from a fresh context now works again (the repo is live).
    expect(await vcs.resolveHead(VCS_MAIN_HEAD, "packages/foo")).toBeTruthy();
  });

  it("fails to restore when a different repo was slotted in at the path", async () => {
    await vcs.deleteRepo({ repoPath: "packages/foo", actor: USER });
    // A DIFFERENT repo is created at the same path after the deletion.
    await fsp.mkdir(path.join(workspaceRoot, "packages/foo"), { recursive: true });
    await fsp.writeFile(
      path.join(workspaceRoot, "packages/foo/index.ts"),
      "export const usurper = 1;\n"
    );
    await vcs.ensureRepoLogsFromDisk();

    await expect(vcs.restoreRepo({ repoPath: "packages/foo", actor: USER })).rejects.toThrow(
      /already occupies that path/
    );
    // The occupant is untouched.
    const view = await vcs.workspaceView();
    expect((await vcs.readFile(view.stateHash, "packages/foo/index.ts"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("usurper"),
    });
  });

  it("fails to restore a path with no archived history", async () => {
    // A path that never existed: no live main (passes the occupancy guard) and
    // nothing archived to recover.
    await expect(vcs.restoreRepo({ repoPath: "packages/ghost", actor: USER })).rejects.toThrow(
      /no archived history/
    );
  });

  it("runs the restore authorization hook before any mutation and aborts on denial", async () => {
    await vcs.deleteRepo({ repoPath: "packages/foo", actor: USER });
    await expect(
      vcs.restoreRepo({
        repoPath: "packages/foo",
        actor: USER,
        beforeRestore: async () => {
          throw new Error("restore denied");
        },
      })
    ).rejects.toThrow(/restore denied/);
    // Still deleted — the denial left nothing half-restored.
    expect(await repoPaths()).not.toContain("packages/foo");
    expect(await worktreeHead("packages/foo", VCS_MAIN_HEAD)).toBeNull();
  });
});
