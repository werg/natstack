/**
 * listFiles / revert / pushStatus / statusHead in the edit → commit → push model.
 *
 *   - `main` advances ONLY via push, so every mutation here happens on a `ctx:*`
 *     head (edit → commit), and `main` is seeded with the `seedMain` helper
 *     (edit → commit → push on a throwaway context, then dropContext).
 *   - `revert` is now a WORKING edit: it computes the inverse patch of a
 *     transition and records it as uncommitted ops (RecordEditResult —
 *     committed:false / status:"uncommitted", NO eventId/conflicts). The working
 *     content reflects the inverse; a later `commit` seals it.
 *   - pushStatus/statusHead surface committed `ahead` AND the new `uncommitted`
 *     working-edit count.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../../workspace/workers/gad-store/index.js";
import { WorkspaceVcs } from "./workspaceVcs.js";
import { VCS_MAIN_HEAD, logIdForRepo, vcsContextHead, type GadCaller } from "./store.js";

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
const AGENT = { id: "scribe", kind: "agent" };
const text = (value: string) => ({ kind: "text" as const, text: value });

// All revert/listFiles tests run on a single per-repo log.
const REPO = "packages/revert";
const CTX = "work";
const CTX_HEAD = vcsContextHead(CTX);

describe("WorkspaceVcs.listFiles / revert / pushStatus", () => {
  let root: string;
  let workspaceRoot: string;
  let vcs: WorkspaceVcs;
  let gad: TestGad;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-revert-"));
    workspaceRoot = path.join(root, "workspace");
    await fsp.mkdir(workspaceRoot);
    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    vcs = new WorkspaceVcs({
      blobsDir: path.join(root, "blobs"),
      workspaceRoot,
      contextsRoot: path.join(root, ".contexts"),
      buildSourcesRoot: path.join(root, "build-sources"),
    });
    await vcs.attachGad(callerFor(gad));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  /** Read a file's COMMITTED text at a head on the repo under test (null if
   *  absent). `vcs.readFile` resolves the committed head state — uncommitted
   *  working edits are NOT visible here until a commit. */
  async function readAt(head: string, rel: string): Promise<string | null> {
    const file = await vcs.readFile(head, rel, REPO);
    if (!file) return null;
    if (file.content.kind !== "text") throw new Error(`not text: ${rel}`);
    return file.content.text;
  }

  /** Read the WORKING (uncommitted) content of a file as materialized on disk in
   *  the context projection (`.contexts/<ctx>/<repo>/<file>`); null if absent. */
  async function readWorking(ctxId: string, rel: string): Promise<string | null> {
    try {
      return await fsp.readFile(path.join(root, ".contexts", ctxId, REPO, rel), "utf8");
    } catch {
      return null;
    }
  }

  /** Uncommitted working edit-op rows on a head for `repo`. */
  async function workingRows(head: string, repo = REPO) {
    return gad.instance.listWorkingEdits({ logId: logIdForRepo(repo), head });
  }

  /**
   * Seed a repo's `main` via the real flow (edit → commit → push on a throwaway
   * context), then drop the seeding context. Returns main's state hash.
   */
  async function seedMain(
    repo: string,
    edits: Parameters<WorkspaceVcs["recordEdit"]>[0]["edits"],
    actor = USER
  ): Promise<string> {
    const seedHead = vcsContextHead("__seed__");
    await vcs.recordEdit({ head: seedHead, repoPath: repo, edits, actor });
    await vcs.commit({ head: seedHead, repoPath: repo, message: "seed", actor });
    const pushed = await vcs.push({ repoPaths: [repo], sourceHead: seedHead, actor });
    expect(pushed.status).toBe("pushed");
    await vcs.dropContext("__seed__");
    const main = await vcs.resolveHead(VCS_MAIN_HEAD, repo);
    if (!main) throw new Error("seedMain: main not created");
    return main;
  }

  /**
   * Record + commit a single deliberate snapshot onto a `ctx:*` head, returning
   * the commit result ({ stateHash, eventId, ... }). The ctx head is the only
   * place mutations happen now.
   */
  async function editCommit(
    head: string,
    edits: Parameters<WorkspaceVcs["recordEdit"]>[0]["edits"],
    message: string,
    actor = AGENT
  ): Promise<Awaited<ReturnType<WorkspaceVcs["commit"]>>> {
    await vcs.recordEdit({ head, repoPath: REPO, actor, edits });
    return vcs.commit({ head, repoPath: REPO, message, actor });
  }

  it("listFiles returns paths + content hash + mode at a head", async () => {
    await seedMain(REPO, [
      { kind: "create", path: "a.mdx", content: text("A\n") },
      { kind: "create", path: "dir/b.mdx", content: text("B\n") },
    ]);

    const files = await vcs.listFiles(VCS_MAIN_HEAD, REPO);
    expect(files.map((f) => f.path).sort()).toEqual(["a.mdx", "dir/b.mdx"]);
    for (const file of files) {
      expect(typeof file.contentHash).toBe("string");
      expect(typeof file.mode).toBe("number");
    }
  });

  it("revert records an uncommitted inverse patch; commit seals it", async () => {
    await seedMain(REPO, [{ kind: "create", path: "doc.txt", content: text("original\n") }]);
    // The agent edits + commits doc.txt on the ctx head.
    const edit = await editCommit(
      CTX_HEAD,
      [{ kind: "write", path: "doc.txt", content: text("scribe edit\n") }],
      "scribe edit"
    );
    expect(await readAt(CTX_HEAD, "doc.txt")).toBe("scribe edit\n");

    // revert is a WORKING edit (inverse patch) — uncommitted, no eventId/conflicts.
    const reverted = await vcs.revert({
      head: CTX_HEAD,
      target: { stateHash: edit.stateHash },
      actor: USER,
      repoPath: REPO,
    });
    expect(reverted.committed).toBe(false);
    expect(reverted.status).toBe("uncommitted");
    // changedPaths are re-rooted to workspace-relative (the repo is subtree-rooted).
    expect(reverted.changedPaths).toEqual([`${REPO}/doc.txt`]);
    // The inverse is recorded as an uncommitted op AND the working content reflects it.
    const rows = await workingRows(CTX_HEAD);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["path"]).toBe("doc.txt");
    expect(rows[0]!["committed_event_id"]).toBeNull();
    // Working projection on disk reflects the inverse; the committed head does NOT yet.
    expect(await readWorking(CTX, "doc.txt")).toBe("original\n");
    expect(await readAt(CTX_HEAD, "doc.txt")).toBe("scribe edit\n");

    // commit seals the revert; the working edits are claimed.
    const sealed = await vcs.commit({
      head: CTX_HEAD,
      repoPath: REPO,
      message: "revert edit",
      actor: USER,
    });
    expect(sealed.status).toBe("committed");
    expect(await workingRows(CTX_HEAD)).toHaveLength(0);
    expect(await readAt(CTX_HEAD, "doc.txt")).toBe("original\n");
  });

  it("revert undoes a create (→ delete) and a delete (→ recreate)", async () => {
    await seedMain(REPO, [{ kind: "create", path: "keep.txt", content: text("keep\n") }]);

    // A create, committed on the ctx head, reverted (→ delete) then sealed.
    const created = await editCommit(
      CTX_HEAD,
      [{ kind: "create", path: "new.txt", content: text("brand new\n") }],
      "add new.txt"
    );
    expect(await readAt(CTX_HEAD, "new.txt")).toBe("brand new\n");
    await vcs.revert({
      head: CTX_HEAD,
      target: { stateHash: created.stateHash },
      actor: USER,
      repoPath: REPO,
    });
    // The working projection already reflects the inverse (delete); commit seals it.
    expect(await readWorking(CTX, "new.txt")).toBeNull();
    await vcs.commit({ head: CTX_HEAD, repoPath: REPO, message: "revert create", actor: USER });
    expect(await readAt(CTX_HEAD, "new.txt")).toBeNull();

    // A delete, committed, reverted (→ recreate) then sealed.
    const deleted = await editCommit(
      CTX_HEAD,
      [{ kind: "delete", path: "keep.txt" }],
      "remove keep.txt"
    );
    expect(await readAt(CTX_HEAD, "keep.txt")).toBeNull();
    await vcs.revert({
      head: CTX_HEAD,
      target: { stateHash: deleted.stateHash },
      actor: USER,
      repoPath: REPO,
    });
    expect(await readWorking(CTX, "keep.txt")).toBe("keep\n");
    await vcs.commit({ head: CTX_HEAD, repoPath: REPO, message: "revert delete", actor: USER });
    expect(await readAt(CTX_HEAD, "keep.txt")).toBe("keep\n");
  });

  it("revert stages the pre-transition content of every path it touched", async () => {
    await seedMain(REPO, [{ kind: "create", path: "doc.txt", content: text("A\nB\nC\n") }]);

    // Agent changes line A (committed); the transition's pre-state is "A\nB\nC\n".
    const agentEdit = await editCommit(
      CTX_HEAD,
      [{ kind: "write", path: "doc.txt", content: text("A-agent\nB\nC\n") }],
      "agent edits A"
    );
    // User then changes line C on top (committed).
    await editCommit(
      CTX_HEAD,
      [{ kind: "write", path: "doc.txt", content: text("A-agent\nB\nC-user\n") }],
      "user edits C",
      USER
    );

    // Revert the agent's transition. revert is a WORKING edit (inverse patch):
    // the changed file is restored to its PRE-transition content as a whole-file
    // working write — it is staged, inspectable, and reversible by discard before
    // commit (no silent commit, no head reset).
    const reverted = await vcs.revert({
      head: CTX_HEAD,
      target: { stateHash: agentEdit.stateHash },
      actor: USER,
      repoPath: REPO,
    });
    expect(reverted.status).toBe("uncommitted");
    expect(reverted.changedPaths).toEqual([`${REPO}/doc.txt`]);
    // The working projection restores the transition's pre-state.
    expect(await readWorking(CTX, "doc.txt")).toBe("A\nB\nC\n");
    // The committed head is untouched until commit; discard backs the revert out.
    expect(await readAt(CTX_HEAD, "doc.txt")).toBe("A-agent\nB\nC-user\n");
    await vcs.discardEdits({ head: CTX_HEAD, repoPath: REPO });
    expect(await readAt(CTX_HEAD, "doc.txt")).toBe("A-agent\nB\nC-user\n");

    // Re-running the revert and committing seals the pre-transition content.
    await vcs.revert({
      head: CTX_HEAD,
      target: { stateHash: agentEdit.stateHash },
      actor: USER,
      repoPath: REPO,
    });
    await vcs.commit({ head: CTX_HEAD, repoPath: REPO, message: "revert agent", actor: USER });
    expect(await readAt(CTX_HEAD, "doc.txt")).toBe("A\nB\nC\n");
  });

  it("revert of an overlapping edit is a staged working edit (discardable before commit)", async () => {
    await seedMain(REPO, [{ kind: "create", path: "doc.txt", content: text("L1\nL2\nL3\n") }]);

    const agentEdit = await editCommit(
      CTX_HEAD,
      [{ kind: "write", path: "doc.txt", content: text("L1\nL2-agent\nL3\n") }],
      "agent edits L2"
    );
    // User changes the SAME line the agent touched (committed).
    await editCommit(
      CTX_HEAD,
      [{ kind: "write", path: "doc.txt", content: text("L1\nL2-user\nL3\n") }],
      "user edits L2",
      USER
    );

    // revert is a WORKING edit: it stages the inverse over the live content. The
    // overlap is no longer a hard conflict that parks a pending merge — it is an
    // uncommitted edit the author can inspect and DISCARD before committing.
    const reverted = await vcs.revert({
      head: CTX_HEAD,
      target: { stateHash: agentEdit.stateHash },
      actor: USER,
      repoPath: REPO,
    });
    expect(reverted.status).toBe("uncommitted");
    expect((await workingRows(CTX_HEAD)).length).toBeGreaterThanOrEqual(1);
    // No pending merge is parked by a working revert.
    expect(await vcs.pendingMerge(CTX_HEAD, REPO)).toBeNull();
    // Discard backs the revert out — the committed head (L2-user) is restored.
    await vcs.discardEdits({ head: CTX_HEAD, repoPath: REPO });
    expect(await workingRows(CTX_HEAD)).toHaveLength(0);
    expect(await readAt(CTX_HEAD, "doc.txt")).toBe("L1\nL2-user\nL3\n");
  });

  it("revert resolves a transition by eventId", async () => {
    await seedMain(REPO, [{ kind: "create", path: "doc.txt", content: text("v1\n") }]);
    const edit = await editCommit(
      CTX_HEAD,
      [{ kind: "write", path: "doc.txt", content: text("v2\n") }],
      "v2"
    );
    expect(edit.eventId).toBeTruthy();
    await vcs.revert({
      head: CTX_HEAD,
      target: { eventId: edit.eventId! },
      actor: USER,
      repoPath: REPO,
    });
    expect(await readWorking(CTX, "doc.txt")).toBe("v1\n");
    await vcs.commit({ head: CTX_HEAD, repoPath: REPO, message: "revert v2", actor: USER });
    expect(await readAt(CTX_HEAD, "doc.txt")).toBe("v1\n");
  });

  it("rejects revert on a main head (main advances only via push)", async () => {
    const base = await seedMain(REPO, [{ kind: "create", path: "doc.txt", content: text("v1\n") }]);
    await expect(
      vcs.revert({
        head: VCS_MAIN_HEAD,
        target: { stateHash: base },
        actor: USER,
        repoPath: REPO,
      })
    ).rejects.toThrow(/main advances only via push/);
  });

  it("pushStatus reports a repo's context head ahead of its own main, plus uncommitted edits", async () => {
    const repoPath = "packages/notes";

    // Seed the repo's own main (vcs:repo:packages/notes) with one file.
    await seedMain(repoPath, [{ kind: "create", path: "a.mdx", content: text("hello\n") }]);
    expect((await vcs.pushStatus(repoPath, VCS_MAIN_HEAD)).ahead).toBe(0);

    const head = vcsContextHead("vault-test");

    // A WORKING edit shows up as uncommitted (not yet ahead — the commit head
    // has not advanced).
    await vcs.recordEdit({
      head,
      repoPath,
      actor: USER,
      edits: [{ kind: "write", path: "a.mdx", content: text("hello world\n") }],
    });
    const working = await vcs.pushStatus(repoPath, head);
    expect(working.ahead).toBe(0);
    expect(working.uncommitted).toBe(1);

    // Commit folds it into a snapshot → now ahead by 1, no uncommitted.
    await vcs.commit({ head, repoPath, message: "edit a", actor: USER });
    const ahead = await vcs.pushStatus(repoPath, head);
    expect(ahead.ahead).toBe(1);
    expect(ahead.uncommitted).toBe(0);
    expect(ahead.files).toEqual([{ path: "a.mdx", kind: "changed" }]);
  });

  it("pushStatus does not count upstream-only drift as local ahead", async () => {
    const repoPath = "packages/notes-drift";
    await seedMain(repoPath, [{ kind: "create", path: "a.mdx", content: text("hello\n") }]);

    const head = vcsContextHead("vault-drift");
    await vcs.recordEdit({
      head,
      repoPath,
      actor: USER,
      edits: [{ kind: "write", path: "a.mdx", content: text("hello from ctx\n") }],
    });
    await vcs.commit({ head, repoPath, message: "ctx edit", actor: USER });
    expect((await vcs.push({ repoPaths: [repoPath], sourceHead: head, actor: USER })).status).toBe(
      "pushed"
    );

    await seedMain(repoPath, [
      { kind: "create", path: "upstream.mdx", content: text("upstream only\n") },
    ]);

    const stale = await vcs.pushStatus(repoPath, head);
    expect(stale.diverged).toBe(true);
    expect(stale.ahead).toBe(0);
    expect(stale.files).toEqual([]);

    const status = await vcs.statusHead(head, repoPath);
    expect(status.dirty).toBe(false);
    expect(status.added).toEqual([]);
    expect(status.changed).toEqual([]);
    expect(status.removed).toEqual([]);
  });

  it("statusHead reports a context head's unpublished changes vs main (pure GAD diff)", async () => {
    const repoPath = "packages/notes";

    // Seed the repo's main.
    await seedMain(repoPath, [{ kind: "create", path: "notes.mdx", content: text("hello\n") }]);

    const head = vcsContextHead("status-test");

    // A fresh fork matches main — status is clean.
    const clean = await vcs.statusHead(head, repoPath);
    expect(clean.dirty).toBe(false);
    expect(clean.added).toEqual([]);
    expect(clean.changed).toEqual([]);
    expect(clean.removed).toEqual([]);

    // A WORKING edit is dirty via uncommitted, even before it commits — but the
    // committed diff (added/changed) is still empty until commit.
    await vcs.recordEdit({
      head,
      repoPath,
      actor: USER,
      edits: [
        { kind: "write", path: "notes.mdx", content: text("hello world\n") },
        { kind: "create", path: "fresh.mdx", content: text("new\n") },
      ],
    });
    const working = await vcs.statusHead(head, repoPath);
    expect(working.dirty).toBe(true);
    expect(working.uncommitted).toBe(2);

    // Commit surfaces them as published-pending changes against main.
    await vcs.commit({ head, repoPath, message: "notes", actor: USER });
    const dirty = await vcs.statusHead(head, repoPath);
    expect(dirty.dirty).toBe(true);
    expect(dirty.uncommitted).toBe(0);
    expect(dirty.changed).toEqual(["notes.mdx"]);
    expect(dirty.added).toEqual(["fresh.mdx"]);
    expect(dirty.stateHash).toBe(await vcs.resolveHead(head, repoPath));

    // main is the publish baseline — always clean.
    expect((await vcs.statusHead(VCS_MAIN_HEAD, repoPath)).dirty).toBe(false);
  });
});
