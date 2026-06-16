import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../../workspace/workers/gad-store/index.js";
import { WorkspaceVcs } from "./workspaceVcs.js";
import { GitBridge } from "./gitBridge.js";
import type { GadCaller } from "./store.js";

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

describe("GitBridge", () => {
  let root: string;
  let workspaceRoot: string;
  let vcs: WorkspaceVcs;
  let bridge: GitBridge;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-bridge-"));
    workspaceRoot = path.join(root, "workspace");
    await fsp.mkdir(workspaceRoot);
    const gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    vcs = new WorkspaceVcs({
      blobsDir: path.join(root, "blobs"),
      workspaceRoot,
      contextsRoot: path.join(root, ".contexts"),
      buildSourcesRoot: path.join(root, "build-sources"),
    });
    await vcs.attachGad(callerFor(gad));
    bridge = new GitBridge({ workspaceVcs: vcs });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("exports vcs history as git commits with GAD-State trailers, incrementally", async () => {
    await fsp.writeFile(path.join(workspaceRoot, "a.txt"), "one\n");
    await vcs.commit({ summary: "first" });
    await fsp.writeFile(path.join(workspaceRoot, "a.txt"), "two\n");
    await fsp.writeFile(path.join(workspaceRoot, "b.txt"), "bee\n");
    await vcs.commit({ summary: "second" });

    const gitDir = path.join(root, "export");
    const result = await bridge.exportHead("main", gitDir);
    expect(result.exported).toBe(2);
    expect(result.headCommit).toMatch(/^[0-9a-f]{40}$/);

    const log = git(gitDir, ["log", "--format=%s%n%b---"]);
    expect(log).toContain("first");
    expect(log).toContain("second");
    expect(log.match(/GAD-State: state:[0-9a-f]{64}/g)).toHaveLength(2);
    expect(await fsp.readFile(path.join(gitDir, "a.txt"), "utf8")).toBe("two\n");
    expect(await fsp.readFile(path.join(gitDir, "b.txt"), "utf8")).toBe("bee\n");

    // Incremental: nothing new → no commits.
    const again = await bridge.exportHead("main", gitDir);
    expect(again.exported).toBe(0);

    // One more transition exports exactly one more commit.
    await fsp.writeFile(path.join(workspaceRoot, "c.txt"), "sea\n");
    await vcs.commit({ summary: "third" });
    const incremental = await bridge.exportHead("main", gitDir);
    expect(incremental.exported).toBe(1);
  });

  it("propagates cross-transition deletions and never commits the .gad sidecar", async () => {
    await fsp.writeFile(path.join(workspaceRoot, "a.txt"), "one\n");
    await fsp.writeFile(path.join(workspaceRoot, "b.txt"), "bee\n");
    await vcs.commit({ summary: "first" });
    // Next transition deletes b.txt.
    await fsp.rm(path.join(workspaceRoot, "b.txt"));
    await fsp.writeFile(path.join(workspaceRoot, "a.txt"), "two\n");
    await vcs.commit({ summary: "second" });

    const gitDir = path.join(root, "export");
    const result = await bridge.exportHead("main", gitDir);
    expect(result.exported).toBe(2);

    // The deletion must reach the exported git HEAD tree.
    const tree = git(gitDir, ["ls-tree", "-r", "--name-only", "HEAD"])
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(tree).toContain("a.txt");
    expect(tree).not.toContain("b.txt");
    // No VCS-internal sidecar leaks into git, and none sits in the checkout.
    expect(tree.some((p) => p.startsWith(".gad"))).toBe(false);
    await expect(fsp.access(path.join(gitDir, ".gad"))).rejects.toThrow();
  });

  it("imports an edited git tree and merges it into main", async () => {
    await fsp.writeFile(path.join(workspaceRoot, "a.txt"), "one\n");
    await vcs.commit({ summary: "base" });

    const gitDir = path.join(root, "export");
    await bridge.exportHead("main", gitDir);

    // Outside-world edit in the git checkout.
    git(gitDir, ["config", "user.email", "ext@example.com"]);
    git(gitDir, ["config", "user.name", "External"]);
    await fsp.writeFile(path.join(gitDir, "external.txt"), "from github\n");
    git(gitDir, ["add", "."]);
    git(gitDir, ["commit", "-m", "external change"]);

    const imported = await bridge.importTree(gitDir, "git:origin");
    expect(imported.changed).toBe(true);

    const merge = await vcs.mergeHeads("main", "git:origin");
    expect(merge.status).toBe("merged");
    expect(await fsp.readFile(path.join(workspaceRoot, "external.txt"), "utf8")).toBe(
      "from github\n"
    );
  });
});
