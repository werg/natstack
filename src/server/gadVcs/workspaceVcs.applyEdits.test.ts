import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../../workspace/workers/gad-store/index.js";
import { WorkspaceVcs } from "./workspaceVcs.js";
import { VCS_MAIN_HEAD, type GadCaller } from "./store.js";

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

const USER = { id: "user", kind: "user" };
const AGENT = { id: "scribe", kind: "agent" };
const DO_ACTOR = { id: "do:agent", kind: "do" };
const textContent = (text: string) => ({ kind: "text" as const, text });

describe("WorkspaceVcs.applyEdits", () => {
  let root: string;
  let workspaceRoot: string;
  let vcs: WorkspaceVcs;
  let gad: TestGad;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-apply-"));
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

  it("fast-forwards a write and preserves siblings", async () => {
    await write(workspaceRoot, "a.txt", "alpha\n");
    await write(workspaceRoot, "b.txt", "bravo\n");
    const base = await vcs.commit({ summary: "base" });

    const res = await vcs.applyEdits({
      head: VCS_MAIN_HEAD,
      baseStateHash: base.stateHash,
      actor: USER,
      edits: [{ kind: "write", path: "a.txt", content: textContent("ALPHA\n") }],
    });

    expect(res.status).toBe("clean");
    expect(res.stateHash).not.toBe(base.stateHash);
    expect(res.changedPaths).toEqual(["a.txt"]);
    expect(await read(workspaceRoot, "a.txt")).toBe("ALPHA\n");
    expect(await read(workspaceRoot, "b.txt")).toBe("bravo\n"); // sibling untouched
  });

  it("reads text and binary file content through an explicit content union", async () => {
    const base = await vcs.commit({ summary: "empty" });
    const binaryBase64 = Buffer.from([0, 1, 2, 255]).toString("base64");

    await vcs.applyEdits({
      head: VCS_MAIN_HEAD,
      baseStateHash: base.stateHash,
      actor: USER,
      edits: [
        { kind: "write", path: "text.txt", content: textContent("hello\n") },
        { kind: "write", path: "asset.bin", content: { kind: "bytes", base64: binaryBase64 } },
      ],
    });

    const text = await vcs.readFile(VCS_MAIN_HEAD, "text.txt");
    expect(text?.content).toEqual({ kind: "text", text: "hello\n" });
    expect(text?.size).toBe(6);

    const binary = await vcs.readFile(VCS_MAIN_HEAD, "asset.bin");
    expect(binary?.content).toEqual({ kind: "bytes", base64: binaryBase64 });
    expect(binary?.size).toBe(4);
  });

  it("accepts direct writes from do callers", async () => {
    const base = await vcs.commit({ summary: "empty" });

    const res = await vcs.applyEdits({
      head: VCS_MAIN_HEAD,
      baseStateHash: base.stateHash,
      actor: DO_ACTOR,
      edits: [{ kind: "write", path: "agent.txt", content: textContent("from do\n") }],
    });

    expect(res.status).toBe("clean");
    expect(await read(workspaceRoot, "agent.txt")).toBe("from do\n");

    const events = await callerFor(gad).call<Array<{ envelopeId: string; actor: unknown }>>(
      "readLog",
      { logId: "vcs:workspace", head: VCS_MAIN_HEAD, limit: 0 }
    );
    expect(events.find((event) => event.envelopeId === res.eventId)?.actor).toEqual({
      id: "do:agent",
      kind: "agent",
      metadata: { type: "do" },
    });
  });

  it("applies exact-range replace hunks", async () => {
    await write(workspaceRoot, "doc.txt", "hello world\n");
    const base = await vcs.commit({ summary: "base" });

    await vcs.applyEdits({
      head: VCS_MAIN_HEAD,
      baseStateHash: base.stateHash,
      actor: USER,
      edits: [
        {
          kind: "replace",
          path: "doc.txt",
          hunks: [{ start: 6, end: 11, oldText: "world", newText: "there" }],
        },
      ],
    });

    expect(await read(workspaceRoot, "doc.txt")).toBe("hello there\n");
  });

  it("auto-merges a stale edit against an advanced head (non-overlapping)", async () => {
    await write(workspaceRoot, "doc.txt", "L1\nL2\nL3\n");
    const base = await vcs.commit({ summary: "base" });
    const events: unknown[] = [];
    const off = vcs.onStateAdvanced((event) => events.push(event));

    // Agent advances head editing L3.
    const advanced = await vcs.applyEdits({
      head: VCS_MAIN_HEAD,
      baseStateHash: base.stateHash,
      actor: AGENT,
      edits: [{ kind: "write", path: "doc.txt", content: textContent("L1\nL2\nL3-agent\n") }],
    });

    // User commits a stale edit (authored against the original base) on L1.
    const res = await vcs.applyEdits({
      head: VCS_MAIN_HEAD,
      baseStateHash: base.stateHash,
      actor: USER,
      edits: [{ kind: "write", path: "doc.txt", content: textContent("L1-user\nL2\nL3\n") }],
    });

    expect(res.status).toBe("clean");
    expect(await read(workspaceRoot, "doc.txt")).toBe("L1-user\nL2\nL3-agent\n");
    off();

    const event = events[events.length - 1] as {
      sinceStateHash: string | null;
      eventId: string | null;
      actor: unknown;
      transitionKind: string;
      changedPaths: string[];
      fileChanges: Array<{ kind: string; path: string }>;
      editOps: Array<{
        kind: string;
        path: string;
        oldContentHash: string | null;
        newContentHash: string | null;
      }>;
    };
    expect(event.sinceStateHash).toBe(advanced.stateHash);
    expect(event.eventId).toBe(res.eventId);
    expect(event.actor).toEqual(USER);
    expect(event.transitionKind).toBe("edit");
    expect(event.changedPaths).toEqual(["doc.txt"]);
    expect(event.fileChanges).toEqual([
      expect.objectContaining({ kind: "changed", path: "doc.txt" }),
    ]);
    expect(event.editOps).toEqual([
      expect.objectContaining({
        kind: "write",
        path: "doc.txt",
        oldContentHash: expect.any(String),
        newContentHash: expect.any(String),
      }),
    ]);
    const integrity = await callerFor(gad).call<{ ok: boolean; errors: unknown[] }>(
      "validateGadHashes",
      {}
    );
    expect(integrity).toEqual({ ok: true, errors: [] });
  });

  it("reports a conflict (pending merge) when stale edits overlap", async () => {
    await write(workspaceRoot, "doc.txt", "L1\nL2\nL3\n");
    const base = await vcs.commit({ summary: "base" });

    await vcs.applyEdits({
      head: VCS_MAIN_HEAD,
      baseStateHash: base.stateHash,
      actor: AGENT,
      edits: [{ kind: "write", path: "doc.txt", content: textContent("X1\nL2\nL3\n") }],
    });

    const res = await vcs.applyEdits({
      head: VCS_MAIN_HEAD,
      baseStateHash: base.stateHash,
      actor: USER,
      edits: [{ kind: "write", path: "doc.txt", content: textContent("Y1\nL2\nL3\n") }],
    });

    expect(res.status).toBe("conflicted");
    expect(res.conflicts.map((c) => c.path)).toContain("doc.txt");
    expect(await vcs.pendingMerge(VCS_MAIN_HEAD)).not.toBeNull();
  });

  it("records the authored op union as provenance (gad_worktree_edit_ops)", async () => {
    await write(workspaceRoot, "doc.txt", "hello world\n");
    const base = await vcs.commit({ summary: "base" });

    const res = await vcs.applyEdits({
      head: VCS_MAIN_HEAD,
      baseStateHash: base.stateHash,
      actor: USER,
      edits: [
        {
          kind: "replace",
          path: "doc.txt",
          hunks: [{ start: 6, end: 11, oldText: "world", newText: "there" }],
        },
      ],
    });

    const ops = await callerFor(gad).call<Array<Record<string, unknown>>>("listWorktreeEditOps", {
      outputStateHash: res.stateHash,
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]!["kind"]).toBe("replace");
    expect(ops[0]!["path"]).toBe("doc.txt");
    expect(JSON.parse(ops[0]!["hunks_json"] as string)).toEqual([
      { start: 6, end: 11, oldText: "world", newText: "there" },
    ]);
  });

  it("stageWorktreeState records base->mine ancestry (merge-base/blame)", async () => {
    await write(workspaceRoot, "doc.txt", "L1\n");
    const base = await vcs.commit({ summary: "base" });
    const files = await callerFor(gad).call<
      Array<{ path: string; content_hash: string; mode: number }>
    >("listStateFiles", { stateHash: base.stateHash });
    // Stage a draft off base (mode tweak makes the manifest hash differ).
    const staged = await callerFor(gad).call<{ stateHash: string }>("stageWorktreeState", {
      baseStateHash: base.stateHash,
      files: files.map((f) => ({
        path: f.path,
        contentHash: f.content_hash,
        mode: f.mode === 33188 ? 33261 : 33188,
      })),
      transition: {
        logId: "vcs:workspace",
        head: "draft:test",
        logKind: "vcs",
        actor: USER,
        eventId: "draft-test-event",
      },
    });
    expect(staged.stateHash).not.toBe(base.stateHash);
    // The base->staged edge makes base discoverable as the merge base.
    const mb = await callerFor(gad).call<{ baseStateHash: string | null }>("getMergeBase", {
      leftStateHash: staged.stateHash,
      rightStateHash: base.stateHash,
    });
    expect(mb.baseStateHash).toBe(base.stateHash);
    const integrity = await callerFor(gad).call<{ ok: boolean; errors: unknown[] }>(
      "validateGadHashes",
      {}
    );
    expect(integrity).toEqual({ ok: true, errors: [] });
  });

  it("deletes a file while preserving siblings", async () => {
    await write(workspaceRoot, "keep.txt", "keep\n");
    await write(workspaceRoot, "gone.txt", "gone\n");
    const base = await vcs.commit({ summary: "base" });

    await vcs.applyEdits({
      head: VCS_MAIN_HEAD,
      baseStateHash: base.stateHash,
      actor: USER,
      edits: [{ kind: "delete", path: "gone.txt" }],
    });

    expect(await read(workspaceRoot, "keep.txt")).toBe("keep\n");
    await expect(read(workspaceRoot, "gone.txt")).rejects.toThrow();
  });
});
