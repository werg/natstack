/**
 * Verification of vcs.push under the edit → commit → push re-architecture:
 *   - main advances ONLY via push; push is FAST-FORWARD-ONLY.
 *   - the source ctx head must be CLEAN: push throws on uncommitted edits.
 *   - first push of a brand-new repo creates its main from empty.
 *   - a build gate (validateRepoPush) blocks the advance on a required failure.
 *   - when main advanced past the ctx's base, push returns a structured
 *     {status:"diverged"} (no more "conflicted"); vcs.merge reconciles, then
 *     push fast-forwards.
 *   - beforeAdvance still gates the main-advance (now only on push).
 *   - forkRepo (history-preserving) seeded via the real edit → commit → push flow.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../../workspace/workers/gad-store/index.js";
import { WorkspaceVcs } from "./workspaceVcs.js";
import { VCS_MAIN_HEAD, vcsContextHead, type GadCaller } from "./store.js";
import type { StateAdvancedEvent } from "../buildV2/stateTrigger.js";

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
const text = (value: string) => ({ kind: "text" as const, text: value });

// validateRepoPush's real RepoBuildReport[] return shape.
import type { RepoBuildReport, RepoPushValidator } from "../buildV2/index.js";
type Report = RepoBuildReport;
function report(
  partial: Pick<RepoBuildReport, "repoPath" | "required" | "status">
): RepoBuildReport {
  return { kind: "content", role: "pushed", builds: [], ...partial };
}
// The RepoPushValidator interface now also requires previewBuild (working-view
// build, no EV baseline write); the push gate only calls validateRepoPush.
function fakeBuildSystem(reports: Report[]): { getBuildSystem: () => RepoPushValidator } {
  return {
    getBuildSystem: () => ({
      validateRepoPush: async () => reports,
      previewBuild: async () => reports,
    }),
  };
}

describe("WorkspaceVcs.push (per-repo, fast-forward-only, build-gated)", () => {
  let root: string;
  let workspaceRoot: string;
  let vcs: WorkspaceVcs;
  let gad: TestGad;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-push-"));
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

  /**
   * Create a brand-new repo's files on a fresh context head (no main yet) and
   * COMMIT them, so the ctx head is clean and pushable. main now advances only
   * via push, and push rejects uncommitted edits — so the working edits must be
   * folded into a commit first.
   */
  async function createOnContext(repoPath: string, contextHead: string): Promise<void> {
    await vcs.recordEdit({
      head: contextHead,
      actor: USER,
      repoPath,
      edits: [
        {
          kind: "create",
          path: "package.json",
          content: text(`{ "name": "@workspace-packages/foo", "natstack": {} }\n`),
        },
        { kind: "create", path: "index.ts", content: text("export const x = 1;\n") },
      ],
    });
    await vcs.commit({ head: contextHead, repoPath, message: "create repo", actor: USER });
  }

  it("first push of a brand-new repo creates its main from empty", async () => {
    await createOnContext("packages/foo", "ctx:work");
    expect(await vcs.resolveHead(VCS_MAIN_HEAD, "packages/foo")).toBeNull();
    const events: StateAdvancedEvent[] = [];
    const off = vcs.onStateAdvanced((event) => events.push(event));

    const result = await vcs
      .push({
        repoPaths: ["packages/foo"],
        sourceHead: "ctx:work",
        actor: USER,
      })
      .finally(off);

    expect(result.status).toBe("pushed");
    // The main-advance state-advanced event for the pushed repo.
    const mainEvent = events.find((e) => e.head === VCS_MAIN_HEAD);
    expect(mainEvent).toMatchObject({
      head: VCS_MAIN_HEAD,
      repoPath: "packages/foo",
      eventId: expect.any(String),
      headHash: expect.any(String),
      stateHash: expect.any(String),
    });
    // The repo's main now exists and carries the first-commit files.
    const mainState = await vcs.resolveHead(VCS_MAIN_HEAD, "packages/foo");
    expect(mainState).toBeTruthy();
    const file = await vcs.readFile(VCS_MAIN_HEAD, "index.ts", "packages/foo");
    expect(file?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("export const x = 1;"),
    });
  });

  it("push fast-forwards when main is unchanged (a second commit on the same ctx)", async () => {
    await createOnContext("packages/foo", "ctx:work");
    await vcs.push({ repoPaths: ["packages/foo"], sourceHead: "ctx:work", actor: USER });
    // A further committed edit on the same ctx fast-forwards main again.
    await vcs.recordEdit({
      head: "ctx:work",
      actor: USER,
      repoPath: "packages/foo",
      edits: [{ kind: "write", path: "index.ts", content: text("export const x = 2;\n") }],
    });
    await vcs.commit({ head: "ctx:work", repoPath: "packages/foo", message: "bump", actor: USER });

    const result = await vcs.push({
      repoPaths: ["packages/foo"],
      sourceHead: "ctx:work",
      actor: USER,
    });
    expect(result.status).toBe("pushed");
    const file = await vcs.readFile(VCS_MAIN_HEAD, "index.ts", "packages/foo");
    expect(file?.content).toEqual(text("export const x = 2;\n"));
  });

  it("re-pushing an already-pushed ctx with no new commits is up-to-date", async () => {
    await createOnContext("packages/foo", "ctx:work");
    await vcs.push({ repoPaths: ["packages/foo"], sourceHead: "ctx:work", actor: USER });
    const again = await vcs.push({
      repoPaths: ["packages/foo"],
      sourceHead: "ctx:work",
      actor: USER,
    });
    expect(again.status).toBe("up-to-date");
  });

  it("rejects duplicate repoPaths after normalization", async () => {
    await createOnContext("packages/foo", "ctx:work");

    await expect(
      vcs.push({
        repoPaths: ["packages/foo", "packages/foo/"],
        sourceHead: "ctx:work",
        actor: USER,
      })
    ).rejects.toThrow(/duplicate repoPath "packages\/foo"/);
    expect(await vcs.resolveHead(VCS_MAIN_HEAD, "packages/foo")).toBeNull();
  });

  it("push rejects on uncommitted edits (the source head must be clean)", async () => {
    await createOnContext("packages/foo", "ctx:work");
    await vcs.push({ repoPaths: ["packages/foo"], sourceHead: "ctx:work", actor: USER });
    // A working (uncommitted) edit makes the ctx head dirty.
    await vcs.recordEdit({
      head: "ctx:work",
      actor: USER,
      repoPath: "packages/foo",
      edits: [{ kind: "write", path: "index.ts", content: text("export const x = 9;\n") }],
    });
    await expect(
      vcs.push({ repoPaths: ["packages/foo"], sourceHead: "ctx:work", actor: USER })
    ).rejects.toThrow(/uncommitted edits/);
    // main must NOT have advanced past the first push.
    const file = await vcs.readFile(VCS_MAIN_HEAD, "index.ts", "packages/foo");
    expect(file?.content).toEqual(text("export const x = 1;\n"));
  });

  it("push SUCCEEDS when validateRepoPush reports no required failures (regression: wiring read .ok off an array)", async () => {
    await createOnContext("packages/foo", "ctx:work");

    const result = await vcs.push({
      repoPaths: ["packages/foo"],
      sourceHead: "ctx:work",
      actor: USER,
      ...fakeBuildSystem([report({ repoPath: "packages/foo", required: true, status: "ok" })]),
    });

    // Before the fix, push read `validation.ok` (undefined) off the array and
    // always returned build-failed. It must now succeed.
    expect(result.status).toBe("pushed");
    expect(await vcs.resolveHead(VCS_MAIN_HEAD, "packages/foo")).toBeTruthy();
  });

  it("push returns build-failed (and does NOT advance main) on a required failure", async () => {
    await createOnContext("packages/foo", "ctx:work");

    const result = await vcs.push({
      repoPaths: ["packages/foo"],
      sourceHead: "ctx:work",
      actor: USER,
      ...fakeBuildSystem([report({ repoPath: "packages/foo", required: true, status: "failed" })]),
    });

    expect(result.status).toBe("build-failed");
    expect((result as { reports: Report[] }).reports).toHaveLength(1);
    // main must NOT have advanced.
    expect(await vcs.resolveHead(VCS_MAIN_HEAD, "packages/foo")).toBeNull();
  });

  it("runs beforeAdvance before the atomic head move and leaves main unchanged if denied", async () => {
    await createOnContext("packages/foo", "ctx:work");
    const beforeAdvance = async () => {
      throw new Error("denied");
    };

    await expect(
      vcs.push({
        repoPaths: ["packages/foo"],
        sourceHead: "ctx:work",
        actor: USER,
        beforeAdvance,
      })
    ).rejects.toThrow("denied");

    expect(await vcs.resolveHead(VCS_MAIN_HEAD, "packages/foo")).toBeNull();
  });

  it("a non-required (regression-gated) failure does NOT block the push", async () => {
    await createOnContext("packages/foo", "ctx:work");

    const result = await vcs.push({
      repoPaths: ["packages/foo"],
      sourceHead: "ctx:work",
      actor: USER,
      ...fakeBuildSystem([
        report({ repoPath: "packages/foo", required: true, status: "ok" }),
        report({ repoPath: "panels/dependent", required: false, status: "failed" }),
      ]),
    });

    expect(result.status).toBe("pushed");
  });

  it("rejects a phantom repo (no main, no content on source head)", async () => {
    await expect(
      vcs.push({ repoPaths: ["packages/ghost"], sourceHead: "ctx:work", actor: USER })
    ).rejects.toThrow(/unknown repo/);
  });

  it("push returns a structured {diverged} when main advanced past the ctx base; vcs.merge reconciles → push fast-forwards", async () => {
    // Seed packages/foo's main via the real edit → commit → push flow.
    await createOnContext("packages/foo", "ctx:work");
    await vcs.push({ repoPaths: ["packages/foo"], sourceHead: "ctx:work", actor: USER });

    // ctx:work edits + commits index.ts.
    await vcs.recordEdit({
      head: "ctx:work",
      actor: USER,
      repoPath: "packages/foo",
      edits: [{ kind: "write", path: "index.ts", content: text("export const x = 1; // ctx\n") }],
    });
    await vcs.commit({
      head: "ctx:work",
      repoPath: "packages/foo",
      message: "ctx edit",
      actor: USER,
    });

    // Concurrently, main advances on a DIFFERENT file via another context
    // (clean-mergeable), so ctx:work's base is now stale.
    const otherCtx = vcsContextHead("other");
    await vcs.recordEdit({
      head: otherCtx,
      actor: USER,
      repoPath: "packages/foo",
      edits: [{ kind: "create", path: "extra.ts", content: text("export const y = 2;\n") }],
    });
    await vcs.commit({
      head: otherCtx,
      repoPath: "packages/foo",
      message: "upstream extra",
      actor: USER,
    });
    expect(
      (await vcs.push({ repoPaths: ["packages/foo"], sourceHead: otherCtx, actor: USER })).status
    ).toBe("pushed");

    // Now ctx:work's push DIVERGES (no "conflicted" status anymore).
    const diverged = await vcs.push({
      repoPaths: ["packages/foo"],
      sourceHead: "ctx:work",
      actor: USER,
    });
    expect(diverged.status).toBe("diverged");
    if (diverged.status === "diverged") {
      expect(diverged.divergences).toHaveLength(1);
      expect(diverged.divergences[0]!.repoPath).toBe("packages/foo");
      expect(diverged.divergences[0]!.mergeable).toBe("clean");
      expect(diverged.divergences[0]!.upstreamCommits.length).toBeGreaterThanOrEqual(1);
    }
    // The diverged push did NOT advance main: extra.ts is on main, but the ctx
    // edit to index.ts is not yet folded in.
    expect((await vcs.readFile(VCS_MAIN_HEAD, "index.ts", "packages/foo"))?.content).toEqual(
      text("export const x = 1;\n")
    );

    // Reconcile with an explicit merge (clean → a merge commit, no resolution).
    const merge = await vcs.mergeHeads("ctx:work", VCS_MAIN_HEAD, {
      actor: USER,
      repoPath: "packages/foo",
    });
    expect(merge.status).toBe("merged");
    expect(merge.mergeable).toBe("clean");

    // Push now fast-forwards; main has BOTH the ctx edit and the upstream file.
    const pushed = await vcs.push({
      repoPaths: ["packages/foo"],
      sourceHead: "ctx:work",
      actor: USER,
    });
    expect(pushed.status).toBe("pushed");
    expect((await vcs.readFile(VCS_MAIN_HEAD, "index.ts", "packages/foo"))?.content).toEqual(
      text("export const x = 1; // ctx\n")
    );
    expect((await vcs.readFile(VCS_MAIN_HEAD, "extra.ts", "packages/foo"))?.content).toEqual(
      text("export const y = 2;\n")
    );
  });

  it("returns structured divergence when main moves after push preflight", async () => {
    await createOnContext("packages/foo", "ctx:work");
    await vcs.push({ repoPaths: ["packages/foo"], sourceHead: "ctx:work", actor: USER });

    await vcs.recordEdit({
      head: "ctx:work",
      actor: USER,
      repoPath: "packages/foo",
      edits: [{ kind: "write", path: "index.ts", content: text("export const x = 2;\n") }],
    });
    await vcs.commit({
      head: "ctx:work",
      repoPath: "packages/foo",
      message: "ctx edit",
      actor: USER,
    });

    let raced = false;
    const result = await vcs.push({
      repoPaths: ["packages/foo"],
      sourceHead: "ctx:work",
      actor: USER,
      beforeAdvance: async () => {
        if (raced) return;
        raced = true;
        const otherCtx = vcsContextHead("race");
        await vcs.recordEdit({
          head: otherCtx,
          actor: USER,
          repoPath: "packages/foo",
          edits: [
            { kind: "create", path: "race.ts", content: text("export const race = true;\n") },
          ],
        });
        await vcs.commit({
          head: otherCtx,
          repoPath: "packages/foo",
          message: "race main",
          actor: USER,
        });
        const pushed = await vcs.push({
          repoPaths: ["packages/foo"],
          sourceHead: otherCtx,
          actor: USER,
        });
        expect(pushed.status).toBe("pushed");
      },
    });

    expect(raced).toBe(true);
    expect(result.status).toBe("diverged");
    if (result.status === "diverged") {
      expect(result.divergences).toHaveLength(1);
      expect(result.divergences[0]!.repoPath).toBe("packages/foo");
      expect(result.divergences[0]!.upstreamCommits.length).toBeGreaterThanOrEqual(1);
    }
  });

  describe("forkRepo (history-preserving)", () => {
    // Seed panels/chat's main with a real commit so it has history to fork —
    // via the real edit → commit → push flow.
    async function seedChat(): Promise<void> {
      await vcs.recordEdit({
        head: "ctx:seed",
        actor: USER,
        repoPath: "panels/chat",
        edits: [
          {
            kind: "create",
            path: "package.json",
            content: text(`{\n  "name": "@workspace-panels/chat",\n  "natstack": {}\n}\n`),
          },
          { kind: "create", path: "index.tsx", content: text("export const Chat = () => null;\n") },
        ],
      });
      await vcs.commit({
        head: "ctx:seed",
        repoPath: "panels/chat",
        message: "seed chat",
        actor: USER,
      });
      await vcs.push({ repoPaths: ["panels/chat"], sourceHead: "ctx:seed", actor: USER });
    }

    it("forks a repo to a new path, preserving history and rewriting the package name", async () => {
      await seedChat();

      const fork = await vcs.forkRepo("panels/chat", "panels/mychat");

      expect(fork.repoPath).toBe("panels/mychat");
      expect(fork.inherited).toBeGreaterThanOrEqual(1);
      // New repo's main exists and inherits the source tree.
      expect(await vcs.resolveHead(VCS_MAIN_HEAD, "panels/mychat")).toBeTruthy();
      const idx = await vcs.readFile(VCS_MAIN_HEAD, "index.tsx", "panels/mychat");
      expect(idx?.content).toMatchObject({ kind: "text", text: expect.stringContaining("Chat") });
      // package.json name leaf rewritten to the new path (build-valid, no collision).
      const pkg = await vcs.readFile(VCS_MAIN_HEAD, "package.json", "panels/mychat");
      expect(pkg?.content).toMatchObject({
        kind: "text",
        text: expect.stringContaining("@workspace-panels/mychat"),
      });
      // The fork's log carries inherited history plus the rename commit.
      const log = await vcs.readVcsLog(100, VCS_MAIN_HEAD, "panels/mychat");
      expect(log.length).toBeGreaterThanOrEqual(1);
    });

    it("rejects forking onto an existing repo", async () => {
      await seedChat();
      await vcs.forkRepo("panels/chat", "panels/mychat");
      await expect(vcs.forkRepo("panels/chat", "panels/mychat")).rejects.toThrow(/already exists/);
    });

    it("rejects forking from a repo with no history", async () => {
      await expect(vcs.forkRepo("panels/ghost", "panels/clone")).rejects.toThrow(/no history/);
    });
  });
});
