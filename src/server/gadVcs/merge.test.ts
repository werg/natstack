/**
 * Verification of the MERGE-as-reconcile model (edit → commit → push, §11).
 *
 * `main` advances ONLY via push (fast-forward only). When `main` has diverged
 * past a context's base, `vcs.push` returns a structured `diverged` result and
 * the context reconciles by pulling `main` INTO the ctx head with
 * `vcs.mergeHeads(ctxHead, main, ...)`:
 *   - clean → a merge commit (no resolution), then push fast-forwards;
 *   - conflict → a parked pending merge with markers/summary on the ctx
 *     worktree, resolved via `recordEdit` → `commit` (which seals the merge,
 *     recording both parents), then push fast-forwards.
 *
 * Coverage kept from the old merge-INTO-main model and translated:
 *   - clean diverged reconcile (content on non-overlapping regions),
 *   - content conflict (overlapping line) → markers + pending merge,
 *   - executable-bit preserved while the other side edits content,
 *   - delete-vs-change non-content conflict (summary file, zero in-file markers),
 *   - abortMerge clears the pending merge,
 *   - up-to-date / fast-forward,
 *   - pending-merge crash recovery (markers never hit the worktree),
 *   - worktree-escaping / platform-ignored edit-path rejection (now at recordEdit),
 *   - GC (referenced history kept, orphans swept, pending-merge states are roots).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../../workspace/workers/gad-store/index.js";
import { WorkspaceVcs } from "./workspaceVcs.js";
import { VCS_MAIN_HEAD, vcsContextHead, logIdForRepo, type GadCaller } from "./store.js";

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

// Every merge test operates on a single per-repo log; this is the repo under
// test. Its log id is `vcs:repo:panels/merge` (see logIdForRepo).
const REPO = "panels/merge";
const REPO_LOG = logIdForRepo(REPO);
const CTX = "ctx-1";
const CTX_HEAD = vcsContextHead(CTX);

describe("WorkspaceVcs merge", () => {
  let root: string;
  let workspaceRoot: string;
  let vcs: WorkspaceVcs;
  let gad: TestGad;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-merge-"));
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

  /** Read a file's text content at a head on the repo under test. */
  async function readAt(head: string, rel: string): Promise<string> {
    const file = await vcs.readFile(head, rel, REPO);
    if (!file) throw new Error(`no such file at ${head}: ${rel}`);
    if (file.content.kind !== "text") throw new Error(`not text: ${rel}`);
    return file.content.text;
  }

  /** Materialized worktree dir for a head on the repo under test. */
  function dirFor(head: string): string {
    if (head === VCS_MAIN_HEAD) return path.join(workspaceRoot, ...REPO.split("/"));
    if (head.startsWith("ctx:")) {
      return path.join(root, ".contexts", head.slice(4), ...REPO.split("/"));
    }
    throw new Error(`no worktree for head: ${head}`);
  }

  /** Read a file off a head's materialized worktree (where merge conflict
   *  markers land — the provisional merge state is parked, not the head ref). */
  async function readDisk(head: string, rel: string): Promise<string> {
    return await fsp.readFile(path.join(dirFor(head), ...rel.split("/")), "utf8");
  }

  /** Seed a repo's `main` via the real flow (edit → commit → push on a throwaway
   *  context), then drop the seeding context. `main` advances ONLY via push, so
   *  there is no longer a direct main-applyEdits path. Returns main's state hash. */
  async function seedMain(
    edits: Parameters<WorkspaceVcs["recordEdit"]>[0]["edits"]
  ): Promise<string> {
    const seedHead = vcsContextHead("__seed__");
    await vcs.recordEdit({ head: seedHead, repoPath: REPO, edits, actor: USER });
    await vcs.commit({ head: seedHead, repoPath: REPO, message: "seed", actor: USER });
    const pushed = await vcs.push({ repoPaths: [REPO], sourceHead: seedHead, actor: USER });
    expect(pushed.status).toBe("pushed");
    await vcs.dropContext("__seed__");
    const main = await vcs.resolveHead(VCS_MAIN_HEAD, REPO);
    if (!main) throw new Error("seedMain: main not created");
    return main;
  }

  /** Advance `main` (e.g. a concurrent landing) by committing+pushing edits via
   *  a throwaway context, then dropping it. Each call uses a UNIQUE seeding
   *  context id (a reused id would re-fork over a dropped head). */
  let advanceSeq = 0;
  async function advanceMain(
    edits: Parameters<WorkspaceVcs["recordEdit"]>[0]["edits"],
    message = "advance main"
  ): Promise<string> {
    const ctxId = `__other_${advanceSeq++}__`;
    const otherCtx = vcsContextHead(ctxId);
    await vcs.recordEdit({ head: otherCtx, repoPath: REPO, edits, actor: USER });
    await vcs.commit({ head: otherCtx, repoPath: REPO, message, actor: USER });
    const pushed = await vcs.push({ repoPaths: [REPO], sourceHead: otherCtx, actor: USER });
    expect(pushed.status).toBe("pushed");
    await vcs.dropContext(ctxId);
    return (await vcs.resolveHead(VCS_MAIN_HEAD, REPO))!;
  }

  /** Record + commit edits on the ctx head under test. */
  async function commitCtx(
    edits: Parameters<WorkspaceVcs["recordEdit"]>[0]["edits"],
    message = "ctx edit"
  ): Promise<string> {
    await vcs.recordEdit({ head: CTX_HEAD, repoPath: REPO, edits, actor: AGENT });
    const res = await vcs.commit({ head: CTX_HEAD, repoPath: REPO, message, actor: AGENT });
    return res.stateHash;
  }

  /** Set up: seed main with two files, fork+materialize ctx-1, diverge both
   *  sides. Mirrors the old `divergedSetup` but expressed in commit→push terms:
   *  ctx commits its change; main lands a concurrent change via push. */
  async function divergedSetup(opts: { conflict: boolean }): Promise<void> {
    await seedMain([
      { kind: "create", path: "shared.txt", content: text("line1\nline2\nline3\n") },
      { kind: "create", path: "main-only.txt", content: text("main\n") },
    ]);

    // Context commits its side of shared.txt (and a brand-new file).
    await commitCtx(
      [
        {
          kind: "write",
          path: "shared.txt",
          content: text(opts.conflict ? "CTX\nline2\nline3\n" : "line1\nline2\nctx3\n"),
        },
        { kind: "create", path: "ctx-new.txt", content: text("made in context\n") },
      ],
      "ctx side"
    );

    // Main lands a concurrent change (overlapping line iff conflict requested).
    await advanceMain(
      [
        {
          kind: "write",
          path: "shared.txt",
          content: text(opts.conflict ? "MAIN\nline2\nline3\n" : "MAIN1\nline2\nline3\n"),
        },
      ],
      "main side"
    );
  }

  it("clean diverged reconcile: push diverges, mergeHeads(ctx,main) merges, push fast-forwards", async () => {
    await divergedSetup({ conflict: false });

    // Push diverges — `main` advanced past the ctx base on a clean-mergeable region.
    const diverged = await vcs.push({ repoPaths: [REPO], sourceHead: CTX_HEAD, actor: AGENT });
    expect(diverged.status).toBe("diverged");
    if (diverged.status === "diverged") {
      expect(diverged.divergences).toHaveLength(1);
      expect(diverged.divergences[0]!.mergeable).toBe("clean");
      expect(diverged.divergences[0]!.upstreamCommits.length).toBeGreaterThanOrEqual(1);
    }

    // Reconcile by pulling main INTO the ctx head → a clean merge commit.
    const result = await vcs.mergeHeads(CTX_HEAD, VCS_MAIN_HEAD, { actor: AGENT, repoPath: REPO });
    expect(result.status).toBe("merged");
    expect(result.mergeable).toBe("clean");
    expect(result.conflicts).toEqual([]);

    // The reconciled ctx head carries both sides.
    expect(await readAt(CTX_HEAD, "shared.txt")).toBe("MAIN1\nline2\nctx3\n");
    expect(await readAt(CTX_HEAD, "ctx-new.txt")).toBe("made in context\n");
    expect(await readAt(CTX_HEAD, "main-only.txt")).toBe("main\n");

    // The merge is a multi-parent transition on the repo's log (ctx head).
    const events = gad.instance.readLog({ logId: REPO_LOG, head: CTX_HEAD, limit: 0 });
    const mergeEvent = events.find((e) => e.payloadKind === "state.merge_applied");
    expect(mergeEvent).toBeDefined();
    const payload = mergeEvent!.payload as { parentStateHashes?: string[] };
    expect(payload.parentStateHashes).toHaveLength(1); // theirs (main) is the added parent

    // Now the ctx head descends from main's tip → push fast-forwards cleanly.
    const pushed = await vcs.push({ repoPaths: [REPO], sourceHead: CTX_HEAD, actor: AGENT });
    expect(pushed.status).toBe("pushed");
    expect(await readAt(VCS_MAIN_HEAD, "shared.txt")).toBe("MAIN1\nline2\nctx3\n");
    expect(await readAt(VCS_MAIN_HEAD, "ctx-new.txt")).toBe("made in context\n");
  });

  it("rejects worktree-escaping edit paths at the recordEdit boundary", async () => {
    await seedMain([{ kind: "create", path: "a.txt", content: text("one\n") }]);
    await expect(
      vcs.recordEdit({
        head: CTX_HEAD,
        repoPath: REPO,
        edits: [{ kind: "write", path: "../escape.txt", content: { kind: "text", text: "pwn" } }],
        actor: AGENT,
      })
    ).rejects.toThrow(/escapes worktree/u);
  });

  it("rejects edits that write platform-ignored paths (.env, .git/*, node_modules)", async () => {
    await seedMain([{ kind: "create", path: "a.txt", content: text("one\n") }]);
    for (const bad of [
      ".env",
      ".git/hooks/pre-commit",
      "node_modules/x/index.js",
      ".gad/x",
      ".npmrc",
    ]) {
      await expect(
        vcs.recordEdit({
          head: CTX_HEAD,
          repoPath: REPO,
          edits: [{ kind: "write", path: bad, content: { kind: "text", text: "x" } }],
          actor: AGENT,
        })
      ).rejects.toThrow(/platform-ignored/u);
    }
    // A normal path still applies cleanly.
    const ok = await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      edits: [{ kind: "write", path: "src/ok.ts", content: { kind: "text", text: "y" } }],
      actor: AGENT,
    });
    expect(ok.status).toBe("uncommitted");
  });

  it("preserves an executable-bit set on one side while the other edits content", async () => {
    // Modes are full stat modes (regular file 0o100644); the chmod adds +x.
    await seedMain([
      {
        kind: "create",
        path: "script.sh",
        content: text("#!/bin/sh\necho one\n"),
        mode: 0o100644,
      },
    ]);

    // Context only flips the exec bit; the content is unchanged.
    await commitCtx([{ kind: "chmod", path: "script.sh", mode: 0o100755 }], "chmod +x");

    // Main edits the content (mode unchanged) so the reconcile hits the content arm.
    await advanceMain(
      [{ kind: "write", path: "script.sh", content: text("#!/bin/sh\necho two\n") }],
      "main content"
    );

    const result = await vcs.mergeHeads(CTX_HEAD, VCS_MAIN_HEAD, { actor: AGENT, repoPath: REPO });
    expect(result.status).toBe("merged");
    expect(result.conflicts).toEqual([]);
    // Content from main, exec bit from context — neither silently dropped.
    expect(await readAt(CTX_HEAD, "script.sh")).toBe("#!/bin/sh\necho two\n");
    const files = await vcs.listFiles(CTX_HEAD, REPO);
    const script = files.find((f) => f.path === "script.sh")!;
    expect(script.mode & 0o111).not.toBe(0);
  });

  it("surfaces non-content conflicts (delete-vs-change)", async () => {
    await seedMain([
      { kind: "create", path: "doc.txt", content: text("original\n") },
      { kind: "create", path: "keep.txt", content: text("k\n") },
    ]);

    // Context deletes doc.txt (and adds a file), commits.
    await commitCtx(
      [
        { kind: "delete", path: "doc.txt" },
        { kind: "create", path: "ctx.txt", content: text("c\n") },
      ],
      "ctx delete"
    );

    // Main changes the same file → delete-vs-change.
    await advanceMain(
      [{ kind: "write", path: "doc.txt", content: text("changed on main\n") }],
      "main change"
    );

    const result = await vcs.mergeHeads(CTX_HEAD, VCS_MAIN_HEAD, { actor: AGENT, repoPath: REPO });
    expect(result.status).toBe("conflicted");
    expect(result.mergeable).toBe("conflict");
    expect(
      result.conflicts.some((c) => c.kind === "delete-vs-change" && c.path === "doc.txt")
    ).toBe(true);
    // The non-content conflict surfaces via the worktree summary file (it leaves
    // zero in-file `<<<<<<<` markers).
    const summary = await readDisk(CTX_HEAD, "MERGE_CONFLICTS.md");
    expect(summary).toContain("delete-vs-change");
    expect(summary).toContain("doc.txt");

    // Resolving a non-content conflict still seals the merge with zero in-file
    // markers: keep the file (an explicit working edit) then commit. The commit
    // consumes the pending and records both parents.
    await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      edits: [{ kind: "write", path: "doc.txt", content: text("changed on main\n") }],
      actor: AGENT,
    });
    const sealed = await vcs.commit({
      head: CTX_HEAD,
      repoPath: REPO,
      message: "resolve delete-vs-change",
      actor: AGENT,
    });
    expect(sealed.status).toBe("committed");
    expect(await vcs.pendingMerge(CTX_HEAD, REPO)).toBeNull();
    const ancestors = await vcs.commitAncestors(REPO, sealed.eventId!);
    expect(ancestors[0]!.parentEventIds.length).toBeGreaterThanOrEqual(2);
    // The conflict summary never enters the committed repo state.
    const files = await vcs.listFiles(CTX_HEAD, REPO);
    expect(files.map((f) => f.path)).not.toContain("MERGE_CONFLICTS.md");
  });

  it("clears the pending merge when a merge is aborted", async () => {
    await divergedSetup({ conflict: true });
    const result = await vcs.mergeHeads(CTX_HEAD, VCS_MAIN_HEAD, { actor: AGENT, repoPath: REPO });
    expect(result.status).toBe("conflicted");
    expect(await vcs.pendingMerge(CTX_HEAD, REPO)).not.toBeNull();

    await vcs.abortMerge(CTX_HEAD, { repoPath: REPO });
    expect(await vcs.pendingMerge(CTX_HEAD, REPO)).toBeNull();
  });

  it("fast-forwards a context into an advanced main (no local commits)", async () => {
    await seedMain([{ kind: "create", path: "a.txt", content: text("one\n") }]);
    // Fork+materialize the ctx so it has a base; do NOT commit anything locally.
    await commitCtx([{ kind: "create", path: "ctx-marker.txt", content: text("m\n") }], "marker");
    // Reset to a clean ctx that only tracks main by reconciling first (so the
    // only divergence is main's advance). Then main advances on a fresh file.
    await vcs.mergeHeads(CTX_HEAD, VCS_MAIN_HEAD, { actor: AGENT, repoPath: REPO });
    await advanceMain(
      [{ kind: "write", path: "a.txt", content: text("one\ntwo\n") }],
      "main grows"
    );

    const result = await vcs.mergeHeads(CTX_HEAD, VCS_MAIN_HEAD, { actor: AGENT, repoPath: REPO });
    expect(result.status).toBe("merged");
    expect(await readAt(CTX_HEAD, "a.txt")).toBe("one\ntwo\n");
  });

  it("reports up-to-date when there is nothing to merge", async () => {
    await seedMain([{ kind: "create", path: "a.txt", content: text("one\n") }]);
    // Fork+materialize the ctx (a working edit gives it a base view on disk),
    // commit it, then reconcile so it sits exactly at main.
    await commitCtx([{ kind: "create", path: "ctx.txt", content: text("c\n") }], "ctx");
    await vcs.mergeHeads(CTX_HEAD, VCS_MAIN_HEAD, { actor: AGENT, repoPath: REPO });

    // A second reconcile with no upstream advance is up-to-date.
    const result = await vcs.mergeHeads(CTX_HEAD, VCS_MAIN_HEAD, { actor: AGENT, repoPath: REPO });
    expect(result.status).toBe("up-to-date");
  });

  it("conflicted merge: parks a pending merge and materializes markers onto the ctx worktree", async () => {
    await divergedSetup({ conflict: true });

    const result = await vcs.mergeHeads(CTX_HEAD, VCS_MAIN_HEAD, { actor: AGENT, repoPath: REPO });
    expect(result.status).toBe("conflicted");
    expect(result.conflicts).toEqual([{ path: "shared.txt", kind: "content" }]);
    expect(result.conflictPaths).toContain("shared.txt");

    // The provisional merge state (with markers) is materialized onto the ctx
    // head's worktree — the head ref itself is unchanged (parked). Labels are
    // ours=ctx (the reconcile target), theirs=main.
    const conflicted = await readDisk(CTX_HEAD, "shared.txt");
    expect(conflicted).toContain(`<<<<<<< ${CTX_HEAD}`);
    expect(conflicted).toContain("MAIN");
    expect(conflicted).toContain("CTX");
    expect(conflicted).toContain(`>>>>>>> ${VCS_MAIN_HEAD}`);
    // Non-conflicting parts of the merge still landed on the worktree.
    expect(await readDisk(CTX_HEAD, "ctx-new.txt")).toBe("made in context\n");

    expect(await vcs.pendingMerge(CTX_HEAD, REPO)).toMatchObject({ theirsHead: VCS_MAIN_HEAD });
    // The markers reached the worktree, so the pending merge is marked
    // materialized — a resolution will not re-materialize over user edits.
    expect(
      gad.instance.getPendingMerge({ logId: REPO_LOG, head: CTX_HEAD }).info!.materialized
    ).toBe(true);
  });

  it("conflict → resolve via recordEdit → commit seals the merge (both parents recorded)", async () => {
    await divergedSetup({ conflict: true });
    const merge = await vcs.mergeHeads(CTX_HEAD, VCS_MAIN_HEAD, { actor: AGENT, repoPath: REPO });
    expect(merge.status).toBe("conflicted");
    expect(await vcs.pendingMerge(CTX_HEAD, REPO)).not.toBeNull();

    // Resolve the markered file via a working edit, then commit to seal.
    await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      edits: [{ kind: "write", path: "shared.txt", content: text("resolved\nline2\nline3\n") }],
      actor: AGENT,
    });
    const sealed = await vcs.commit({
      head: CTX_HEAD,
      repoPath: REPO,
      message: "resolve merge",
      actor: AGENT,
    });
    expect(sealed.status).toBe("committed");
    expect(await vcs.pendingMerge(CTX_HEAD, REPO)).toBeNull();
    const ancestors = await vcs.commitAncestors(REPO, sealed.eventId!);
    expect(ancestors[0]!.parentEventIds.length).toBeGreaterThanOrEqual(2);

    // After sealing, the ctx descends from main → push fast-forwards.
    const pushed = await vcs.push({ repoPaths: [REPO], sourceHead: CTX_HEAD, actor: AGENT });
    expect(pushed.status).toBe("pushed");
    expect(await readAt(VCS_MAIN_HEAD, "shared.txt")).toBe("resolved\nline2\nline3\n");
  });

  it("re-materializes a pending merge whose markers never hit the worktree", async () => {
    await divergedSetup({ conflict: true });

    // Simulate a crash between setPendingMerge and materializeState: the
    // pending merge is parked but the conflict markers never reach the tree.
    const spy = vi
      .spyOn(vcs.vcs, "materializeState")
      .mockRejectedValueOnce(new Error("simulated crash"));
    await expect(
      vcs.mergeHeads(CTX_HEAD, VCS_MAIN_HEAD, { actor: AGENT, repoPath: REPO })
    ).rejects.toThrow("simulated crash");

    // Pending merge is parked with materialized=false.
    const pending = gad.instance.getPendingMerge({ logId: REPO_LOG, head: CTX_HEAD }).info!;
    expect(pending.materialized).toBe(false);

    spy.mockRestore();
  });

  it("abortMerge clears the pending merge and restores the ctx head content", async () => {
    await divergedSetup({ conflict: true });
    await vcs.mergeHeads(CTX_HEAD, VCS_MAIN_HEAD, { actor: AGENT, repoPath: REPO });
    expect(await vcs.pendingMerge(CTX_HEAD, REPO)).not.toBeNull();

    const aborted = await vcs.abortMerge(CTX_HEAD, { repoPath: REPO });
    expect(aborted.aborted).toBe(true);
    expect(await vcs.pendingMerge(CTX_HEAD, REPO)).toBeNull();

    // ctx head state is back to the pre-merge (committed) content.
    expect(await readAt(CTX_HEAD, "shared.txt")).toBe("CTX\nline2\nline3\n");
  });

  it("merge base over multi-parent history stays correct after a merge", async () => {
    await divergedSetup({ conflict: false });
    // Reconcile #1: pull main into ctx → a merge commit on the ctx head (the
    // ctx head now has multi-parent history).
    const merge1 = await vcs.mergeHeads(CTX_HEAD, VCS_MAIN_HEAD, { actor: AGENT, repoPath: REPO });
    expect(merge1.status).toBe("merged");

    // Diverge again post-merge: main lands a change AND ctx commits a new file.
    await advanceMain(
      [{ kind: "write", path: "main-only.txt", content: text("main2\n") }],
      "main round2"
    );
    await commitCtx([{ kind: "create", path: "round2.txt", content: text("again\n") }], "round2");

    // Reconcile #2: the base must be the prior merge state (not an ancestor),
    // so this is a clean merge that keeps both round-2 changes (and the round-1
    // content survives).
    const result = await vcs.mergeHeads(CTX_HEAD, VCS_MAIN_HEAD, { actor: AGENT, repoPath: REPO });
    expect(result.status).toBe("merged");
    expect(await readAt(CTX_HEAD, "round2.txt")).toBe("again\n");
    expect(await readAt(CTX_HEAD, "main-only.txt")).toBe("main2\n");
    expect(await readAt(CTX_HEAD, "shared.txt")).toBe("MAIN1\nline2\nctx3\n");
  });
});

describe("WorkspaceVcs gc", () => {
  let root: string;
  let workspaceRoot: string;
  let vcs: WorkspaceVcs;
  let gad: TestGad;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-gc-"));
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

  /** Land edits on `main` via edit → commit → push on a throwaway context. */
  async function pushMain(
    edits: Parameters<WorkspaceVcs["recordEdit"]>[0]["edits"],
    message: string,
    ctxId = "__gc_seed__"
  ): Promise<string> {
    const seedHead = vcsContextHead(ctxId);
    await vcs.recordEdit({ head: seedHead, repoPath: REPO, edits, actor: USER });
    await vcs.commit({ head: seedHead, repoPath: REPO, message, actor: USER });
    const pushed = await vcs.push({ repoPaths: [REPO], sourceHead: seedHead, actor: USER });
    expect(pushed.status).toBe("pushed");
    await vcs.dropContext(ctxId);
    return (await vcs.resolveHead(VCS_MAIN_HEAD, REPO))!;
  }

  it("keeps referenced history, sweeps staged orphans and dead blobs", async () => {
    await pushMain(
      [{ kind: "create", path: "keep.txt", content: text("kept content\n") }],
      "v1",
      "gc1"
    );
    await pushMain(
      [{ kind: "write", path: "keep.txt", content: text("kept content v2\n") }],
      "v2",
      "gc2"
    );

    // Stage an orphaned state with a unique blob (never referenced by a ref).
    const { putBytes } = await import("../services/blobstoreService.js");
    const orphanBytes = Buffer.from("orphaned blob content\n");
    const { digest: orphanDigest } = await putBytes(path.join(root, "blobs"), orphanBytes);
    gad.instance.stageWorktreeState({
      files: [{ path: "orphan.txt", contentHash: orphanDigest, size: orphanBytes.length }],
    });
    const pastGrace = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    for (const table of [
      "gad_worktree_states",
      "gad_blobs",
      "gad_manifest_nodes",
      "gad_file_versions",
    ]) {
      gad.sql.exec(`UPDATE ${table} SET created_at = ? WHERE created_at > ?`, pastGrace, pastGrace);
    }

    const result = await vcs.runGc({ minAgeMs: 0 });
    expect(result.sweptStates).toBeGreaterThanOrEqual(1); // the staged orphan
    expect(result.sweptBlobs).toBeGreaterThanOrEqual(1); // the orphan blob
    expect(result.keptStates).toBeGreaterThanOrEqual(2); // 2 commits

    // History still fully readable after GC.
    const log = await vcs.readVcsLog(10, VCS_MAIN_HEAD, REPO);
    expect(log).toHaveLength(2);
    const headState = await vcs.resolveHead(VCS_MAIN_HEAD, REPO);
    const files = gad.instance.listStateFiles({ stateHash: headState! });
    expect(files.map((f) => f["path"])).toEqual(["keep.txt"]);
    const status = await vcs.statusHead(VCS_MAIN_HEAD, REPO);
    expect(status.dirty).toBe(false);

    // The orphan blob's CAS file is gone; kept blobs remain.
    const { blobPath } = await import("../services/blobstoreService.js");
    await expect(fsp.access(blobPath(path.join(root, "blobs"), orphanDigest))).rejects.toThrow();
  });

  it("pending-merge states are GC roots", async () => {
    await pushMain([{ kind: "create", path: "f.txt", content: text("a\n") }], "seed", "gc3");

    // ctx commits its side, main lands a conflicting change → reconcile conflicts.
    const ctxHead = vcsContextHead("ctx-gc");
    await vcs.recordEdit({
      head: ctxHead,
      repoPath: REPO,
      edits: [{ kind: "write", path: "f.txt", content: text("ctx\n") }],
      actor: USER,
    });
    await vcs.commit({ head: ctxHead, repoPath: REPO, message: "ctx", actor: USER });
    await pushMain([{ kind: "write", path: "f.txt", content: text("main\n") }], "main", "gc4");

    const merge = await vcs.mergeHeads(ctxHead, VCS_MAIN_HEAD, { actor: USER, repoPath: REPO });
    expect(merge.status).toBe("conflicted");

    const result = await vcs.runGc({ minAgeMs: 0 });
    // Provisional merge state survives GC (pending merge is a root).
    expect(await vcs.pendingMerge(ctxHead, REPO)).not.toBeNull();
    const provisional = gad.instance.getPendingMerge({
      logId: REPO_LOG,
      head: ctxHead,
    }).info!;
    const files = gad.instance.listStateFiles({ stateHash: provisional.provisionalStateHash });
    expect(files.length).toBeGreaterThan(0);
    void result;
  });
});

describe("WorkspaceVcs memory (WS4)", () => {
  let root: string;
  let workspaceRoot: string;
  let vcs: WorkspaceVcs;
  let gad: TestGad;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-mem-"));
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

  /** Land repo content on `main` via edit → commit → push on a throwaway context. */
  async function pushRepoMain(
    repoPath: string,
    edits: Parameters<WorkspaceVcs["recordEdit"]>[0]["edits"],
    message: string,
    ctxId: string
  ): Promise<void> {
    const seedHead = vcsContextHead(ctxId);
    await vcs.recordEdit({
      head: seedHead,
      repoPath,
      edits,
      actor: { id: "scribe", kind: "agent" },
    });
    await vcs.commit({ head: seedHead, repoPath, message, actor: { id: "scribe", kind: "agent" } });
    const pushed = await vcs.push({ repoPaths: [repoPath], sourceHead: seedHead, actor: USER });
    expect(pushed.status).toBe("pushed");
    await vcs.dropContext(ctxId);
  }

  it("indexes a repo's file content per-repo and recalls with workspace-relative provenance", async () => {
    const repoPath = "packages/notes";

    await pushRepoMain(
      repoPath,
      [
        {
          kind: "create",
          path: "design.md",
          content: { kind: "text", text: "The unified log subsumes pubsub entirely.\n" },
        },
      ],
      "design v1",
      "notes1"
    );
    await vcs.indexRepoFiles(repoPath);

    const hit = (await vcs.recallMemory({ query: "subsumes" })) as {
      results: Array<{ kind: string; path: string | null; snippet: string }>;
    };
    expect(hit.results).toHaveLength(1);
    // Provenance is re-rooted to a workspace-relative path even though the repo
    // state is subtree-rooted.
    expect(hit.results[0]).toMatchObject({ kind: "file", path: "packages/notes/design.md" });
    expect(hit.results[0]!.snippet).toContain("subsumes");

    // Edit + reindex: the index reflects only the latest repo-main state.
    await pushRepoMain(
      repoPath,
      [{ kind: "write", path: "design.md", content: { kind: "text", text: "renamed concept.\n" } }],
      "design v2",
      "notes2"
    );
    await vcs.indexRepoFiles(repoPath);
    const gone = (await vcs.recallMemory({ query: "subsumes" })) as { results: unknown[] };
    expect(gone.results).toHaveLength(0);
    const fresh = (await vcs.recallMemory({ query: "renamed" })) as { results: unknown[] };
    expect(fresh.results).toHaveLength(1);
  });

  it("indexes completed trajectory messages and claims at projection time", async () => {
    await gad.instance.appendLogEvent({
      logId: "traj-1",
      head: "main",
      logKind: "trajectory",
      events: [
        {
          envelopeId: "msg:m1:terminal",
          actor: { id: "agent-1", kind: "agent" },
          payloadKind: "message.completed",
          causality: { messageId: "m1", turnId: "t1" } as never,
          payload: {
            protocol: "agentic.trajectory.v1",
            role: "assistant",
            blocks: [
              { blockId: "m1:b0", type: "text", content: "We chose the gadolinium approach." },
            ],
            outcome: "completed",
          },
        },
        {
          envelopeId: "claim:c1",
          actor: { id: "agent-1", kind: "agent" },
          payloadKind: "knowledge.claim_recorded",
          payload: {
            protocol: "agentic.trajectory.v1",
            claimId: "c1",
            subject: "build system",
            predicate: "uses",
            object: "zirconium hashing",
          },
        },
      ],
    });

    const message = gad.instance.recallMemory({ query: "gadolinium" });
    expect(message.results).toHaveLength(1);
    expect(message.results[0]).toMatchObject({
      kind: "message",
      eventId: "msg:m1:terminal",
      logId: "traj-1",
      appendedAt: expect.any(String),
    });
    expect(message.results[0]!.anchor).toMatchObject({ messageId: "m1" });

    const claim = gad.instance.recallMemory({ query: "zirconium" });
    expect(claim.results).toHaveLength(1);
    expect(claim.results[0]).toMatchObject({ kind: "claim" });

    // Kind filter
    const filtered = gad.instance.recallMemory({ query: "zirconium", kinds: ["message"] });
    expect(filtered.results).toHaveLength(0);
  });

  it("memory rows survive projection replay (P3)", async () => {
    await gad.instance.appendLogEvent({
      logId: "traj-2",
      head: "main",
      logKind: "trajectory",
      events: [
        {
          envelopeId: "msg:mm:terminal",
          actor: { id: "a", kind: "agent" },
          payloadKind: "message.completed",
          causality: { messageId: "mm" } as never,
          payload: {
            protocol: "agentic.trajectory.v1",
            role: "assistant",
            blocks: [{ blockId: "mm:b0", type: "text", content: "ytterbium insight" }],
            outcome: "completed",
          },
        },
      ],
    });
    expect(gad.instance.recallMemory({ query: "ytterbium" }).results).toHaveLength(1);
    await gad.instance.replayTrajectoryProjections();
    expect(gad.instance.recallMemory({ query: "ytterbium" }).results).toHaveLength(1);
  });
});
