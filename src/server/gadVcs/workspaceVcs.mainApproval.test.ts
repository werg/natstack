import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../../workspace/workers/gad-store/index.js";
import { WorkspaceVcs } from "./workspaceVcs.js";
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

async function write(dir: string, rel: string, content: string): Promise<void> {
  const abs = path.join(dir, ...rel.split("/"));
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not reached");
}

describe("WorkspaceVcs main approval locking", () => {
  let root: string;
  let workspaceRoot: string;
  let vcs: WorkspaceVcs;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-main-approval-"));
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
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("does not hold the main-head lock while approval is pending", async () => {
    await write(workspaceRoot, "base.txt", "base\n");
    await vcs.commit({ summary: "base" });

    let approvalStarted = false;
    let releaseApproval!: () => void;
    const approval = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });

    await write(workspaceRoot, "first.txt", "first\n");
    const firstCommit = vcs.commit({
      summary: "first",
      beforeAdvance: async () => {
        approvalStarted = true;
        await approval;
      },
    });

    await waitFor(() => approvalStarted);

    await write(workspaceRoot, "second.txt", "second\n");
    const secondCommit = vcs.commit({ summary: "second" });
    const secondResult = await Promise.race([
      secondCommit,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ]);

    expect(secondResult).not.toBeNull();
    expect(secondResult?.changedPaths).toEqual(["first.txt", "second.txt"]);

    releaseApproval();
    await firstCommit;

    const files = await vcs.listFiles("main");
    expect(files.map((file) => file.path).sort()).toEqual(["base.txt", "first.txt", "second.txt"]);
  });
});
