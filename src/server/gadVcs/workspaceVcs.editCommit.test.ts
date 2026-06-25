/**
 * Verification of the edit → commit → push re-architecture (§11):
 *   - vcs.edit records UNCOMMITTED working edit-ops (provenance, projection) but
 *     does NOT advance the commit head, appear in vcs.log, or emit state-advanced.
 *   - vcs.commit folds them into a deliberate snapshot, claiming the edits
 *     (queryable both ways), honoring `exclude`, requiring a message.
 *   - push is fast-forward-only: rejects on uncommitted edits AND on divergence
 *     (structured error); reconcile with an explicit vcs.merge.
 *   - traversability (commitEdits / fileHistory / listWorkingEdits / commitAncestors).
 *   - discardEdits drops working edits (+ pending merge).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../../workspace/workers/gad-store/index.js";
import { WorkspaceVcs } from "./workspaceVcs.js";
import { VCS_MAIN_HEAD, logIdForRepo, vcsContextHead, type GadCaller } from "./store.js";
import type { StateAdvancedEvent, WorkingAdvancedEvent } from "../buildV2/stateTrigger.js";

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
const REPO = "packages/edits";
const CTX = "work";
const CTX_HEAD = vcsContextHead(CTX);

describe("WorkspaceVcs edit → commit → push", () => {
  let root: string;
  let workspaceRoot: string;
  let vcs: WorkspaceVcs;
  let gad: TestGad;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-ec-"));
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

  /** Seed a repo's `main` via the real flow (edit → commit → push on a throwaway
   *  context), then drop the seeding context. Returns main's state hash. */
  async function seedMain(
    repo: string,
    edits: Parameters<WorkspaceVcs["recordEdit"]>[0]["edits"]
  ): Promise<string> {
    const seedHead = vcsContextHead("__seed__");
    await vcs.recordEdit({ head: seedHead, repoPath: repo, edits, actor: USER });
    await vcs.commit({ head: seedHead, repoPath: repo, message: "seed", actor: USER });
    const pushed = await vcs.push({ repoPaths: [repo], sourceHead: seedHead, actor: USER });
    expect(pushed.status).toBe("pushed");
    await vcs.dropContext("__seed__");
    const main = await vcs.resolveHead(VCS_MAIN_HEAD, repo);
    if (!main) throw new Error("seedMain: main not created");
    return main;
  }

  async function workingRows(head: string, repo = REPO) {
    return gad.instance.listWorkingEdits({ logId: logIdForRepo(repo), head });
  }

  it("edit records uncommitted ops without advancing the commit head, log, or state-advanced", async () => {
    await seedMain(REPO, [{ kind: "create", path: "a.txt", content: text("alpha\n") }]);
    const mainBefore = await vcs.resolveHead(VCS_MAIN_HEAD, REPO);
    const stateEvents: StateAdvancedEvent[] = [];
    const workingEvents: WorkingAdvancedEvent[] = [];
    const offS = vcs.onStateAdvanced((e) => stateEvents.push(e));
    const offW = vcs.onWorkingAdvanced((e) => workingEvents.push(e));

    const res = await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "write", path: "a.txt", content: text("ALPHA\n") }],
    });

    expect(res.committed).toBe(false);
    expect(res.status).toBe("uncommitted");
    // No ctx commit head was created (edit does not lazy-fork; commit does).
    expect(await vcs.resolveHead(CTX_HEAD, REPO)).toBeNull();
    // No vcs.log entry on the ctx head.
    expect(await vcs.readVcsLog(50, CTX_HEAD, REPO)).toHaveLength(0);
    // state-advanced NOT emitted; working-advanced IS.
    expect(stateEvents).toHaveLength(0);
    expect(workingEvents).toHaveLength(1);
    expect(workingEvents[0]!.changedPaths).toEqual([`${REPO}/a.txt`]);
    // One uncommitted edit-op row, output_state_hash NULL, committed_event_id NULL.
    const rows = await workingRows(CTX_HEAD);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["committed_event_id"]).toBeNull();
    expect(rows[0]!["output_state_hash"]).toBeNull();
    expect(rows[0]!["actor_id"]).toBe("scribe");
    // main untouched.
    expect(await vcs.resolveHead(VCS_MAIN_HEAD, REPO)).toBe(mainBefore);
    // Working content is materialized to disk.
    const onDisk = await fsp.readFile(path.join(root, ".contexts", CTX, REPO, "a.txt"), "utf8");
    expect(onDisk).toBe("ALPHA\n");
    offS();
    offW();
  });

  it("rejects recordEdit when baseStateHash no longer matches the composed working state", async () => {
    await seedMain(REPO, [
      { kind: "create", path: "a.txt", content: text("alpha\n") },
      { kind: "create", path: "b.txt", content: text("bravo\n") },
    ]);
    const base = await vcs.readFile(VCS_MAIN_HEAD, "a.txt", REPO);
    expect(base?.stateHash).toBeTruthy();

    await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "write", path: "b.txt", content: text("changed\n") }],
    });

    await expect(
      vcs.recordEdit({
        head: CTX_HEAD,
        repoPath: REPO,
        actor: AGENT,
        baseStateHash: base!.stateHash,
        edits: [{ kind: "write", path: "a.txt", content: text("also changed\n") }],
      })
    ).rejects.toThrow(/edit CAS conflict/);
  });

  it("a non-applying replace is a plain error (edit never merges)", async () => {
    await seedMain(REPO, [{ kind: "create", path: "a.txt", content: text("alpha\n") }]);
    await expect(
      vcs.recordEdit({
        head: CTX_HEAD,
        repoPath: REPO,
        actor: AGENT,
        edits: [
          { kind: "replace", path: "missing.txt", hunks: [{ start: 0, end: 0, newText: "x" }] },
        ],
      })
    ).rejects.toThrow(/no such path/);
  });

  it("first edit (no ctx head) composes over the pinned base / main", async () => {
    await seedMain(REPO, [{ kind: "create", path: "a.txt", content: text("alpha\n") }]);
    await vcs.pinContext(CTX); // pin the base view
    const res = await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "write", path: "a.txt", content: text("from-ctx\n") }],
    });
    expect(res.status).toBe("uncommitted");
    // The ctx head is still uncreated; the edit persisted over the base.
    expect(await vcs.resolveHead(CTX_HEAD, REPO)).toBeNull();
    expect(await workingRows(CTX_HEAD)).toHaveLength(1);
  });

  it("commit folds edits into a snapshot, claims them (queryable both ways), requires a message", async () => {
    await seedMain(REPO, [{ kind: "create", path: "a.txt", content: text("alpha\n") }]);
    await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "write", path: "a.txt", content: text("ALPHA\n") }],
    });

    await expect(
      vcs.commit({ head: CTX_HEAD, repoPath: REPO, message: "  ", actor: AGENT })
    ).rejects.toThrow(/message/);

    const events: StateAdvancedEvent[] = [];
    const off = vcs.onStateAdvanced((e) => events.push(e));
    const result = await vcs.commit({
      head: CTX_HEAD,
      repoPath: REPO,
      message: "uppercase a",
      actor: AGENT,
    });
    off();

    expect(result.status).toBe("committed");
    expect(result.editCount).toBe(1);
    // commit emits state-advanced (snapshot), advancing the ctx head.
    expect(events.some((e) => e.transitionKind === "snapshot")).toBe(true);
    expect(await vcs.resolveHead(CTX_HEAD, REPO)).toBe(result.stateHash);
    // commit appears in vcs.log now.
    const log = await vcs.readVcsLog(50, CTX_HEAD, REPO);
    expect(log.length).toBeGreaterThanOrEqual(1);
    // No uncommitted rows remain.
    expect(await workingRows(CTX_HEAD)).toHaveLength(0);
    // commit → edits (no DUPLICATE rows — re-keyed, not re-inserted).
    const edits = await vcs.listCommitEdits(REPO, result.eventId!);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.committedEventId).toBe(result.eventId);
    expect(edits[0]!.outputStateHash).toBe(result.stateHash);
  });

  it("commit({exclude}) leaves excluded files' edits uncommitted", async () => {
    await seedMain(REPO, [
      { kind: "create", path: "a.txt", content: text("a\n") },
      { kind: "create", path: "b.txt", content: text("b\n") },
    ]);
    await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      actor: AGENT,
      edits: [
        { kind: "write", path: "a.txt", content: text("A\n") },
        { kind: "write", path: "b.txt", content: text("B\n") },
      ],
    });
    const result = await vcs.commit({
      head: CTX_HEAD,
      repoPath: REPO,
      message: "only a",
      exclude: ["b.txt"],
      actor: AGENT,
    });
    expect(result.editCount).toBe(1);
    // b's edit stays uncommitted.
    const remaining = await workingRows(CTX_HEAD);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!["path"]).toBe("b.txt");
    // Committed head has A but NOT B.
    const a = await vcs.readFile(CTX_HEAD, "a.txt", REPO);
    expect(a?.content).toEqual(text("A\n"));
  });

  it("commit with no included edits and no pending merge is unchanged", async () => {
    await seedMain(REPO, [{ kind: "create", path: "a.txt", content: text("a\n") }]);
    const result = await vcs.commit({
      head: CTX_HEAD,
      repoPath: REPO,
      message: "noop",
      actor: AGENT,
    });
    expect(result.status).toBe("unchanged");
    expect(result.editCount).toBe(0);
  });

  it("rejects edit and commit on a main head", async () => {
    await seedMain(REPO, [{ kind: "create", path: "a.txt", content: text("a\n") }]);
    await expect(
      vcs.recordEdit({
        head: VCS_MAIN_HEAD,
        repoPath: REPO,
        actor: USER,
        edits: [{ kind: "write", path: "a.txt", content: text("x\n") }],
      })
    ).rejects.toThrow(/main advances only via push/);
    await expect(
      vcs.commit({ head: VCS_MAIN_HEAD, repoPath: REPO, message: "x", actor: USER })
    ).rejects.toThrow(/main advances only via push/);
  });

  it("discardEdits drops uncommitted edits and restores the committed head on disk", async () => {
    await seedMain(REPO, [{ kind: "create", path: "a.txt", content: text("alpha\n") }]);
    await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "write", path: "a.txt", content: text("CHANGED\n") }],
    });
    expect(await workingRows(CTX_HEAD)).toHaveLength(1);
    const { discarded } = await vcs.discardEdits({ head: CTX_HEAD, repoPath: REPO });
    expect(discarded).toBe(1);
    expect(await workingRows(CTX_HEAD)).toHaveLength(0);
  });

  it("fs-style whole-file write over existing text records hunk-level provenance", async () => {
    await seedMain(REPO, [{ kind: "create", path: "a.txt", content: text("one\ntwo\nthree\n") }]);
    await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "write", path: "a.txt", content: text("one\nTWO\nthree\n") }],
    });
    const rows = await workingRows(CTX_HEAD);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["hunks_json"]).not.toBeNull(); // hunk-level, not a bare whole-file write
  });

  it("push fast-forwards when main is unchanged", async () => {
    await seedMain(REPO, [{ kind: "create", path: "a.txt", content: text("a\n") }]);
    await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "write", path: "a.txt", content: text("A\n") }],
    });
    await vcs.commit({ head: CTX_HEAD, repoPath: REPO, message: "edit a", actor: AGENT });
    const pushed = await vcs.push({ repoPaths: [REPO], sourceHead: CTX_HEAD, actor: AGENT });
    expect(pushed.status).toBe("pushed");
    const main = await vcs.readFile(VCS_MAIN_HEAD, "a.txt", REPO);
    expect(main?.content).toEqual(text("A\n"));
  });

  it("push rejects on uncommitted edits", async () => {
    await seedMain(REPO, [{ kind: "create", path: "a.txt", content: text("a\n") }]);
    await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "write", path: "a.txt", content: text("A\n") }],
    });
    await expect(
      vcs.push({ repoPaths: [REPO], sourceHead: CTX_HEAD, actor: AGENT })
    ).rejects.toThrow(/uncommitted edits/);
  });

  it("push rejects with a structured divergence error; vcs.merge reconciles → push fast-forwards", async () => {
    await seedMain(REPO, [{ kind: "create", path: "a.txt", content: text("base\n") }]);
    // Context edits + commits a.txt.
    await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "write", path: "a.txt", content: text("ctx\n") }],
    });
    await vcs.commit({ head: CTX_HEAD, repoPath: REPO, message: "ctx edit", actor: AGENT });
    // Concurrently, main advances on a DIFFERENT file (clean-mergeable).
    const otherCtx = vcsContextHead("other");
    await vcs.recordEdit({
      head: otherCtx,
      repoPath: REPO,
      actor: USER,
      edits: [{ kind: "create", path: "b.txt", content: text("upstream\n") }],
    });
    await vcs.commit({ head: otherCtx, repoPath: REPO, message: "upstream b", actor: USER });
    expect((await vcs.push({ repoPaths: [REPO], sourceHead: otherCtx, actor: USER })).status).toBe(
      "pushed"
    );

    // Now the original context's push diverges (main advanced past its base).
    const diverged = await vcs.push({ repoPaths: [REPO], sourceHead: CTX_HEAD, actor: AGENT });
    expect(diverged.status).toBe("diverged");
    if (diverged.status === "diverged") {
      expect(diverged.divergences).toHaveLength(1);
      expect(diverged.divergences[0]!.mergeable).toBe("clean");
      expect(diverged.divergences[0]!.upstreamCommits.length).toBeGreaterThanOrEqual(1);
    }

    // Reconcile with an explicit merge (clean → a merge commit, no resolution).
    const merge = await vcs.mergeHeads(CTX_HEAD, VCS_MAIN_HEAD, { actor: AGENT, repoPath: REPO });
    expect(merge.status).toBe("merged");
    expect(merge.mergeable).toBe("clean");

    // Push now fast-forwards.
    const pushed = await vcs.push({ repoPaths: [REPO], sourceHead: CTX_HEAD, actor: AGENT });
    expect(pushed.status).toBe("pushed");
    // main has both the ctx edit and the upstream file.
    expect((await vcs.readFile(VCS_MAIN_HEAD, "a.txt", REPO))?.content).toEqual(text("ctx\n"));
    expect((await vcs.readFile(VCS_MAIN_HEAD, "b.txt", REPO))?.content).toEqual(text("upstream\n"));
  });

  it("vcs.merge conflict parks a pending merge; resolve via edit → commit seals it", async () => {
    await seedMain(REPO, [{ kind: "create", path: "a.txt", content: text("base\n") }]);
    // ctx edits a.txt line.
    await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "write", path: "a.txt", content: text("ctx-change\n") }],
    });
    await vcs.commit({ head: CTX_HEAD, repoPath: REPO, message: "ctx", actor: AGENT });
    // main edits the SAME line differently.
    const otherCtx = vcsContextHead("other");
    await vcs.recordEdit({
      head: otherCtx,
      repoPath: REPO,
      actor: USER,
      edits: [{ kind: "write", path: "a.txt", content: text("main-change\n") }],
    });
    await vcs.commit({ head: otherCtx, repoPath: REPO, message: "main", actor: USER });
    await vcs.push({ repoPaths: [REPO], sourceHead: otherCtx, actor: USER });

    const merge = await vcs.mergeHeads(CTX_HEAD, VCS_MAIN_HEAD, { actor: AGENT, repoPath: REPO });
    expect(merge.status).toBe("conflicted");
    expect(merge.mergeable).toBe("conflict");
    expect(merge.conflictPaths).toContain("a.txt");
    // A pending merge is parked.
    const pending = await vcs.pendingMerge(CTX_HEAD, REPO);
    expect(pending).not.toBeNull();
    // Resolve via a working edit then commit (consumes the pending → merge commit).
    await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "write", path: "a.txt", content: text("resolved\n") }],
    });
    const sealed = await vcs.commit({
      head: CTX_HEAD,
      repoPath: REPO,
      message: "resolve merge",
      actor: AGENT,
    });
    expect(sealed.status).toBe("committed");
    // The pending is gone; the commit is a merge (two parents recorded).
    expect(await vcs.pendingMerge(CTX_HEAD, REPO)).toBeNull();
    const ancestors = await vcs.commitAncestors(REPO, sealed.eventId!);
    expect(ancestors[0]!.parentEventIds.length).toBeGreaterThanOrEqual(2);
  });

  it("fileHistory returns a path's edits in commit-lineage order", async () => {
    await seedMain(REPO, [{ kind: "create", path: "a.txt", content: text("v1\n") }]);
    await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "write", path: "a.txt", content: text("v2\n") }],
    });
    await vcs.commit({ head: CTX_HEAD, repoPath: REPO, message: "v2", actor: AGENT });
    const mainHistory = await vcs.fileHistory(REPO, "a.txt", VCS_MAIN_HEAD);
    expect(mainHistory).toHaveLength(1);
    expect(mainHistory[0]!.newContentHash).toBeTruthy();

    const ctxHistory = await vcs.fileHistory(REPO, "a.txt", CTX_HEAD);
    // Seed create + the ctx commit, all committed and only from this lineage.
    expect(ctxHistory.length).toBeGreaterThanOrEqual(2);
    expect(ctxHistory.every((h) => h.committedEventId !== null)).toBe(true);
  });

  it("links edits to their authoring agent invocation (preserved through commit; turn via traversal)", async () => {
    await seedMain(REPO, [{ kind: "create", path: "a.txt", content: text("base\n") }]);
    const INVOCATION = "toolu_test_abc";
    await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      actor: AGENT,
      invocationId: INVOCATION,
      edits: [{ kind: "write", path: "a.txt", content: text("edited\n") }],
    });
    // The edit-op row carries the authoring tool-call (the trajectory edge).
    const rows = await workingRows(CTX_HEAD);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["invocation_id"]).toBe(INVOCATION);
    // edit → invocation.
    const byInvoc = await gad.instance.editsByInvocation({ invocationId: INVOCATION });
    expect(byInvoc.map((r) => String(r["path"]))).toContain("a.txt");
    // commit preserves the invocation edge (re-key does not clobber it).
    const committed = await vcs.commit({
      head: CTX_HEAD,
      repoPath: REPO,
      message: "edit a",
      actor: AGENT,
    });
    const claimed = await vcs.listCommitEdits(REPO, committed.eventId!);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.invocationId).toBe(INVOCATION);
    // turn is reached by TRAVERSAL: seed the invocation→turn mapping in the
    // trajectory projection, then editsByTurn joins through it.
    const TURN = "t:chan:trigger:agent";
    (
      gad.instance as unknown as { sql: { exec(sql: string, ...bindings: unknown[]): unknown } }
    ).sql.exec(
      `INSERT INTO trajectory_invocations (log_id, head, invocation_id, turn_id, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      "vcs:trajectory:agent",
      "main",
      INVOCATION,
      TURN,
      "completed",
      new Date(0).toISOString()
    );
    const byTurn = await gad.instance.editsByTurn({ turnId: TURN });
    expect(byTurn.some((r) => r["invocation_id"] === INVOCATION)).toBe(true);
  });

  it("commitAncestors keys on event_id — distinguishes two commits with an identical state", async () => {
    await seedMain(REPO, [{ kind: "create", path: "a.txt", content: text("base\n") }]);
    // Two independent contexts commit byte-identical content off the same base →
    // the same content-addressed state, but distinct commit EVENTS.
    const headA = vcsContextHead("ca");
    const headB = vcsContextHead("cb");
    await vcs.recordEdit({
      head: headA,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "write", path: "a.txt", content: text("same\n") }],
    });
    const cA = await vcs.commit({ head: headA, repoPath: REPO, message: "a", actor: AGENT });
    await vcs.recordEdit({
      head: headB,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "write", path: "a.txt", content: text("same\n") }],
    });
    const cB = await vcs.commit({ head: headB, repoPath: REPO, message: "b", actor: AGENT });

    expect(cA.stateHash).toBe(cB.stateHash); // identical content → same state hash
    expect(cA.eventId).not.toBe(cB.eventId); // but distinct commit events
    // commitAncestors resolves each by its OWN event id, NOT conflated by state.
    const ancA = await vcs.commitAncestors(REPO, cA.eventId!);
    const ancB = await vcs.commitAncestors(REPO, cB.eventId!);
    expect(ancA[0]!.eventId).toBe(cA.eventId);
    expect(ancB[0]!.eventId).toBe(cB.eventId);
    expect(ancA[0]!.stateHash).toBe(ancB[0]!.stateHash); // same content state

    await vcs.recordEdit({
      head: headA,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "write", path: "a.txt", content: text("after-a\n") }],
    });
    const cA2 = await vcs.commit({
      head: headA,
      repoPath: REPO,
      message: "after a",
      actor: AGENT,
    });
    const ancA2 = await vcs.commitAncestors(REPO, cA2.eventId!);
    expect(ancA2[0]!.parentEventIds[0]).toBe(cA.eventId);
    expect(ancA2[0]!.parentEventIds[0]).not.toBe(cB.eventId);
  });

  it("previewBuild builds the context's WORKING content via the preview path, scoped, without advancing or touching the baseline", async () => {
    await seedMain(REPO, [{ kind: "create", path: "a.txt", content: text("base\n") }]);
    await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "write", path: "a.txt", content: text("preview\n") }],
    });
    const calls: Array<{ method: string; workingView?: string; repoPaths?: string[] }> = [];
    const buildSystem = {
      validateRepoPush: async () => {
        calls.push({ method: "validateRepoPush" });
        return [];
      },
      previewBuild: async (
        workingView: string,
        opts?: { repoPaths?: string[]; units?: string[] }
      ) => {
        calls.push({ method: "previewBuild", workingView, repoPaths: opts?.repoPaths });
        return [];
      },
    };
    const stateEvents: StateAdvancedEvent[] = [];
    const off = vcs.onStateAdvanced((e) => stateEvents.push(e));
    const mainBefore = await vcs.resolveHead(VCS_MAIN_HEAD, REPO);
    const reports = await vcs.previewBuild({
      head: CTX_HEAD,
      repoPaths: [REPO],
      getBuildSystem: () => buildSystem,
    });
    off();
    // Used the PREVIEW path (not the push build-gate).
    expect(calls.map((c) => c.method)).toEqual(["previewBuild"]);
    // Built from the context's WORKING composed view, scoped to the repo.
    expect(calls[0]!.workingView).toBe(await vcs.resolveContextView(CTX));
    expect(calls[0]!.repoPaths).toEqual([REPO]);
    // No commit-head / main advance — preview never advances or touches the
    // published EV baseline (which only updates on a real main advance).
    expect(stateEvents).toHaveLength(0);
    expect(await vcs.resolveHead(VCS_MAIN_HEAD, REPO)).toBe(mainBefore);
    expect(reports).toEqual([]);
  });

  it("dropContext removes a context's uncommitted-only edits", async () => {
    await seedMain(REPO, [{ kind: "create", path: "a.txt", content: text("a\n") }]);
    // Uncommitted-only: no commit, no ctx head.
    await vcs.recordEdit({
      head: CTX_HEAD,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "write", path: "a.txt", content: text("dirty\n") }],
    });
    expect(await workingRows(CTX_HEAD)).toHaveLength(1);
    await vcs.dropContext(CTX);
    expect(await workingRows(CTX_HEAD)).toHaveLength(0);
  });
});
