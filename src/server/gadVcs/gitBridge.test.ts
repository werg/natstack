import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../../workspace/workers/gad-store/index.js";
import { WorkspaceVcs } from "./workspaceVcs.js";
import { GitBridge } from "./gitBridge.js";
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

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

const USER = { id: "user", kind: "user" };
const text = (value: string) => ({ kind: "text" as const, text: value });

// GitBridge exports/imports a single repo's log; its checkout is fixed to
// `workspace/<repoPath>`, so we operate on one repo per test.
const REPO = "packages/bridge";

describe("GitBridge", () => {
  let root: string;
  let workspaceRoot: string;
  let repoDir: string;
  let vcs: WorkspaceVcs;
  let bridge: GitBridge;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-bridge-"));
    workspaceRoot = path.join(root, "workspace");
    await fsp.mkdir(workspaceRoot);
    repoDir = path.join(workspaceRoot, ...REPO.split("/"));
    const gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    vcs = new WorkspaceVcs({
      blobsDir: path.join(root, "blobs"),
      workspaceRoot,
      contextsRoot: path.join(root, ".contexts"),
      buildSourcesRoot: path.join(root, "build-sources"),
    });
    await vcs.attachGad(callerFor(gad));
    bridge = new GitBridge({ workspaceVcs: vcs, workspaceRoot });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  let seedSeq = 0;

  /**
   * Advance the repo's `main` by one commit via the real flow (edit → commit →
   * push on a throwaway context, then drop it). `main` now advances ONLY via
   * push, so each `commitRepo` forks a fresh ctx from the current main tip,
   * commits the edits, and fast-forwards main. The git bridge exports the
   * resulting committed main states (materialized to `workspace/<repoPath>`).
   */
  async function commitRepo(
    edits: Parameters<WorkspaceVcs["recordEdit"]>[0]["edits"]
  ): Promise<void> {
    const contextId = `__seed${seedSeq++}__`;
    const seedHead = vcsContextHead(contextId);
    await vcs.recordEdit({ head: seedHead, repoPath: REPO, edits, actor: USER });
    await vcs.commit({ head: seedHead, repoPath: REPO, message: "seed", actor: USER });
    const pushed = await vcs.push({ repoPaths: [REPO], sourceHead: seedHead, actor: USER });
    expect(pushed.status).toBe("pushed");
    await vcs.dropContext(contextId);
  }

  it("exports a repo's vcs history as git commits with GAD-State trailers, incrementally", async () => {
    await commitRepo([{ kind: "create", path: "a.txt", content: text("one\n") }]);
    await commitRepo([
      { kind: "write", path: "a.txt", content: text("two\n") },
      { kind: "create", path: "b.txt", content: text("bee\n") },
    ]);

    const result = await bridge.exportRepoHead(REPO);
    expect(result.exported).toBe(2);
    expect(result.headCommit).toMatch(/^[0-9a-f]{40}$/);

    const log = git(repoDir, ["log", "--format=%s%n%b---"]);
    expect(log.match(/GAD-State: state:[0-9a-f]{64}/g)).toHaveLength(2);
    expect(log).toContain(`GAD-Repo: ${REPO}`);
    expect(await fsp.readFile(path.join(repoDir, "a.txt"), "utf8")).toBe("two\n");
    expect(await fsp.readFile(path.join(repoDir, "b.txt"), "utf8")).toBe("bee\n");

    // Incremental: nothing new → no commits.
    const again = await bridge.exportRepoHead(REPO);
    expect(again.exported).toBe(0);

    // One more transition exports exactly one more commit.
    await commitRepo([{ kind: "create", path: "c.txt", content: text("sea\n") }]);
    const incremental = await bridge.exportRepoHead(REPO);
    expect(incremental.exported).toBe(1);
  });

  it("propagates cross-transition deletions to the exported git tree", async () => {
    await commitRepo([
      { kind: "create", path: "a.txt", content: text("one\n") },
      { kind: "create", path: "b.txt", content: text("bee\n") },
    ]);
    // Next transition deletes b.txt.
    await commitRepo([
      { kind: "delete", path: "b.txt" },
      { kind: "write", path: "a.txt", content: text("two\n") },
    ]);

    const result = await bridge.exportRepoHead(REPO);
    expect(result.exported).toBe(2);

    // The deletion must reach the exported git HEAD tree.
    const tree = git(repoDir, ["ls-tree", "-r", "--name-only", "HEAD"])
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(tree).toContain("a.txt");
    expect(tree).not.toContain("b.txt");
    // The bridge keeps its materialize sidecar OUTSIDE the checkout.
    await expect(fsp.access(`${repoDir}.gad-sidecar`)).resolves.toBeUndefined();
  });

  it("imports an edited git tree as a snapshot transition on the repo's main", async () => {
    await commitRepo([{ kind: "create", path: "a.txt", content: text("one\n") }]);
    await bridge.exportRepoHead(REPO);

    // Outside-world edit in the repo's git checkout.
    git(repoDir, ["config", "user.email", "ext@example.com"]);
    git(repoDir, ["config", "user.name", "External"]);
    await fsp.writeFile(path.join(repoDir, "external.txt"), "from github\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "external change"]);

    const imported = await bridge.importRepoTree(REPO);
    expect(imported.changed).toBe(true);

    // The imported file is now part of the repo's main state.
    const file = await vcs.readFile(VCS_MAIN_HEAD, "external.txt", REPO);
    expect(file?.content).toMatchObject({ kind: "text", text: "from github\n" });
  });
});
