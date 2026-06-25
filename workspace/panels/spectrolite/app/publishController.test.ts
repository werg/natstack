import { describe, it, expect, vi } from "vitest";
import {
  PublishController,
  type PublishVcs,
  type PublishPushResult,
} from "./publishController.js";

const VAULT_REPO = "projects/default";

function fakeVcs(overrides: Partial<PublishVcs> = {}): PublishVcs {
  return {
    pushStatus: vi.fn(async (repos: string[]) =>
      repos.map((repoPath) => ({
        repoPath,
        ahead: 0,
        uncommitted: 0,
        diverged: false,
        deleted: false,
        files: [],
      }))
    ),
    merge: vi.fn(async () => ({ status: "merged" as const, conflicts: [] })),
    push: vi.fn(
      async (): Promise<PublishPushResult> => ({
        status: "pushed",
        repoPaths: [VAULT_REPO],
        reports: [],
      })
    ),
    commit: vi.fn(async () => [
      {
        repoPath: VAULT_REPO,
        stateHash: "state:committed",
        status: "committed" as const,
        changedPaths: [],
      },
    ]),
    pendingMerge: vi.fn(async () => null),
    abortMerge: vi.fn(async () => ({ aborted: true })),
    contextStatus: vi.fn(async () => []),
    rebaseContext: vi.fn(async () => ({ repos: [], baseView: "state:base" })),
    ...overrides,
  };
}

function makeController(
  vcs: PublishVcs,
  onRebased?: () => void | Promise<void>,
  commitWorkingCopy?: (
    message: string
  ) => Promise<{ stateHash: string; changed: boolean; conflicted?: boolean } | null>
): PublishController {
  return new PublishController(vcs, VAULT_REPO, onRebased, commitWorkingCopy);
}

describe("PublishController", () => {
  it("refresh reports the unpublished count + files via pushStatus([vaultRepo])", async () => {
    const vcs = fakeVcs({
      pushStatus: vi.fn(async (repos: string[]) =>
        repos.map((repoPath) => ({
          repoPath,
          ahead: 2,
          uncommitted: 1,
          diverged: false,
          deleted: false,
          files: [
            { path: "A.mdx", kind: "changed" as const },
            { path: "B.mdx", kind: "added" as const },
          ],
        }))
      ),
    });
    const c = makeController(vcs);
    await c.refresh();
    expect(vcs.pushStatus).toHaveBeenCalledWith([VAULT_REPO]);
    expect(vcs.pendingMerge).toHaveBeenCalledWith(VAULT_REPO);
    expect(c.getSnapshot().ahead).toBe(2);
    expect(c.getSnapshot().uncommitted).toBe(1);
    expect(c.getSnapshot().files).toHaveLength(2);
  });

  it("refresh carries durable uncommitted and push-blocking repo states", async () => {
    const vcs = fakeVcs({
      pushStatus: vi.fn(async () => [
        {
          repoPath: VAULT_REPO,
          ahead: 0,
          uncommitted: 3,
          diverged: true,
          deleted: true,
          files: [],
        },
      ]),
    });
    const c = makeController(vcs);

    await c.refresh();

    expect(c.getSnapshot()).toMatchObject({
      ahead: 0,
      uncommitted: 3,
      diverged: true,
      deleted: true,
      behind: true,
    });
  });

  it("refresh marks the vault behind when the context base has drifted", async () => {
    const vcs = fakeVcs({
      contextStatus: vi.fn(async () => [
        { repoPath: VAULT_REPO, forked: true, ahead: false, behind: true },
      ]),
    });
    const c = makeController(vcs);
    await c.refresh();
    expect(c.getSnapshot().behind).toBe(true);
  });

  it("rebase() pulls latest main via rebaseContext and clears `behind` on refresh", async () => {
    let behind = true;
    const vcs = fakeVcs({
      // First refresh sees behind; after rebase the drift is gone.
      contextStatus: vi.fn(async () =>
        behind ? [{ repoPath: VAULT_REPO, forked: true, ahead: true, behind: true }] : []
      ),
      rebaseContext: vi.fn(async () => {
        behind = false;
        return { repos: [{ repoPath: VAULT_REPO, status: "merged" as const }], baseView: "state:new" };
      }),
    });
    const c = makeController(vcs);
    await c.refresh();
    expect(c.getSnapshot().behind).toBe(true);

    const status = await c.rebase();
    expect(status).toBe("merged");
    expect(vcs.rebaseContext).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().behind).toBe(false); // refresh() ran after rebase
  });

  it("rebase() invokes onRebased so the editor reloads even when no head advanced", async () => {
    // An unedited vault: rebaseContext only re-pins the base (empty repos, no
    // head advance). Without onRebased the editor would keep stale content.
    const vcs = fakeVcs({
      rebaseContext: vi.fn(async () => ({ repos: [], baseView: "state:new" })),
    });
    const onRebased = vi.fn(async () => {});
    const c = makeController(vcs, onRebased);
    const status = await c.rebase();
    expect(status).toBe("up-to-date");
    expect(onRebased).toHaveBeenCalledTimes(1);
  });

  it("publish pulls main then pushes the vault repo ctx→main", async () => {
    const vcs = fakeVcs();
    const c = makeController(vcs);
    const outcome = await c.publish();
    expect(vcs.merge).toHaveBeenCalledWith(VAULT_REPO);
    expect(vcs.push).toHaveBeenCalledWith({ repoPaths: [VAULT_REPO] });
    expect(outcome).toEqual({ status: "published" });
    expect(c.getSnapshot().publishing).toBe(false);
  });

  it("commits the working copy BEFORE pushing (one save+publish gesture)", async () => {
    const vcs = fakeVcs();
    const order: string[] = [];
    const commitWorkingCopy = vi.fn(async (message: string) => {
      order.push(`commit:${message}`);
      return { stateHash: "state:committed", changed: true };
    });
    (vcs.push as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("push");
      return { status: "pushed", repoPaths: [VAULT_REPO], reports: [] } as PublishPushResult;
    });
    const c = makeController(vcs, undefined, commitWorkingCopy);
    const outcome = await c.publish("My message");
    expect(outcome).toEqual({ status: "published" });
    expect(commitWorkingCopy).toHaveBeenCalledWith("My message");
    expect(order).toEqual(["commit:My message", "push"]);
  });

  it("a commit-time conflict parks a pending merge and skips the push", async () => {
    const vcs = fakeVcs({
      pendingMerge: vi.fn(async () => ({
        theirsHead: "main",
        conflicts: [{ path: "A.mdx", kind: "content" }],
      })),
    });
    const commitWorkingCopy = vi.fn(async () => ({
      stateHash: "state:x",
      changed: true,
      conflicted: true,
    }));
    const c = makeController(vcs, undefined, commitWorkingCopy);
    const outcome = await c.publish();
    expect(outcome).toEqual({ status: "needs-resolve" });
    expect(vcs.push).not.toHaveBeenCalled();
    expect(c.getSnapshot().pending).toMatchObject({ theirsHead: "main" });
  });

  it("completes a parked pending merge by committing resolved working edits before push", async () => {
    let pending: Awaited<ReturnType<PublishVcs["pendingMerge"]>> = {
      theirsHead: "main",
      conflicts: [{ path: "projects/default/A.mdx", kind: "content" }],
    };
    const vcs = fakeVcs({
      pendingMerge: vi.fn(async () => pending),
    });
    const commitWorkingCopy = vi.fn(async () => {
      pending = null;
      return { stateHash: "state:resolved", changed: true };
    });
    const c = makeController(vcs, undefined, commitWorkingCopy);

    await c.refresh();
    expect(c.getSnapshot().pending).toMatchObject({ theirsHead: "main" });

    const outcome = await c.publish("Resolve merge");

    expect(outcome).toEqual({ status: "published" });
    expect(commitWorkingCopy).toHaveBeenCalledWith("Resolve merge");
    expect(vcs.merge).toHaveBeenCalledWith(VAULT_REPO);
    expect(vcs.push).toHaveBeenCalledWith({ repoPaths: [VAULT_REPO] });
    expect(c.getSnapshot().pending).toBeNull();
  });

  it("falls back to repo-scoped commit when durable edits exist without an active doc", async () => {
    let uncommitted = 1;
    const vcs = fakeVcs({
      pushStatus: vi.fn(async () => [
        {
          repoPath: VAULT_REPO,
          ahead: 0,
          uncommitted,
          diverged: false,
          deleted: false,
          files: [],
        },
      ]),
      commit: vi.fn(async () => {
        uncommitted = 0;
        return [
          {
            repoPath: VAULT_REPO,
            stateHash: "state:fallback",
            status: "committed" as const,
            changedPaths: ["A.mdx"],
          },
        ];
      }),
    });
    const commitWorkingCopy = vi.fn(async () => null);
    const c = makeController(vcs, undefined, commitWorkingCopy);

    await c.refresh();
    const outcome = await c.publish("Publish durable edits");

    expect(outcome).toEqual({ status: "published" });
    expect(vcs.commit).toHaveBeenCalledWith({
      message: "Publish durable edits",
      repoPaths: [VAULT_REPO],
    });
    expect(vcs.push).toHaveBeenCalledWith({ repoPaths: [VAULT_REPO] });
  });

  it("a conflicting pull surfaces a pending merge in the panel's own head — push is NOT called", async () => {
    const vcs = fakeVcs({
      merge: vi.fn(async () => ({
        status: "conflicted" as const,
        conflicts: [{ path: "A.mdx", kind: "content" }],
      })),
      pendingMerge: vi.fn(async () => ({
        theirsHead: "main",
        conflicts: [{ path: "A.mdx", kind: "content" }],
      })),
    });
    const c = makeController(vcs);
    const outcome = await c.publish();
    expect(outcome).toEqual({ status: "needs-resolve" });
    expect(vcs.push).not.toHaveBeenCalled();
    expect(vcs.pendingMerge).toHaveBeenCalledWith(VAULT_REPO);
    expect(c.getSnapshot().pending).toMatchObject({ theirsHead: "main" });
  });

  it("up-to-date push reports up-to-date", async () => {
    const vcs = fakeVcs({
      merge: vi.fn(async () => ({ status: "up-to-date" as const, conflicts: [] })),
      push: vi.fn(
        async (): Promise<PublishPushResult> => ({
          status: "up-to-date",
          repoPaths: [VAULT_REPO],
          reports: [],
        })
      ),
    });
    const c = makeController(vcs);
    expect(await c.publish()).toEqual({ status: "up-to-date" });
  });

  it("a diverged push re-pulls main and retries (TOCTOU), then succeeds", async () => {
    let pushes = 0;
    const vcs = fakeVcs({
      push: vi.fn(async (): Promise<PublishPushResult> => {
        pushes += 1;
        return pushes === 1
          ? {
              status: "diverged",
              divergences: [{ repoPath: VAULT_REPO, mergeable: "clean" }],
            }
          : { status: "pushed", repoPaths: [VAULT_REPO], reports: [] };
      }),
    });
    const c = makeController(vcs);
    const outcome = await c.publish();
    expect(outcome).toEqual({ status: "published" });
    expect(vcs.merge).toHaveBeenCalledTimes(2);
    expect(vcs.push).toHaveBeenCalledTimes(2);
  });

  it("a build-failed push does NOT advance main and surfaces the report", async () => {
    const reports = [
      {
        repoPath: VAULT_REPO,
        kind: "content",
        role: "pushed" as const,
        status: "failed" as const,
        builds: [
          {
            target: "runtime",
            diagnostics: [
              {
                source: "tsc" as const,
                severity: "error" as const,
                file: "projects/default/note.mdx",
                line: 3,
                column: 1,
                message: "boom",
              },
            ],
          },
        ],
      },
    ];
    const vcs = fakeVcs({
      push: vi.fn(async (): Promise<PublishPushResult> => ({ status: "build-failed", reports })),
    });
    const c = makeController(vcs);
    const outcome = await c.publish();
    expect(outcome).toEqual({ status: "build-failed", reports });
    expect(c.getSnapshot().buildReport).toEqual(reports);
    expect(c.getSnapshot().publishing).toBe(false);
  });

  it("abort clears the pending merge and refreshes", async () => {
    const vcs = fakeVcs({ pendingMerge: vi.fn(async () => null) });
    const c = makeController(vcs);
    await c.abort();
    expect(vcs.abortMerge).toHaveBeenCalledWith(VAULT_REPO);
    expect(c.getSnapshot().pending).toBeNull();
  });

  it("notifies subscribers on change", async () => {
    const c = makeController(fakeVcs());
    const listener = vi.fn();
    const off = c.subscribe(listener);
    await c.refresh();
    expect(listener).toHaveBeenCalled();
    off();
  });

  it("surfaces errors without throwing", async () => {
    const vcs = fakeVcs({
      merge: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const c = makeController(vcs);
    const outcome = await c.publish();
    expect(outcome).toEqual({ status: "error", message: "boom" });
    expect(c.getSnapshot().lastError).toBe("boom");
    expect(c.getSnapshot().publishing).toBe(false);
  });

  it("exposes the bound repo", () => {
    expect(makeController(fakeVcs()).getRepo()).toBe(VAULT_REPO);
  });
});
