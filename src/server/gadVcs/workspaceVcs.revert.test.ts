import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../../workspace/workers/gad-store/index.js";
import { WorkspaceVcs } from "./workspaceVcs.js";
import { VCS_MAIN_HEAD, vcsContextHead, type GadCaller } from "./store.js";

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
const text = (value: string) => ({ kind: "text" as const, text: value });

describe("WorkspaceVcs.listFiles / revert / publishStatus", () => {
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

  it("listFiles returns paths + content hash + mode at a head", async () => {
    await write(workspaceRoot, "a.mdx", "A\n");
    await write(workspaceRoot, "dir/b.mdx", "B\n");
    await vcs.commit({ summary: "base" });

    const files = await vcs.listFiles(VCS_MAIN_HEAD);
    expect(files.map((f) => f.path).sort()).toEqual(["a.mdx", "dir/b.mdx"]);
    for (const file of files) {
      expect(typeof file.contentHash).toBe("string");
      expect(typeof file.mode).toBe("number");
    }
  });

  it("revert restores a changed file (inverse patch, forward-applied)", async () => {
    await write(workspaceRoot, "doc.txt", "original\n");
    const base = await vcs.commit({ summary: "base" });
    const edit = await vcs.applyEdits({
      head: VCS_MAIN_HEAD,
      baseStateHash: base.stateHash,
      actor: AGENT,
      edits: [{ kind: "write", path: "doc.txt", content: text("scribe edit\n") }],
    });
    expect(await read(workspaceRoot, "doc.txt")).toBe("scribe edit\n");

    const reverted = await vcs.revert({
      head: VCS_MAIN_HEAD,
      target: { stateHash: edit.stateHash },
      actor: USER,
    });
    expect(reverted.status).toBe("clean");
    // Content-addressed: reverting an isolated edit returns to the EXACT base
    // state hash — but via a FORWARD transition (a new event + changedPaths),
    // never a head-ref reset backward.
    expect(reverted.stateHash).toBe(base.stateHash);
    expect(reverted.eventId).toBeTruthy();
    expect(reverted.changedPaths).toEqual(["doc.txt"]);
    expect(await read(workspaceRoot, "doc.txt")).toBe("original\n");
  });

  it("revert undoes a create (→ delete) and a delete (→ recreate)", async () => {
    await write(workspaceRoot, "keep.txt", "keep\n");
    const base = await vcs.commit({ summary: "base" });

    const created = await vcs.applyEdits({
      head: VCS_MAIN_HEAD,
      baseStateHash: base.stateHash,
      actor: AGENT,
      edits: [{ kind: "create", path: "new.txt", content: text("brand new\n") }],
    });
    expect(await read(workspaceRoot, "new.txt")).toBe("brand new\n");
    await vcs.revert({
      head: VCS_MAIN_HEAD,
      target: { stateHash: created.stateHash },
      actor: USER,
    });
    await expect(read(workspaceRoot, "new.txt")).rejects.toThrow();

    const deleted = await vcs.applyEdits({
      head: VCS_MAIN_HEAD,
      baseStateHash: (await vcs.resolveHead(VCS_MAIN_HEAD))!,
      actor: AGENT,
      edits: [{ kind: "delete", path: "keep.txt" }],
    });
    await expect(read(workspaceRoot, "keep.txt")).rejects.toThrow();
    await vcs.revert({
      head: VCS_MAIN_HEAD,
      target: { stateHash: deleted.stateHash },
      actor: USER,
    });
    expect(await read(workspaceRoot, "keep.txt")).toBe("keep\n");
  });

  it("revert after later non-overlapping edits preserves the later edits", async () => {
    await write(workspaceRoot, "doc.txt", "A\nB\nC\n");
    const base = await vcs.commit({ summary: "base" });

    // Agent changes line A.
    const agentEdit = await vcs.applyEdits({
      head: VCS_MAIN_HEAD,
      baseStateHash: base.stateHash,
      actor: AGENT,
      edits: [{ kind: "write", path: "doc.txt", content: text("A-agent\nB\nC\n") }],
    });
    // User then changes line C on top.
    await vcs.applyEdits({
      head: VCS_MAIN_HEAD,
      baseStateHash: agentEdit.stateHash,
      actor: USER,
      edits: [{ kind: "write", path: "doc.txt", content: text("A-agent\nB\nC-user\n") }],
    });

    // Revert ONLY the agent's transition.
    const reverted = await vcs.revert({
      head: VCS_MAIN_HEAD,
      target: { stateHash: agentEdit.stateHash },
      actor: USER,
    });
    expect(reverted.status).toBe("clean");
    expect(await read(workspaceRoot, "doc.txt")).toBe("A\nB\nC-user\n");
  });

  it("revert that overlaps current content surfaces a conflict (no silent clobber)", async () => {
    await write(workspaceRoot, "doc.txt", "L1\nL2\nL3\n");
    const base = await vcs.commit({ summary: "base" });

    const agentEdit = await vcs.applyEdits({
      head: VCS_MAIN_HEAD,
      baseStateHash: base.stateHash,
      actor: AGENT,
      edits: [{ kind: "write", path: "doc.txt", content: text("L1\nL2-agent\nL3\n") }],
    });
    // User changes the SAME line the agent touched.
    await vcs.applyEdits({
      head: VCS_MAIN_HEAD,
      baseStateHash: agentEdit.stateHash,
      actor: USER,
      edits: [{ kind: "write", path: "doc.txt", content: text("L1\nL2-user\nL3\n") }],
    });

    const reverted = await vcs.revert({
      head: VCS_MAIN_HEAD,
      target: { stateHash: agentEdit.stateHash },
      actor: USER,
    });
    expect(reverted.status).toBe("conflicted");
    expect(reverted.conflicts.map((c) => c.path)).toContain("doc.txt");
    expect(await vcs.pendingMerge(VCS_MAIN_HEAD)).not.toBeNull();
  });

  it("revert resolves a transition by eventId", async () => {
    await write(workspaceRoot, "doc.txt", "v1\n");
    const base = await vcs.commit({ summary: "base" });
    const edit = await vcs.applyEdits({
      head: VCS_MAIN_HEAD,
      baseStateHash: base.stateHash,
      actor: AGENT,
      edits: [{ kind: "write", path: "doc.txt", content: text("v2\n") }],
    });
    expect(edit.eventId).toBeTruthy();
    await vcs.revert({
      head: VCS_MAIN_HEAD,
      target: { eventId: edit.eventId! },
      actor: USER,
    });
    expect(await read(workspaceRoot, "doc.txt")).toBe("v1\n");
  });

  it("publishStatus reports the context head ahead of main, and 0 after publish", async () => {
    await write(workspaceRoot, "notes.mdx", "hello\n");
    await vcs.commit({ summary: "seed main" });

    const contextId = "vault-test";
    const { head } = await vcs.ensureContextFolder(contextId);
    expect(head).toBe(vcsContextHead(contextId));
    expect((await vcs.publishStatus(head)).ahead).toBe(0);

    const ctxState = (await vcs.resolveHead(head))!;
    await vcs.applyEdits({
      head,
      baseStateHash: ctxState,
      actor: USER,
      edits: [{ kind: "write", path: "notes.mdx", content: text("hello world\n") }],
    });

    const ahead = await vcs.publishStatus(head);
    expect(ahead.ahead).toBe(1);
    expect(ahead.files).toEqual([{ path: "notes.mdx", kind: "changed" }]);

    // Publish: merge ctx → main. Afterwards main carries the change → ahead 0.
    const merged = await vcs.mergeHeads(VCS_MAIN_HEAD, head, { actor: USER });
    expect(merged.status).toBe("merged");
    expect((await vcs.publishStatus(head)).ahead).toBe(0);
  });
});
