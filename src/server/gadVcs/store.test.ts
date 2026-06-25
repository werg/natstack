import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../../workspace/workers/gad-store/index.js";
import {
  assertWritableVcsPath,
  GadVcs,
  VCS_MAIN_HEAD,
  vcsContextHead,
  type GadCaller,
} from "./store.js";

// The GadVcs primitive accepts any logId; these store-level tests use a single
// fixture log id (the per-repo VCS layer above picks real `vcs:repo:*` ids).
const FIXTURE_LOG = "vcs:workspace";

describe("assertWritableVcsPath", () => {
  it("rejects a platform-ignored dir with an ACTIONABLE error (names a writable location)", async () => {
    await expect(assertWritableVcsPath(".natstack/tmp/x.txt")).rejects.toThrow(
      /platform-ignored directory.*projects\//s
    );
  });

  it("rejects an ignored file with the same actionable hint", async () => {
    await expect(assertWritableVcsPath(".env")).rejects.toThrow(
      /platform-ignored.*non-ignored path/s
    );
  });

  it("allows a normal tracked source path", async () => {
    await expect(assertWritableVcsPath("projects/foo.txt")).resolves.toBeUndefined();
    await expect(assertWritableVcsPath("panels/my-panel/index.tsx")).resolves.toBeUndefined();
  });
});

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

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }
}

async function readTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const entry of await fsp.readdir(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === ".gad") continue;
        await walk(path.join(abs, entry.name), childRel);
      } else {
        out[childRel] = await fsp.readFile(path.join(abs, entry.name), "utf8");
      }
    }
  };
  await walk(dir, "");
  return out;
}

describe("GadVcs snapshot/materialize", () => {
  let root: string;
  let gad: TestGad;
  let vcs: GadVcs;
  let workDir: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-"));
    workDir = path.join(root, "work");
    await fsp.mkdir(workDir);
    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    vcs = new GadVcs({ blobsDir: path.join(root, "blobs"), gad: callerFor(gad) });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("round-trips snapshot → materialize byte-identically", async () => {
    const tree = {
      "README.md": "# hello\n",
      "src/index.ts": "export const x = 1;\n",
      "src/deep/nested/util.ts": "export const y = 2;\n",
    };
    await writeTree(workDir, tree);
    const snap = await vcs.snapshotDir(workDir, { logId: FIXTURE_LOG, summary: "initial" });
    expect(snap.unchanged).toBe(false);
    expect(snap.fileCount).toBe(3);
    expect(snap.stateHash).toMatch(/^state:[0-9a-f]{64}$/);
    const sidecar = await fsp.readFile(path.join(workDir, ".gad", "CHECKOUT.json"), "utf8");
    expect(sidecar).toContain('\n  "files":');
    expect(sidecar.endsWith("\n")).toBe(true);
    expect(JSON.parse(sidecar)).toMatchObject({ stateHash: snap.stateHash });

    const outDir = path.join(root, "out");
    const mat = await vcs.materializeState(snap.stateHash, outDir);
    expect(mat.written).toBe(3);
    expect(await readTree(outDir)).toEqual(tree);
  });

  it("skips ingest when nothing changed (durable no-change, survives sidecar amnesia)", async () => {
    await writeTree(workDir, { "a.txt": "one" });
    const first = await vcs.snapshotDir(workDir, { logId: FIXTURE_LOG });
    expect(first.unchanged).toBe(false);

    const second = await vcs.snapshotDir(workDir, { logId: FIXTURE_LOG });
    expect(second.unchanged).toBe(true);
    expect(second.stateHash).toBe(first.stateHash);

    // P3: delete the sidecar cache — still converges with no new event.
    await fsp.rm(path.join(workDir, ".gad"), { recursive: true, force: true });
    const third = await vcs.snapshotDir(workDir, { logId: FIXTURE_LOG });
    expect(third.unchanged).toBe(true);
    expect(third.stateHash).toBe(first.stateHash);

    const events = gad.instance.readLog({ logId: FIXTURE_LOG, head: VCS_MAIN_HEAD, limit: 0 });
    expect(events.filter((e) => e.payloadKind === "state.snapshot_ingested")).toHaveLength(1);
  });

  it("snapshots edits incrementally and materializes deltas", async () => {
    await writeTree(workDir, { "a.txt": "one", "b.txt": "two" });
    const first = await vcs.snapshotDir(workDir, { logId: FIXTURE_LOG });

    await writeTree(workDir, { "a.txt": "one-edited", "c.txt": "three" });
    await fsp.rm(path.join(workDir, "b.txt"));
    const second = await vcs.snapshotDir(workDir, { logId: FIXTURE_LOG });
    expect(second.unchanged).toBe(false);
    expect(second.stateHash).not.toBe(first.stateHash);

    const outDir = path.join(root, "out");
    await vcs.materializeState(first.stateHash, outDir);
    const delta = await vcs.materializeState(second.stateHash, outDir);
    expect(delta.deleted).toBe(1); // b.txt
    expect(delta.unchanged).toBe(0); // a edited, c new
    expect(await readTree(outDir)).toEqual({ "a.txt": "one-edited", "c.txt": "three" });
  });

  it("preserves untracked files on materialize unless clean", async () => {
    await writeTree(workDir, { "a.txt": "one" });
    const snap = await vcs.snapshotDir(workDir, { logId: FIXTURE_LOG });

    const outDir = path.join(root, "out");
    await vcs.materializeState(snap.stateHash, outDir);
    await writeTree(outDir, { "untracked.txt": "keep me" });

    await vcs.materializeState(snap.stateHash, outDir);
    expect((await readTree(outDir))["untracked.txt"]).toBe("keep me");

    await vcs.materializeState(snap.stateHash, outDir, { clean: true });
    expect((await readTree(outDir))["untracked.txt"]).toBeUndefined();
  });

  it("honors .gadignore and platform excludes", async () => {
    await writeTree(workDir, {
      ".gadignore": "*.log\nbuild/\n",
      "keep.ts": "ok",
      ".env": "SECRET=1",
      ".env.local": "SECRET=2",
      ".cache/state.json": "noise",
      ".databases/app.sqlite": "noise",
      ".npmrc": "//registry.example.test/:_authToken=secret",
      ".secrets.yml": "token: secret",
      "debug.log": "noise",
      "pkg.tsbuildinfo": "noise",
      "coverage/coverage.json": "noise",
      "out/app.js": "noise",
      "build/out.js": "noise",
      "node_modules/dep/index.js": "noise",
      ".git/HEAD": "noise",
    });
    const snap = await vcs.snapshotDir(workDir, { logId: FIXTURE_LOG });
    const files = gad.instance.listStateFiles({ stateHash: snap.stateHash });
    expect(files.map((f) => f["path"]).sort()).toEqual([".gadignore", "keep.ts"]);
  });

  it("ignores the merge-conflict summary only at the worktree root", async () => {
    await writeTree(workDir, {
      "MERGE_CONFLICTS.md": "root summary",
      "docs/MERGE_CONFLICTS.md": "user doc",
      "keep.ts": "ok",
    });
    const snap = await vcs.snapshotDir(workDir, { logId: FIXTURE_LOG });
    const paths = gad.instance
      .listStateFiles({ stateHash: snap.stateHash })
      .map((f) => f["path"])
      .sort();
    expect(paths).toContain("docs/MERGE_CONFLICTS.md");
    expect(paths).toContain("keep.ts");
    expect(paths).not.toContain("MERGE_CONFLICTS.md");
  });

  it("forks a context head sharing the main lineage", async () => {
    await writeTree(workDir, { "a.txt": "one" });
    const snap = await vcs.snapshotDir(workDir, { logId: FIXTURE_LOG });

    const fork = await vcs.forkContext("ctx1", FIXTURE_LOG);
    expect(fork.head).toBe(vcsContextHead("ctx1"));
    expect(fork.stateHash).toBe(snap.stateHash);

    // Diverge the context, main is unaffected.
    const ctxDir = path.join(root, "ctx");
    await vcs.materializeState(snap.stateHash, ctxDir);
    await writeTree(ctxDir, { "ctx-only.txt": "branch work" });
    const ctxSnap = await vcs.snapshotDir(ctxDir, { logId: FIXTURE_LOG, head: fork.head });
    expect(ctxSnap.unchanged).toBe(false);
    expect(await vcs.resolveWorktreeRef(VCS_MAIN_HEAD, FIXTURE_LOG)).toBe(snap.stateHash);
    expect(await vcs.resolveWorktreeRef(fork.head, FIXTURE_LOG)).toBe(ctxSnap.stateHash);

    // forkContext is idempotent.
    const again = await vcs.forkContext("ctx1", FIXTURE_LOG);
    expect(again.stateHash).toBe(ctxSnap.stateHash);
  });

  it("subtree hashes change only for touched subtrees", async () => {
    await writeTree(workDir, {
      "pkg-a/index.ts": "a",
      "pkg-b/index.ts": "b",
    });
    const first = await vcs.snapshotDir(workDir, { logId: FIXTURE_LOG });
    const aHash1 = await vcs.getSubtreeHash(first.stateHash, "pkg-a");
    const bHash1 = await vcs.getSubtreeHash(first.stateHash, "pkg-b");

    await writeTree(workDir, { "pkg-a/index.ts": "a-edited" });
    const second = await vcs.snapshotDir(workDir, { logId: FIXTURE_LOG });
    expect(await vcs.getSubtreeHash(second.stateHash, "pkg-a")).not.toBe(aHash1);
    expect(await vcs.getSubtreeHash(second.stateHash, "pkg-b")).toBe(bHash1);
  });

  it("computes local state/subtree hashes byte-identical to the DO", async () => {
    await writeTree(workDir, {
      "README.md": "# hi\n",
      "panels/chat/index.tsx": "export {}",
      "panels/chat/src/deep.ts": "export const d = 1;",
      "packages/core/index.ts": "export const c = 2;",
    });
    const local = await vcs.localState(workDir);
    const snap = await vcs.snapshotDir(workDir, { logId: FIXTURE_LOG });
    expect(local.stateHash).toBe(snap.stateHash);
    for (const subtree of ["panels/chat", "panels/chat/src", "packages/core", "README.md"]) {
      expect(local.manifest.subtreeHash(subtree)).toBe(
        gad.instance.getSubtreeHash({ stateHash: snap.stateHash, path: subtree }).subtreeHash
      );
    }
    expect(local.manifest.subtreeHash("does/not/exist")).toBeNull();
  });

  it("materializes file→directory and directory→file transitions at the same path", async () => {
    // State A: `config` is a regular file.
    await writeTree(workDir, { config: "v=1\n", "keep.txt": "k" });
    const a = await vcs.snapshotDir(workDir, { logId: FIXTURE_LOG });
    // State B: `config` becomes a directory.
    await fsp.rm(path.join(workDir, "config"));
    await writeTree(workDir, { "config/index.ts": "export const v = 1;\n" });
    const b = await vcs.snapshotDir(workDir, { logId: FIXTURE_LOG });

    const outDir = path.join(root, "out");
    await vcs.materializeState(a.stateHash, outDir);
    expect(await readTree(outDir)).toEqual({ config: "v=1\n", "keep.txt": "k" });

    // file → directory: must neither throw nor silently produce an empty tree.
    await vcs.materializeState(b.stateHash, outDir);
    expect(await readTree(outDir)).toEqual({
      "config/index.ts": "export const v = 1;\n",
      "keep.txt": "k",
    });

    // directory → file (back to A): the recursive deletion must clear the dir.
    await vcs.materializeState(a.stateHash, outDir);
    expect(await readTree(outDir)).toEqual({ config: "v=1\n", "keep.txt": "k" });
  });

  it("materializes over an untracked file that conflicts with a target directory path", async () => {
    await writeTree(workDir, { "data/x.txt": "x" });
    const snap = await vcs.snapshotDir(workDir, { logId: FIXTURE_LOG });

    const outDir = path.join(root, "out");
    await fsp.mkdir(outDir, { recursive: true });
    // Pre-seed an untracked file where the target needs a directory.
    await fsp.writeFile(path.join(outDir, "data"), "untracked-conflict");

    await vcs.materializeState(snap.stateHash, outDir);
    expect(await readTree(outDir)).toEqual({ "data/x.txt": "x" });
  });

  it("marks executables and round-trips mode", async () => {
    const script = path.join(workDir, "run.sh");
    await fsp.writeFile(script, "#!/bin/sh\necho hi\n");
    await fsp.chmod(script, 0o755);
    const snap = await vcs.snapshotDir(workDir, { logId: FIXTURE_LOG });

    const outDir = path.join(root, "out");
    await vcs.materializeState(snap.stateHash, outDir);
    const stat = fs.statSync(path.join(outDir, "run.sh"));
    expect(stat.mode & 0o111).not.toBe(0);
  });
});
