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

describe("WorkspaceVcs.ensureRepoLogsFromDisk (disk bootstrap)", () => {
  let root: string;
  let workspaceRoot: string;
  let vcs: WorkspaceVcs;
  let gad: TestGad;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-boot-"));
    workspaceRoot = path.join(root, "source");
    // Seed an on-disk workspace source tree: a build unit + a content repo + meta.
    await fsp.mkdir(path.join(workspaceRoot, "panels/chat"), { recursive: true });
    await fsp.writeFile(
      path.join(workspaceRoot, "panels/chat/index.tsx"),
      "export const Chat = () => null;\n"
    );
    await fsp.mkdir(path.join(workspaceRoot, "skills/onboarding"), { recursive: true });
    await fsp.writeFile(
      path.join(workspaceRoot, "skills/onboarding/ActionBar.tsx"),
      "export const ActionBar = () => null;\n"
    );
    await fsp.writeFile(path.join(workspaceRoot, "skills/onboarding/SKILL.md"), "# Onboarding\n");
    await fsp.mkdir(path.join(workspaceRoot, "packages/foo"), { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "packages/foo/index.ts"), "export const x = 1;\n");
    await fsp.mkdir(path.join(workspaceRoot, "meta"), { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "meta/natstack.yml"), "name: test\n");

    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    vcs = new WorkspaceVcs({
      blobsDir: path.join(root, "blobs"),
      workspaceRoot,
      contextsRoot: path.join(root, ".contexts"),
      buildSourcesRoot: path.join(root, "build-sources"),
    });
    await vcs.attachGad(callerFor(gad)); // triggers ensureRepoLogsFromDisk
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const USER = { id: "user", kind: "user" };
  const text = (t: string) => ({ kind: "text" as const, text: t });

  // Edit a repo on a context head and commit it (the edit → commit that forks the
  // ctx head). recordEdit alone records UNCOMMITTED working ops and never forks a
  // ctx head; the head is created by commit. Returns the committed state hash.
  async function editOn(ctxId: string, repoPath: string, file: string, body: string) {
    const head = vcsContextHead(ctxId);
    await vcs.recordEdit({
      head,
      actor: USER,
      repoPath,
      edits: [{ kind: "write", path: file, content: text(body) }],
    });
    await vcs.commit({ head, repoPath, message: `edit ${file}`, actor: USER });
  }

  // Advance a repo's MAIN via the real flow: edit → commit → push on a throwaway
  // context (main now advances ONLY via push, never a direct applyEdits), then
  // drop the seeding context.
  async function advanceMain(repoPath: string, file: string, body: string) {
    const seedId = `__advance__${repoPath.replace(/\W+/g, "_")}__${file.replace(/\W+/g, "_")}`;
    const seedHead = vcsContextHead(seedId);
    await vcs.recordEdit({
      head: seedHead,
      actor: USER,
      repoPath,
      edits: [{ kind: "write", path: file, content: text(body) }],
    });
    await vcs.commit({ head: seedHead, repoPath, message: `advance ${file}`, actor: USER });
    const pushed = await vcs.push({ repoPaths: [repoPath], sourceHead: seedHead, actor: USER });
    expect(pushed.status).toBe("pushed");
    await vcs.dropContext(seedId);
  }

  it("creates a per-repo main for EVERY on-disk repo (content + build + meta), with content", async () => {
    // The content repo must have a main with its files — this is the onboarding bug.
    const skillsMain = await vcs.resolveHead(VCS_MAIN_HEAD, "skills/onboarding");
    expect(skillsMain).toBeTruthy();
    const action = await vcs.readFile(VCS_MAIN_HEAD, "ActionBar.tsx", "skills/onboarding");
    expect(action?.content).toMatchObject({ kind: "text" });

    expect(await vcs.resolveHead(VCS_MAIN_HEAD, "packages/foo")).toBeTruthy();
    expect(await vcs.resolveHead(VCS_MAIN_HEAD, "panels/chat")).toBeTruthy();
    expect(await vcs.resolveHead(VCS_MAIN_HEAD, "meta")).toBeTruthy();
  });

  it("ensureFresh commits an EXISTING repo's out-of-band disk change (git-import case)", async () => {
    // `meta` already has a main from bootstrap.
    expect((await vcs.readFile(VCS_MAIN_HEAD, "natstack.yml", "meta"))?.content).toMatchObject({
      kind: "text",
      text: "name: test\n",
    });

    // A git import rewrites meta/natstack.yml on disk.
    await fsp.writeFile(path.join(workspaceRoot, "meta/natstack.yml"), "name: imported\n");

    // ensureRepoLogsFromDisk SKIPS repos that already have a main → still stale.
    await vcs.ensureRepoLogsFromDisk();
    expect((await vcs.readFile(VCS_MAIN_HEAD, "natstack.yml", "meta"))?.content).toMatchObject({
      text: "name: test\n",
    });

    // ensureFresh re-snapshots every present repo → the change reaches vcs:repo:meta.
    await vcs.ensureFresh();
    expect((await vcs.readFile(VCS_MAIN_HEAD, "natstack.yml", "meta"))?.content).toMatchObject({
      kind: "text",
      text: "name: imported\n",
    });
  });

  it("ensureContextFolder is SPARSE — it materializes nothing up front", async () => {
    const { dir } = await vcs.ensureContextFolder("test");
    const sections = await fsp.readdir(dir).catch(() => []);
    // The folder exists but holds no repo content (sparse).
    expect(sections.filter((s) => s !== ".gad")).toEqual([]);
    expect(vcs.isContextRepoMaterialized("test", "skills/onboarding")).toBe(false);
  });

  it("materializeContextRepos writes ONLY the requested repo (minimal scope, never blanket)", async () => {
    const { dir } = await vcs.ensureContextFolder("test");
    await vcs.materializeContextRepos("test", ["skills/onboarding"]);
    // The requested repo is on disk…
    expect(
      await fsp
        .readFile(path.join(dir, "skills/onboarding/ActionBar.tsx"), "utf8")
        .catch(() => null)
    ).toContain("ActionBar");
    expect(vcs.isContextRepoMaterialized("test", "skills/onboarding")).toBe(true);
    // …and NOTHING else is — a different repo stays absent (sparse, not "all").
    expect(
      await fsp.readFile(path.join(dir, "packages/foo/index.ts"), "utf8").catch(() => null)
    ).toBeNull();
    expect(vcs.isContextRepoMaterialized("test", "packages/foo")).toBe(false);
  });

  it("materializeContextRepos includes repos that only have uncommitted working edits", async () => {
    const ctxId = "ctx-working-only";
    const repoPath = "projects/fresh";
    const head = vcsContextHead(ctxId);
    await vcs.ensureContextFolder(ctxId);
    await vcs.recordEdit({
      head,
      actor: USER,
      repoPath,
      edits: [{ kind: "create", path: "Welcome.mdx", content: text("# Fresh\n") }],
    });

    // Simulate a process restart / cache loss: durable working edit rows remain
    // in GAD, but the in-memory materialized map and context disk projection are gone.
    await fsp.rm(path.join(root, ".contexts", ctxId), { recursive: true, force: true });
    const restarted = new WorkspaceVcs({
      blobsDir: path.join(root, "blobs"),
      workspaceRoot,
      contextsRoot: path.join(root, ".contexts"),
      buildSourcesRoot: path.join(root, "build-sources"),
    });
    await restarted.attachGad(callerFor(gad));
    const { dir } = await restarted.ensureContextFolder(ctxId);

    await restarted.materializeContextRepos(ctxId, [repoPath]);

    expect(
      await fsp.readFile(path.join(dir, "projects/fresh/Welcome.mdx"), "utf8").catch(() => null)
    ).toBe("# Fresh\n");
    expect(restarted.isContextRepoMaterialized(ctxId, repoPath)).toBe(true);
  });

  it("materializeContextRepos expands a SECTION prefix to its repos, and 'all' covers everything", async () => {
    const ctxId = "ctx-scope";
    const dir = path.join(root, ".contexts", ctxId);
    await vcs.ensureContextFolder(ctxId);
    // A section prefix materializes only repos under it (here: panels/chat).
    await vcs.materializeContextRepos(ctxId, ["panels"]);
    expect(
      await fsp.readFile(path.join(dir, "panels/chat/index.tsx"), "utf8").catch(() => null)
    ).toContain("Chat");
    expect(
      await fsp
        .readFile(path.join(dir, "skills/onboarding/ActionBar.tsx"), "utf8")
        .catch(() => null)
    ).toBeNull();
    // "all" → everything (genuine workspace-wide).
    await vcs.materializeContextRepos(ctxId, "all");
    expect(
      await fsp
        .readFile(path.join(dir, "skills/onboarding/ActionBar.tsx"), "utf8")
        .catch(() => null)
    ).toContain("ActionBar");
    expect(
      await fsp.readFile(path.join(dir, "meta/natstack.yml"), "utf8").catch(() => null)
    ).toContain("test");
  });

  it("a context can edit ANY repo (lazy ctx fork) and read the pinned base for the rest", async () => {
    const ctxId = "ctx1";
    const head = vcsContextHead(ctxId);
    await vcs.pinContext(ctxId); // pin to current workspaceView

    // Edit a repo the context does NOT "own" — skills/onboarding — with no
    // pre-fork. recordEdit records the working ops over the pinned base; commit
    // forks the ctx head.
    const base = await vcs.resolveHead(VCS_MAIN_HEAD, "skills/onboarding");
    expect(base).toBeTruthy();
    await vcs.recordEdit({
      head,
      actor: USER,
      repoPath: "skills/onboarding",
      edits: [
        {
          kind: "write",
          path: "ActionBar.tsx",
          content: text("export const ActionBar = () => 42;\n"),
        },
      ],
    });
    await vcs.commit({ head, repoPath: "skills/onboarding", message: "edit", actor: USER });
    // The ctx head now exists (forked at commit); skills/onboarding's main is untouched.
    expect(await vcs.resolveHead(head, "skills/onboarding")).toBeTruthy();
    expect(await vcs.resolveHead(VCS_MAIN_HEAD, "skills/onboarding")).toBe(base);

    // The composed view: edited repo at its ctx head, everything else at the pin.
    const view = await vcs.resolveContextView(ctxId);
    const edited = await vcs.readFile(view, "skills/onboarding/ActionBar.tsx");
    expect(edited?.content).toMatchObject({ kind: "text", text: expect.stringContaining("=> 42") });
    const unedited = await vcs.readFile(view, "packages/foo/index.ts");
    expect(unedited?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("export const x = 1"),
    });
  });

  it("pins reads to baseView — main advancing under the context does not drift it", async () => {
    const ctxId = "ctx2";
    const baseView = await vcs.pinContext(ctxId); // pin to current workspaceView

    // Advance packages/foo's MAIN after the pin (as if another push landed).
    await advanceMain("packages/foo", "index.ts", "export const x = 999;\n");

    // The unedited pinned context still reads the OLD value — it IS the pin.
    const view = await vcs.resolveContextView(ctxId);
    expect(view).toBe(baseView);
    const foo = await vcs.readFile(view, "packages/foo/index.ts");
    expect(foo?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("export const x = 1;"),
    });
  });

  it("Tier 1: dropContext deletes the context's ctx heads + pin + caches (no orphans)", async () => {
    const ctxId = "ctx-drop";
    const head = vcsContextHead(ctxId);
    await vcs.pinContext(ctxId);
    await editOn(ctxId, "packages/foo", "index.ts", "export const x = 2;\n");
    expect(await vcs.resolveHead(head, "packages/foo")).toBeTruthy();
    expect(vcs.isContextRepoMaterialized(ctxId, "packages/foo")).toBe(true);
    expect(await vcs.contextBaseView(ctxId)).toBeTruthy();

    await vcs.dropContext(ctxId);

    expect(await vcs.resolveHead(head, "packages/foo")).toBeNull();
    expect(vcs.isContextRepoMaterialized(ctxId, "packages/foo")).toBe(false);
    expect(await vcs.contextBaseView(ctxId)).toBeNull();
  });

  it("Tier 2: rebaseContext re-pins to latest (unedited repo advances) and keeps edits", async () => {
    const ctxId = "ctx-reb";
    await vcs.pinContext(ctxId);
    await editOn(ctxId, "panels/chat", "index.tsx", "export const Chat = () => 1;\n");
    await advanceMain("packages/foo", "index.ts", "export const x = 7;\n");

    // Before rebase: context reads the OLD (pinned) packages/foo.
    let view = await vcs.resolveContextView(ctxId);
    expect((await vcs.readFile(view, "packages/foo/index.ts"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("x = 1"),
    });

    const res = await vcs.rebaseContext(ctxId, USER);
    expect(res.repos.find((r) => r.repoPath === "panels/chat")).toBeTruthy();

    // After rebase: packages/foo advanced to latest (re-pinned), chat edit kept.
    view = await vcs.resolveContextView(ctxId);
    expect((await vcs.readFile(view, "packages/foo/index.ts"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("x = 7"),
    });
    expect((await vcs.readFile(view, "panels/chat/index.tsx"))?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("=> 1"),
    });
  });

  it("Tier 3: contextStatus reports forked/ahead/behind", async () => {
    const ctxId = "ctx-stat";
    await vcs.pinContext(ctxId);
    await editOn(ctxId, "panels/chat", "index.tsx", "export const Chat = () => 9;\n");
    await advanceMain("packages/foo", "index.ts", "export const x = 5;\n");

    const status = await vcs.contextStatus(ctxId);
    expect(status.find((s) => s.repoPath === "panels/chat")).toMatchObject({
      forked: true,
      ahead: true,
    });
    expect(status.find((s) => s.repoPath === "packages/foo")).toMatchObject({
      forked: false,
      behind: true,
    });
  });

  it("contextStatus does not mark an already-pushed stale ctx head as ahead", async () => {
    const ctxId = "ctx-stale";
    const head = vcsContextHead(ctxId);
    await vcs.pinContext(ctxId);
    await editOn(ctxId, "panels/chat", "index.tsx", "export const Chat = () => 10;\n");
    expect(
      (await vcs.push({ repoPaths: ["panels/chat"], sourceHead: head, actor: USER })).status
    ).toBe("pushed");

    await advanceMain("panels/chat", "index.tsx", "export const Chat = () => 11;\n");

    const status = await vcs.contextStatus(ctxId);
    expect(status.find((s) => s.repoPath === "panels/chat")).toMatchObject({
      forked: true,
      ahead: false,
      behind: true,
    });
  });

  it("Tier 4: gcLegacyWorkspaceLog is a no-op after the structured-head schema cut", async () => {
    const res = await vcs.gcLegacyWorkspaceLog();
    expect(res.deleted).toBe(0);
  });

  it("Tier 4: a brand-new repo created mid-session gets a ctx head + first push creates main", async () => {
    const ctxId = "ctx-new";
    const head = vcsContextHead(ctxId);
    await vcs.pinContext(ctxId);
    expect(await vcs.resolveHead(VCS_MAIN_HEAD, "panels/brandnew")).toBeNull();
    await editOn(
      ctxId,
      "panels/brandnew",
      "package.json",
      '{ "name": "@workspace-panels/brandnew" }\n'
    );
    expect(await vcs.resolveHead(head, "panels/brandnew")).toBeTruthy();
    await vcs.push({ repoPaths: ["panels/brandnew"], sourceHead: head, actor: USER });
    expect(await vcs.resolveHead(VCS_MAIN_HEAD, "panels/brandnew")).toBeTruthy();
  });

  it("a ctx-head commit emits a build event whose state is the composed CONTEXT view (workspace-rooted, not a repo subtree)", async () => {
    const ctxId = "ctx-build";
    await vcs.pinContext(ctxId);
    const events: StateAdvancedEvent[] = [];
    const off = vcs.onStateAdvanced((e) => events.push(e));
    try {
      // recordEdit emits working-advanced (build trigger ignores); commit emits
      // the state-advanced the build trigger acts on.
      await vcs.recordEdit({
        head: vcsContextHead(ctxId),
        actor: USER,
        repoPath: "skills/onboarding",
        edits: [
          {
            kind: "write",
            path: "ActionBar.tsx",
            content: text("export const ActionBar = () => 7;\n"),
          },
        ],
      });
      await vcs.commit({
        head: vcsContextHead(ctxId),
        repoPath: "skills/onboarding",
        message: "edit action bar",
        actor: USER,
      });
    } finally {
      off();
    }
    const event = events.at(-1)!;
    expect(event.repoPath).toBe("skills/onboarding");

    // The build trigger reads event.stateHash/sinceStateHash as WORKSPACE-ROOTED
    // composed states. Proof it's the composed context view, not the edited repo's
    // subtree: OTHER repos are readable at event.stateHash...
    const otherRepo = await vcs.readFile(event.stateHash, "packages/foo/index.ts");
    expect(otherRepo?.content).toMatchObject({ kind: "text" });
    // ...and the edit IS reflected at event.stateHash (the ctx head is overlaid).
    const edited = await vcs.readFile(event.stateHash, "skills/onboarding/ActionBar.tsx");
    expect(edited?.content).toMatchObject({ kind: "text", text: expect.stringContaining("=> 7") });
    // sinceStateHash is the composed view BEFORE the edit (also workspace-rooted)
    // — the edited file there is the pre-edit content.
    expect(event.sinceStateHash).toBeTruthy();
    const before = await vcs.readFile(event.sinceStateHash!, "skills/onboarding/ActionBar.tsx");
    expect(before?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("() => null"),
    });
  });

  it("rebaseContext does NOT re-pin when a repo conflicts (context stays `behind`)", async () => {
    const ctxId = "ctx-conflict";
    await vcs.pinContext(ctxId);
    // The context and main both rewrite the SAME line of ActionBar.tsx → the
    // rebase merge conflicts on skills/onboarding.
    await editOn(
      ctxId,
      "skills/onboarding",
      "ActionBar.tsx",
      "export const ActionBar = () => 'ctx';\n"
    );
    await advanceMain(
      "skills/onboarding",
      "ActionBar.tsx",
      "export const ActionBar = () => 'main';\n"
    );

    const res = await vcs.rebaseContext(ctxId, USER);
    expect(res.repos.find((r) => r.repoPath === "skills/onboarding")?.status).toBe("conflicted");

    // Base must NOT have moved — the context still reports the conflicted repo as
    // `behind` (re-pinning would have falsely marked it caught-up).
    const status = await vcs.contextStatus(ctxId);
    expect(status.find((s) => s.repoPath === "skills/onboarding")?.behind).toBe(true);
  });
});
