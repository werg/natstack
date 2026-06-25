/**
 * Main-advance approval now gates ONLY the push (the candidate `main` advance).
 * Edits/commits on a ctx head need NO approval — `main` advances only via push.
 *
 * These tests verify the two behaviors that used to ride on applyEdits/merge-into-main:
 *   - the repo-main lock is NOT held across a parked push approval (a concurrent
 *     read of the same repo's main does not block on the pending approval);
 *   - the push approval event carries the CANDIDATE composed view (the workspace
 *     as it WOULD be after the push), not the stale pre-advance view.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not reached");
}

const USER = { id: "user", kind: "user" };
const AGENT = { id: "scribe", kind: "agent" };
const text = (value: string) => ({ kind: "text" as const, text: value });
const REPO = "packages/approval";

describe("WorkspaceVcs main approval locking (per-repo push gate)", () => {
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

  /** Seed a repo's `main` via the real flow (edit → commit → push on a throwaway
   *  context, with a no-op push approval hook), then drop the seeding context. */
  async function seedMain(
    edits: Parameters<WorkspaceVcs["recordEdit"]>[0]["edits"]
  ): Promise<string> {
    const seedHead = vcsContextHead("__seed__");
    await vcs.recordEdit({ head: seedHead, repoPath: REPO, edits, actor: USER });
    await vcs.commit({ head: seedHead, repoPath: REPO, message: "seed", actor: USER });
    const pushed = await vcs.push({
      repoPaths: [REPO],
      sourceHead: seedHead,
      actor: USER,
      beforeAdvance: async () => {},
    });
    expect(pushed.status).toBe("pushed");
    await vcs.dropContext("__seed__");
    const main = await vcs.resolveHead(VCS_MAIN_HEAD, REPO);
    if (!main) throw new Error("seedMain: main not created");
    return main;
  }

  it("does not hold the repo-main lock while a push approval is pending", async () => {
    // Seed the repo's main and commit a divergent context.
    await seedMain([{ kind: "create", path: "base.txt", content: text("base\n") }]);
    const ctxHead = vcsContextHead("ctx-approve");
    await vcs.recordEdit({
      head: ctxHead,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "create", path: "ctx.txt", content: text("ctx\n") }],
    });
    await vcs.commit({ head: ctxHead, repoPath: REPO, message: "ctx edit", actor: AGENT });

    let approvalStarted = false;
    let releaseApproval!: () => void;
    const approval = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });

    // Push the context onto main behind an approval gate that parks (the
    // candidate main advance). Edits/commits above needed no approval.
    const pushed = vcs.push({
      repoPaths: [REPO],
      sourceHead: ctxHead,
      actor: AGENT,
      beforeAdvance: async () => {
        approvalStarted = true;
        await approval;
      },
    });

    await waitFor(() => approvalStarted);

    // While the approval is parked, a read of the same repo's main must NOT
    // block on the push — the head lock is released across approval.
    const readDuringApproval = await Promise.race([
      vcs.resolveHead(VCS_MAIN_HEAD, REPO),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 250)),
    ]);
    expect(readDuringApproval).not.toBe("blocked");

    releaseApproval();
    const result = await pushed;
    expect(result.status).toBe("pushed");

    const files = await vcs.listFiles(VCS_MAIN_HEAD, REPO);
    expect(files.map((file) => file.path).sort()).toEqual(["base.txt", "ctx.txt"]);
  });

  it("a push approval event carries the CANDIDATE composed view, not the stale one", async () => {
    await seedMain([{ kind: "create", path: "config.txt", content: text("v1\n") }]);
    const base = await vcs.resolveHead(VCS_MAIN_HEAD, REPO);

    // A context commits config.txt = v2; push gates the candidate main advance.
    const ctxHead = vcsContextHead("ctx-candidate");
    await vcs.recordEdit({
      head: ctxHead,
      repoPath: REPO,
      actor: AGENT,
      edits: [{ kind: "write", path: "config.txt", content: text("v2\n") }],
    });
    await vcs.commit({ head: ctxHead, repoPath: REPO, message: "bump config", actor: AGENT });

    let candidateStateHash: string | null = null;
    let staleStateHash: string | null = null;
    const pushed = await vcs.push({
      repoPaths: [REPO],
      sourceHead: ctxHead,
      actor: AGENT,
      // The approval gate reads the candidate event for meta-approval + dedupe +
      // display. Its stateHash (the composed workspace view) MUST be the
      // workspace as it WOULD be after this push (config.txt = v2), not the
      // still-current main view (v1). `sinceStateHash` is the pre-advance
      // composed view (config.txt = v1).
      beforeAdvance: async (event) => {
        candidateStateHash = event.stateHash;
        staleStateHash = event.sinceStateHash;
      },
    });
    expect(pushed.status).toBe("pushed");

    // The candidate composed view reflects the would-be-after-push content (v2).
    expect(candidateStateHash).toBeTruthy();
    const candidateFile = await vcs.readFile(candidateStateHash!, `${REPO}/config.txt`);
    expect(candidateFile?.content).toMatchObject({ kind: "text", text: "v2\n" });

    // The stale pre-advance composed view still shows v1 — proving the approval
    // event carried the CANDIDATE, not the stale, view.
    expect(staleStateHash).toBeTruthy();
    expect(staleStateHash).not.toBe(candidateStateHash);
    const staleFile = await vcs.readFile(staleStateHash!, `${REPO}/config.txt`);
    expect(staleFile?.content).toMatchObject({ kind: "text", text: "v1\n" });

    // Sanity: the repo's main was at v1 (base) before the push advanced it.
    expect(base).toBeTruthy();
  });
});
