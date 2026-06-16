import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../../workspace/workers/gad-store/index.js";
import { WorkspaceVcs } from "./workspaceVcs.js";
import { vcsContextHead, type GadCaller } from "./store.js";

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

async function write(dir: string, rel: string, content: string): Promise<void> {
  const abs = path.join(dir, ...rel.split("/"));
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
}

async function read(dir: string, rel: string): Promise<string> {
  return await fsp.readFile(path.join(dir, ...rel.split("/")), "utf8");
}

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

  /** Set up: main with two files, fork ctx-1, diverge both sides. */
  async function divergedSetup(opts: { conflict: boolean }): Promise<{ ctxDir: string }> {
    await write(workspaceRoot, "shared.txt", "line1\nline2\nline3\n");
    await write(workspaceRoot, "main-only.txt", "main\n");
    await vcs.commit({ summary: "base" });

    const { dir: ctxDir } = await vcs.ensureContextFolder("ctx-1");
    // Context edits
    await write(
      ctxDir,
      "shared.txt",
      opts.conflict ? "CTX\nline2\nline3\n" : "line1\nline2\nctx3\n"
    );
    await write(ctxDir, "ctx-new.txt", "made in context\n");
    await vcs.commitContext("ctx-1", { summary: "ctx work" });

    // Main edits (different region unless conflict requested)
    await write(
      workspaceRoot,
      "shared.txt",
      opts.conflict ? "MAIN\nline2\nline3\n" : "MAIN1\nline2\nline3\n"
    );
    await vcs.commit({ summary: "main work" });
    return { ctxDir };
  }

  it("cleanly merges a diverged context back into main", async () => {
    await divergedSetup({ conflict: false });

    const result = await vcs.mergeHeads("main", vcsContextHead("ctx-1"));
    expect(result.status).toBe("merged");
    expect(result.conflicts).toEqual([]);

    // Working tree got both sides
    expect(await read(workspaceRoot, "shared.txt")).toBe("MAIN1\nline2\nctx3\n");
    expect(await read(workspaceRoot, "ctx-new.txt")).toBe("made in context\n");
    expect(await read(workspaceRoot, "main-only.txt")).toBe("main\n");

    // The merge is a multi-parent transition on the log
    const events = gad.instance.readLog({ logId: "vcs:workspace", head: "main", limit: 0 });
    const mergeEvent = events.find((e) => e.payloadKind === "state.merge_applied");
    expect(mergeEvent).toBeDefined();
    const payload = mergeEvent!.payload as { parentStateHashes?: string[] };
    expect(payload.parentStateHashes).toHaveLength(1);

    // Status is clean after the merge
    const status = await vcs.statusHead("main");
    expect(status.dirty).toBe(false);
  });

  it("rejects worktree-escaping edit paths at the applyEdits boundary", async () => {
    await write(workspaceRoot, "a.txt", "one\n");
    await vcs.commit({ summary: "base" });
    const head = await vcs.resolveHead("main");
    await expect(
      vcs.applyEdits({
        head: "main",
        baseStateHash: head!,
        edits: [{ kind: "write", path: "../escape.txt", content: { kind: "text", text: "pwn" } }],
        actor: { id: "u", kind: "user" },
      })
    ).rejects.toThrow(/escapes worktree/u);
    // The escaping write never landed on disk outside the worktree.
    await expect(fsp.access(path.join(root, "escape.txt"))).rejects.toThrow();
  });

  it("rejects edits that write platform-ignored paths (.env, .git/*, node_modules)", async () => {
    await write(workspaceRoot, "a.txt", "one\n");
    await vcs.commit({ summary: "base" });
    const head = await vcs.resolveHead("main");
    for (const bad of [
      ".env",
      ".git/hooks/pre-commit",
      "node_modules/x/index.js",
      ".gad/x",
      ".npmrc",
    ]) {
      await expect(
        vcs.applyEdits({
          head: "main",
          baseStateHash: head!,
          edits: [{ kind: "write", path: bad, content: { kind: "text", text: "x" } }],
          actor: { id: "u", kind: "user" },
        })
      ).rejects.toThrow(/platform-ignored/u);
    }
    // A normal path still applies cleanly.
    const ok = await vcs.applyEdits({
      head: "main",
      baseStateHash: head!,
      edits: [{ kind: "write", path: "src/ok.ts", content: { kind: "text", text: "y" } }],
      actor: { id: "u", kind: "user" },
    });
    expect(ok.status).toBe("clean");
  });

  it("runs the approval gate BEFORE materializing a conflicted publish onto main", async () => {
    // main and ctx both change the same line → the publish (ctx→main) conflicts.
    await write(workspaceRoot, "shared.txt", "base\n");
    await vcs.commit({ summary: "base" });
    const { dir: ctxDir } = await vcs.ensureContextFolder("ctx-pub");
    await write(ctxDir, "shared.txt", "CTX\n");
    await vcs.commitContext("ctx-pub", { summary: "ctx" });
    await write(workspaceRoot, "shared.txt", "MAIN\n");
    await vcs.commit({ summary: "main" });
    const mainBefore = await vcs.resolveHead("main");

    // A denied approval must prevent ANY conflict materialization / pending merge on main.
    await expect(
      vcs.mergeHeads("main", vcsContextHead("ctx-pub"), {
        beforeAdvance: () => {
          throw new Error("denied");
        },
      })
    ).rejects.toThrow("denied");

    expect(await vcs.resolveHead("main")).toBe(mainBefore);
    expect(await vcs.pendingMerge("main")).toBeNull();
    // No conflict markers or summary leaked onto the main worktree.
    expect(await read(workspaceRoot, "shared.txt")).toBe("MAIN\n");
    await expect(fsp.access(path.join(workspaceRoot, "MERGE_CONFLICTS.md"))).rejects.toThrow();
  });

  it("preserves an executable-bit set on one side while the other edits content", async () => {
    await write(workspaceRoot, "script.sh", "#!/bin/sh\necho one\n");
    await vcs.commit({ summary: "base" });

    const { dir: ctxDir } = await vcs.ensureContextFolder("ctx-mode");
    // Context only flips the exec bit; the content is unchanged.
    await fsp.chmod(path.join(ctxDir, "script.sh"), 0o755);
    await vcs.commitContext("ctx-mode", { summary: "chmod +x" });

    // Main edits the content (mode unchanged) so the merge hits the content arm.
    await write(workspaceRoot, "script.sh", "#!/bin/sh\necho two\n");
    await vcs.commit({ summary: "edit content" });

    const result = await vcs.mergeHeads("main", vcsContextHead("ctx-mode"));
    expect(result.status).toBe("merged");
    expect(result.conflicts).toEqual([]);
    // Content from main, exec bit from context — neither silently dropped.
    expect(await read(workspaceRoot, "script.sh")).toBe("#!/bin/sh\necho two\n");
    const stat = await fsp.stat(path.join(workspaceRoot, "script.sh"));
    expect(stat.mode & 0o111).not.toBe(0);
  });

  it("surfaces non-content conflicts via the worktree summary file (removed on resolve)", async () => {
    await write(workspaceRoot, "doc.txt", "original\n");
    await write(workspaceRoot, "keep.txt", "k\n");
    await vcs.commit({ summary: "base" });

    const { dir: ctxDir } = await vcs.ensureContextFolder("ctx-del");
    await fsp.rm(path.join(ctxDir, "doc.txt")); // context deletes doc.txt
    await write(ctxDir, "ctx.txt", "c\n");
    await vcs.commitContext("ctx-del", { summary: "delete doc" });

    await write(workspaceRoot, "doc.txt", "changed on main\n"); // main changes it
    await vcs.commit({ summary: "edit doc" });

    const result = await vcs.mergeHeads("main", vcsContextHead("ctx-del"));
    expect(result.status).toBe("conflicted");
    expect(
      result.conflicts.some((c) => c.kind === "delete-vs-change" && c.path === "doc.txt")
    ).toBe(true);

    // The non-content conflict (no in-file markers exist for it) is visible in
    // the worktree summary file.
    const summary = await read(workspaceRoot, "MERGE_CONFLICTS.md");
    expect(summary).toContain("delete-vs-change");
    expect(summary).toContain("doc.txt");

    // Resolving + committing removes the summary and never commits it.
    await vcs.commit({ summary: "resolve" });
    await expect(fsp.access(path.join(workspaceRoot, "MERGE_CONFLICTS.md"))).rejects.toThrow();
    const head = await vcs.resolveHead("main");
    const files = gad.instance.listStateFiles({ stateHash: head! });
    expect(files.map((f) => f["path"])).not.toContain("MERGE_CONFLICTS.md");
  });

  it("removes the conflict summary file when a merge is aborted", async () => {
    await divergedSetup({ conflict: true });
    const result = await vcs.mergeHeads("main", vcsContextHead("ctx-1"));
    expect(result.status).toBe("conflicted");
    expect(await read(workspaceRoot, "MERGE_CONFLICTS.md")).toContain("content");

    await vcs.abortMerge("main");
    await expect(fsp.access(path.join(workspaceRoot, "MERGE_CONFLICTS.md"))).rejects.toThrow();
  });

  it("does not snapshot dirty main before approval", async () => {
    await write(workspaceRoot, "shared.txt", "base\n");
    await vcs.commit({ summary: "base" });
    const before = await vcs.resolveHead("main");
    const { dir: ctxDir } = await vcs.ensureContextFolder("ctx-denied");
    await write(ctxDir, "ctx.txt", "ctx\n");
    await vcs.commitContext("ctx-denied", { summary: "ctx work" });
    await write(workspaceRoot, "main-dirty.txt", "unapproved\n");

    await expect(
      vcs.mergeHeads("main", vcsContextHead("ctx-denied"), {
        beforeAdvance: () => {
          throw new Error("denied");
        },
      })
    ).rejects.toThrow("denied");

    expect(await vcs.resolveHead("main")).toBe(before);
    expect(await read(workspaceRoot, "main-dirty.txt")).toBe("unapproved\n");
    const events = gad.instance.readLog({ logId: "vcs:workspace", head: "main", limit: 0 });
    expect(events.map((event) => event.payloadKind)).toEqual(["state.snapshot_ingested"]);
  });

  it("fast-forwards main into an unchanged context", async () => {
    await write(workspaceRoot, "a.txt", "one\n");
    await vcs.commit({ summary: "base" });
    const { dir: ctxDir } = await vcs.ensureContextFolder("ctx-2");

    await write(workspaceRoot, "a.txt", "one\ntwo\n");
    await vcs.commit({ summary: "main advance" });

    const result = await vcs.mergeHeads(vcsContextHead("ctx-2"), "main");
    expect(result.status).toBe("merged");
    expect(await read(ctxDir, "a.txt")).toBe("one\ntwo\n");
  });

  it("reports up-to-date when there is nothing to merge", async () => {
    await write(workspaceRoot, "a.txt", "one\n");
    await vcs.commit({ summary: "base" });
    await vcs.ensureContextFolder("ctx-3");

    const result = await vcs.mergeHeads("main", vcsContextHead("ctx-3"));
    expect(result.status).toBe("up-to-date");
  });

  it("conflicted merge: markers, pending merge, resolve by commit", async () => {
    await divergedSetup({ conflict: true });

    const result = await vcs.mergeHeads("main", vcsContextHead("ctx-1"));
    expect(result.status).toBe("conflicted");
    expect(result.conflicts).toEqual([{ path: "shared.txt", kind: "content" }]);

    const conflicted = await read(workspaceRoot, "shared.txt");
    expect(conflicted).toContain("<<<<<<< main");
    expect(conflicted).toContain("MAIN");
    expect(conflicted).toContain("CTX");
    expect(conflicted).toContain(">>>>>>> ctx:ctx-1");
    // Non-conflicting parts of the merge still landed
    expect(await read(workspaceRoot, "ctx-new.txt")).toBe("made in context\n");

    expect(await vcs.pendingMerge("main")).toMatchObject({ theirsHead: "ctx:ctx-1" });
    // The markers reached the worktree, so the pending merge is marked
    // materialized — commit will not re-materialize over user edits.
    expect(
      gad.instance.getPendingMerge({ logId: "vcs:workspace", head: "main" }).info!.materialized
    ).toBe(true);

    // Resolve and commit — becomes the merge transition
    await write(workspaceRoot, "shared.txt", "RESOLVED\nline2\nline3\n");
    const commit = await vcs.commit({ summary: "resolve merge" });
    expect(commit.unchanged).toBe(false);
    expect(await vcs.pendingMerge("main")).toBeNull();

    const events = gad.instance.readLog({ logId: "vcs:workspace", head: "main", limit: 0 });
    const mergeEvents = events.filter((e) => e.payloadKind === "state.merge_applied");
    expect(mergeEvents).toHaveLength(1);
    const payload = mergeEvents[0]!.payload as { parentStateHashes?: string[] };
    expect(payload.parentStateHashes).toHaveLength(1);
  });

  it("re-materializes a pending merge whose markers never hit the worktree", async () => {
    await divergedSetup({ conflict: true });

    // Simulate a crash between setPendingMerge and materializeState: the
    // pending merge is parked but the conflict markers never reach the tree.
    const spy = vi
      .spyOn(vcs.vcs, "materializeState")
      .mockRejectedValueOnce(new Error("simulated crash"));
    await expect(vcs.mergeHeads("main", vcsContextHead("ctx-1"))).rejects.toThrow(
      "simulated crash"
    );

    // Worktree still shows the pre-merge content; pending merge is parked
    // with materialized=false.
    expect(await read(workspaceRoot, "shared.txt")).toBe("MAIN\nline2\nline3\n");
    const pending = gad.instance.getPendingMerge({ logId: "vcs:workspace", head: "main" }).info!;
    expect(pending.materialized).toBe(false);

    // The next commit re-materializes the provisional tree before recording
    // the resolution — the source side's changes are not silently dropped.
    const commit = await vcs.commit({ summary: "commit after crash" });
    expect(commit.unchanged).toBe(false);

    const shared = await read(workspaceRoot, "shared.txt");
    expect(shared).toContain("<<<<<<< main");
    expect(shared).toContain("CTX");
    expect(await read(workspaceRoot, "ctx-new.txt")).toBe("made in context\n");
    expect(await vcs.pendingMerge("main")).toBeNull();

    const events = gad.instance.readLog({ logId: "vcs:workspace", head: "main", limit: 0 });
    expect(events.filter((e) => e.payloadKind === "state.merge_applied")).toHaveLength(1);

    spy.mockRestore();
  });

  it("abortMerge restores the pre-merge tree", async () => {
    await divergedSetup({ conflict: true });
    await vcs.mergeHeads("main", vcsContextHead("ctx-1"));
    expect(await read(workspaceRoot, "shared.txt")).toContain("<<<<<<<");

    const aborted = await vcs.abortMerge("main");
    expect(aborted.aborted).toBe(true);
    expect(await read(workspaceRoot, "shared.txt")).toBe("MAIN\nline2\nline3\n");
    expect(await vcs.pendingMerge("main")).toBeNull();

    // Tree is clean against the ref again
    const status = await vcs.statusHead("main");
    expect(status.dirty).toBe(false);
  });

  it("merge base over multi-parent history stays correct after a merge", async () => {
    await divergedSetup({ conflict: false });
    await vcs.mergeHeads("main", vcsContextHead("ctx-1"));

    // Diverge again post-merge and merge again — base must be the merge state.
    const ctxDir = path.join(root, ".contexts", "ctx-1");
    await vcs.mergeHeads(vcsContextHead("ctx-1"), "main"); // sync ctx up to main
    await write(ctxDir, "round2.txt", "again\n");
    await vcs.commitContext("ctx-1", { summary: "round 2" });

    const result = await vcs.mergeHeads("main", vcsContextHead("ctx-1"));
    expect(result.status).toBe("merged");
    expect(await read(workspaceRoot, "round2.txt")).toBe("again\n");
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

  it("keeps referenced history, sweeps staged orphans and dead blobs", async () => {
    await write(workspaceRoot, "keep.txt", "kept content\n");
    await vcs.commit({ summary: "base" });
    await write(workspaceRoot, "keep.txt", "kept content v2\n");
    await vcs.commit({ summary: "edit" });

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
    expect(result.keptStates).toBeGreaterThanOrEqual(3); // empty + 2 commits

    // History still fully readable after GC.
    const log = await vcs.readVcsLog(10);
    expect(log).toHaveLength(2);
    const headState = await vcs.resolveHead("main");
    const files = gad.instance.listStateFiles({ stateHash: headState! });
    expect(files.map((f) => f["path"])).toEqual(["keep.txt"]);
    // Both content versions retained (history ancestry).
    const status = await vcs.statusHead("main");
    expect(status.dirty).toBe(false);

    // The orphan blob's CAS file is gone; kept blobs remain.
    const { blobPath } = await import("../services/blobstoreService.js");
    await expect(fsp.access(blobPath(path.join(root, "blobs"), orphanDigest))).rejects.toThrow();
  });

  it("pending-merge states are GC roots", async () => {
    await write(workspaceRoot, "f.txt", "a\n");
    await vcs.commit({ summary: "base" });
    await vcs.ensureContextFolder("ctx-gc");
    const ctxDir = path.join(root, ".contexts", "ctx-gc");
    await write(ctxDir, "f.txt", "ctx\n");
    await vcs.commitContext("ctx-gc", { summary: "ctx" });
    await write(workspaceRoot, "f.txt", "main\n");
    await vcs.commit({ summary: "main" });

    const merge = await vcs.mergeHeads("main", vcsContextHead("ctx-gc"));
    expect(merge.status).toBe("conflicted");

    const result = await vcs.runGc({ minAgeMs: 0 });
    // Provisional merge state survives GC (pending merge is a root).
    expect(await vcs.pendingMerge("main")).not.toBeNull();
    const provisional = gad.instance.getPendingMerge({
      logId: "vcs:workspace",
      head: "main",
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

  it("indexes committed file content incrementally and recalls with provenance", async () => {
    await write(workspaceRoot, "notes/design.md", "The unified log subsumes pubsub entirely.\n");
    await write(workspaceRoot, "src/code.ts", "export const flagrantToken = 42;\n");
    const first = await vcs.commit({ summary: "base" });
    await vcs.indexMainFiles(first.stateHash);

    const hit = (await vcs.recallMemory({ query: "flagrantToken" })) as {
      results: Array<{ kind: string; path: string | null; snippet: string }>;
    };
    expect(hit.results).toHaveLength(1);
    expect(hit.results[0]).toMatchObject({ kind: "file", path: "src/code.ts" });
    expect(hit.results[0]!.snippet).toContain("flagrantToken");

    // Edit + delete; index reflects only the latest state.
    await write(workspaceRoot, "src/code.ts", "export const renamedToken = 42;\n");
    await fsp.rm(path.join(workspaceRoot, "notes", "design.md"));
    const second = await vcs.commit({ summary: "edit" });
    await vcs.indexMainFiles(second.stateHash);

    const stale = (await vcs.recallMemory({ query: "flagrantToken" })) as { results: unknown[] };
    expect(stale.results).toHaveLength(0);
    const gone = (await vcs.recallMemory({ query: "subsumes" })) as { results: unknown[] };
    expect(gone.results).toHaveLength(0);
    const fresh = (await vcs.recallMemory({ query: "renamedToken" })) as { results: unknown[] };
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
