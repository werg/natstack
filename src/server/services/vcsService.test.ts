import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { describe, expect, it, vi } from "vitest";
import { EntityCache } from "@natstack/shared/runtime/entityCache";
import type { EntityKind } from "@natstack/shared/runtime/entitySpec";
import { createVcsService } from "./vcsService.js";

function panelCaller(id = "panel-source") {
  return createVerifiedCaller(id, "panel", {
    callerId: id,
    callerKind: "panel",
    repoPath: "panels/source",
    effectiveVersion: "version-1",
  });
}

function entityCacheWithContext(
  callerId: string,
  contextId: string,
  kind: EntityKind = "panel"
): EntityCache {
  const entityCache = new EntityCache();
  entityCache._onActivate({
    id: callerId,
    kind,
    source: { repoPath: "panels/source", effectiveVersion: "version-1" },
    contextId,
    key: callerId,
    createdAt: Date.now(),
    status: "active",
    cleanupComplete: true,
  });
  return entityCache;
}

describe("vcsService", () => {
  describe("status / write authorization", () => {
    it("rejects explicit foreign heads for context-bound callers", async () => {
      // The head-write gate is shared by every write method; exercise it
      // through `merge`. In the new model merge(repoPath, head?) pulls main INTO
      // the named ctx head, so the `head` arg is the head being written.
      const mergeHeads = vi.fn();
      const service = createVcsService({
        workspaceVcs: { mergeHeads } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "merge", ["panels/source", "ctx:ctx-2"])
      ).rejects.toThrow("Callers may only write their own context head (ctx:ctx-1)");
      expect(mergeHeads).not.toHaveBeenCalled();
    });

    it("allows shell callers to read an explicit head's status", async () => {
      const statusHead = vi.fn(async () => ({
        stateHash: "state:abc",
        dirty: true,
        added: ["panels/source/index.ts"],
        removed: [],
        changed: [],
      }));
      const service = createVcsService({
        workspaceVcs: { statusHead } as never,
      });
      const shell = createVerifiedCaller("shell:dev_cli", "shell");

      // Per-repo status(repoArg, headArg?): read an explicit head on a repo.
      const result = await service.handler({ caller: shell }, "status", [
        "panels/source",
        "ctx:ctx-1",
      ]);

      expect(statusHead).toHaveBeenCalledWith("ctx:ctx-1", "panels/source");
      expect(result).toMatchObject({ stateHash: "state:abc", dirty: true });
    });

    it("scopes status to a repo when a repoPath is given", async () => {
      const statusHead = vi.fn(async () => ({
        stateHash: "state:abc",
        dirty: false,
        added: [],
        removed: [],
        changed: [],
      }));
      const service = createVcsService({
        workspaceVcs: { statusHead } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      // repoArg only → defaults the head to the caller's own context head.
      await service.handler({ caller: panelCaller() }, "status", ["panels/source"]);

      expect(statusHead).toHaveBeenCalledWith("ctx:ctx-1", "panels/source");
    });

    it("resolveHead defaults to the caller's context head when the arg is omitted", async () => {
      const resolveHead = vi.fn(async () => "state:ctxhead");
      const service = createVcsService({
        workspaceVcs: { resolveHead } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = await service.handler({ caller: panelCaller() }, "resolveHead", [
        undefined,
        "panels/source",
      ]);

      expect(resolveHead).toHaveBeenCalledWith("ctx:ctx-1", "panels/source");
      expect(result).toEqual({ head: "ctx:ctx-1", stateHash: "state:ctxhead" });
    });

    it("resolveHead still resolves an explicit ref", async () => {
      const resolveHead = vi.fn(async () => "state:mainhead");
      const service = createVcsService({
        workspaceVcs: { resolveHead } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = await service.handler({ caller: panelCaller() }, "resolveHead", [
        "main",
        "panels/source",
      ]);

      expect(resolveHead).toHaveBeenCalledWith("main", "panels/source");
      expect(result).toEqual({ head: "main", stateHash: "state:mainhead" });
    });

    it("allows context callers to inspect an explicit (foreign) head", async () => {
      const statusHead = vi.fn(async () => ({
        stateHash: "state:foreign",
        dirty: false,
        added: [],
        removed: [],
        changed: [],
      }));
      const service = createVcsService({
        workspaceVcs: { statusHead } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = await service.handler({ caller: panelCaller() }, "status", [
        "panels/source",
        "ctx:ctx-2",
      ]);

      expect(statusHead).toHaveBeenCalledWith("ctx:ctx-2", "panels/source");
      expect(result).toMatchObject({ stateHash: "state:foreign", dirty: false });
    });

    it("rejects an invalid repo path arg to status", async () => {
      const statusHead = vi.fn();
      const service = createVcsService({
        workspaceVcs: { statusHead } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      // "root" is a single-segment, non-flat-section path → not a valid repo.
      await expect(service.handler({ caller: panelCaller() }, "status", ["root"])).rejects.toThrow(
        /Invalid workspace repo path/
      );
      expect(statusHead).not.toHaveBeenCalled();
    });

    it("rejects non-state-hash diff args with actionable VCS guidance", async () => {
      const diffStates = vi.fn();
      const service = createVcsService({
        workspaceVcs: { vcs: { diffStates } } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "diff", ["main", "state:abc"])
      ).rejects.toThrow("vcs.diff expects left to be a GAD state hash");
      expect(diffStates).not.toHaveBeenCalled();
    });

    it("composes a buildable workspace state from a repo state", async () => {
      const workspaceViewWithRepoAt = vi.fn(async () => "state:workspace");
      const service = createVcsService({
        workspaceVcs: { workspaceViewWithRepoAt } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = await service.handler({ caller: panelCaller() }, "workspaceViewWithRepoAt", [
        "panels/source",
        "state:repo",
      ]);

      expect(workspaceViewWithRepoAt).toHaveBeenCalledWith("panels/source", "state:repo");
      expect(result).toEqual({ stateHash: "state:workspace" });
    });

    it("rejects non-state refs when composing a workspace state", async () => {
      const workspaceViewWithRepoAt = vi.fn();
      const service = createVcsService({
        workspaceVcs: { workspaceViewWithRepoAt } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "workspaceViewWithRepoAt", [
          "panels/source",
          "ctx:ctx-1",
        ])
      ).rejects.toThrow("vcs.workspaceViewWithRepoAt expects stateHash to be a GAD state hash");
      expect(workspaceViewWithRepoAt).not.toHaveBeenCalled();
    });
  });

  describe("merge authorization", () => {
    // New model: `merge(repoPath, head?)` RECONCILES — it pulls `main` INTO the
    // named ctx head (a merge commit), it never merges INTO main. So the `head`
    // arg is the head being written; main as a target is rejected outright.
    function mergeService(opts: { entityCache?: EntityCache } = {}) {
      const mergeHeads = vi.fn(async () => ({
        status: "merged" as const,
        stateHash: "state:merged",
        conflicts: [],
        mergeable: "clean" as const,
        upstreamCommits: [],
      }));
      const service = createVcsService({
        workspaceVcs: { mergeHeads } as never,
        ...(opts.entityCache ? { entityCache: opts.entityCache } : {}),
      });
      return { service, mergeHeads };
    }

    it("rejects targeting the main head (merge pulls main into a ctx head)", async () => {
      const { service, mergeHeads } = mergeService({
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      // A privileged-looking explicit `main` target: the write-head gate first
      // confines the panel to its own ctx head, so it never reaches main.
      await expect(
        service.handler({ caller: panelCaller() }, "merge", ["panels/source", "main"])
      ).rejects.toThrow("Callers may only write their own context head (ctx:ctx-1)");
      expect(mergeHeads).not.toHaveBeenCalled();
    });

    it("rejects a contextless panel caller whose implicit target is main", async () => {
      const { service, mergeHeads } = mergeService({ entityCache: new EntityCache() });

      await expect(
        service.handler({ caller: panelCaller() }, "merge", ["panels/source"])
      ).rejects.toThrow("vcs head writes require a context");
      expect(mergeHeads).not.toHaveBeenCalled();
    });

    it("rejects a panel caller reconciling into another context's head", async () => {
      const { service, mergeHeads } = mergeService({
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "merge", ["panels/source", "ctx:ctx-other"])
      ).rejects.toThrow("Callers may only write their own context head (ctx:ctx-1)");
      expect(mergeHeads).not.toHaveBeenCalled();
    });

    it("allows a panel caller to pull main into its own context head", async () => {
      const { service, mergeHeads } = mergeService({
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      // repoPath only → the head defaults to the caller's own ctx head.
      const result = (await service.handler({ caller: panelCaller() }, "merge", [
        "panels/source",
      ])) as {
        status: string;
      };

      // mergeHeads(targetCtxHead, "main", { actor, repoPath }) — main pulled INTO ctx.
      expect(mergeHeads).toHaveBeenCalledWith(
        "ctx:ctx-1",
        "main",
        expect.objectContaining({
          actor: { id: "panel-source", kind: "panel" },
          repoPath: "panels/source",
        })
      );
      expect(result.status).toBe("merged");
    });

    it("does NOT pass a main-advance hook into merge (merge never advances main)", async () => {
      const approve = vi.fn(async () => {});
      const mergeHeads = vi.fn(async () => ({
        status: "merged" as const,
        stateHash: "state:merged",
        conflicts: [],
        mergeable: "clean" as const,
        upstreamCommits: [],
      }));
      const service = createVcsService({
        workspaceVcs: { mergeHeads } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
        mainAdvanceGate: {
          approve,
          approveRepoDeletion: vi.fn(async () => {}),
          approveRepoRestore: vi.fn(async () => {}),
        },
      });

      await service.handler({ caller: panelCaller() }, "merge", ["panels/source"]);

      const [, , mergeOpts] = mergeHeads.mock.calls[0] as unknown as [
        string,
        string,
        Record<string, unknown>,
      ];
      // No beforeAdvance/main approval threads through a reconcile.
      expect(mergeOpts).not.toHaveProperty("beforeAdvance");
      expect(approve).not.toHaveBeenCalled();
    });

    it("lets a privileged shell caller reconcile an explicit ctx head", async () => {
      const { service, mergeHeads } = mergeService();
      const caller = createVerifiedCaller("shell:dev_cli", "shell");

      const result = (await service.handler({ caller }, "merge", [
        "panels/source",
        "ctx:ctx-1",
      ])) as { status: string };

      expect(mergeHeads).toHaveBeenCalledWith(
        "ctx:ctx-1",
        "main",
        expect.objectContaining({ repoPath: "panels/source" })
      );
      expect(result.status).toBe("merged");
    });
  });

  describe("abortMerge authorization", () => {
    it("gates shell aborts of pending main merges", async () => {
      const abortMerge = vi.fn(async () => ({ aborted: true }));
      const approve = vi.fn(async () => {});
      const service = createVcsService({
        workspaceVcs: { abortMerge } as never,
        mainAdvanceGate: {
          approve,
          approveRepoDeletion: vi.fn(async () => {}),
          approveRepoRestore: vi.fn(async () => {}),
        },
      });
      const shell = createVerifiedCaller("shell:dev_cli", "shell");

      const result = (await service.handler({ caller: shell }, "abortMerge", [
        "panels/source",
        "main",
      ])) as {
        aborted: boolean;
      };

      expect(result.aborted).toBe(true);
      expect(abortMerge).toHaveBeenCalledWith(
        "main",
        expect.objectContaining({
          actor: { id: "shell:dev_cli", kind: "shell" },
          beforeAdvance: expect.any(Function),
          repoPath: "panels/source",
        })
      );

      const [, abortOpts] = abortMerge.mock.calls[0] as unknown as [
        string,
        { beforeAdvance?: (event: never) => Promise<void> | void },
      ];
      const beforeAdvance = abortOpts.beforeAdvance;
      const event = {
        head: "main",
        stateHash: "state:ours",
        sinceStateHash: "state:provisional",
        eventId: null,
        headHash: null,
        actor: { id: "shell:dev_cli", kind: "shell" },
        transitionKind: "merge-resolution",
        changedPaths: ["apps/shell/index.tsx"],
        fileChanges: [],
        editOps: [],
      } as never;
      await beforeAdvance?.(event);

      expect(approve).toHaveBeenCalledWith(
        expect.objectContaining({
          caller: shell,
          event,
          operation: "abort-merge",
        })
      );
    });

    it("defaults pendingMerge(repoPath) to the caller's own context head", async () => {
      const pendingMerge = vi.fn(async () => null);
      const service = createVcsService({
        workspaceVcs: { pendingMerge } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await service.handler({ caller: panelCaller() }, "pendingMerge", ["panels/source"]);

      expect(pendingMerge).toHaveBeenCalledWith("ctx:ctx-1", "panels/source");
    });
  });

  describe("edit authorization (working edits, not commits)", () => {
    it("allows do callers to record a working edit on their own context head", async () => {
      // `edit` records an UNCOMMITTED working edit via recordEdit — no commit,
      // no build, not in vcs.log. The result is { committed:false, uncommitted }.
      const recordEdit = vi.fn(async () => ({
        head: "ctx:ctx-1",
        stateHash: "state:next",
        committed: false as const,
        status: "uncommitted" as const,
        editSeq: 1,
        changedPaths: ["panels/source/agent.txt"],
      }));
      const service = createVcsService({
        workspaceVcs: { recordEdit } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-1", "do"),
      });
      const caller = createVerifiedCaller("do:agent", "do");

      const result = (await service.handler({ caller }, "edit", [
        {
          baseStateHash: "state:base",
          edits: [
            {
              kind: "write",
              path: "panels/source/agent.txt",
              content: { kind: "text", text: "ok\n" },
            },
          ],
        },
      ])) as { committed: boolean; status: string; stateHash: string };

      expect(recordEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          head: "ctx:ctx-1",
          baseStateHash: "state:base",
          actor: { id: "do:agent", kind: "do" },
          repoPath: "panels/source",
          edits: [
            {
              kind: "write",
              path: "agent.txt",
              content: { kind: "text", text: "ok\n" },
            },
          ],
        })
      );
      // No main-advance hook is threaded into a working edit.
      const [editArg] = recordEdit.mock.calls[0] as unknown as [Record<string, unknown>];
      expect(editArg).not.toHaveProperty("beforeAdvance");
      expect(result.committed).toBe(false);
      expect(result.status).toBe("uncommitted");
      expect(result.stateHash).toBe("state:next");
    });

    it("normalizes documented shorthand edit ops before routing to WorkspaceVcs", async () => {
      const recordEdit = vi.fn(async () => ({
        head: "ctx:ctx-1",
        stateHash: "state:next",
        committed: false as const,
        status: "uncommitted" as const,
        editSeq: 1,
        changedPaths: ["projects/tmp-vcs-commit-smoke/note.txt"],
      }));
      const service = createVcsService({
        workspaceVcs: { recordEdit } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-1", "do"),
      });
      const caller = createVerifiedCaller("do:agent", "do");

      await service.handler({ caller }, "edit", [
        {
          edits: [
            {
              path: "projects/tmp-vcs-commit-smoke/note.txt",
              content: "temporary VCS commit smoke edit\n",
            },
          ],
        },
      ]);

      expect(recordEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: "projects/tmp-vcs-commit-smoke",
          edits: [
            {
              kind: "write",
              path: "note.txt",
              content: { kind: "text", text: "temporary VCS commit smoke edit\n" },
            },
          ],
        })
      );
    });

    it("rejects a panel caller editing a foreign context head", async () => {
      const recordEdit = vi.fn();
      const service = createVcsService({
        workspaceVcs: { recordEdit } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "edit", [
          {
            head: "ctx:ctx-other",
            edits: [
              {
                kind: "write",
                path: "panels/source/a.txt",
                content: { kind: "text", text: "x\n" },
              },
            ],
          },
        ])
      ).rejects.toThrow("Callers may only write their own context head (ctx:ctx-1)");
      expect(recordEdit).not.toHaveBeenCalled();
    });

    it("rejects inferred edits that name a workspace repo root", async () => {
      const recordEdit = vi.fn();
      const service = createVcsService({
        workspaceVcs: { recordEdit } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-1", "do"),
      });
      const caller = createVerifiedCaller("do:agent", "do");

      await expect(
        service.handler({ caller }, "edit", [
          {
            edits: [
              {
                kind: "write",
                path: "projects/scratch",
                content: { kind: "text", text: "nope\n" },
              },
            ],
          },
        ])
      ).rejects.toThrow(/names a workspace repo root.*projects\/scratch\/README\.md/s);
      expect(recordEdit).not.toHaveBeenCalled();
    });

    it("rejects baseStateHash when one edit call routes to multiple repos", async () => {
      const recordEdit = vi.fn();
      const service = createVcsService({
        workspaceVcs: { recordEdit } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-1", "do"),
      });
      const caller = createVerifiedCaller("do:agent", "do");

      await expect(
        service.handler({ caller }, "edit", [
          {
            baseStateHash: "state:base",
            edits: [
              {
                kind: "write",
                path: "panels/source/a.txt",
                content: { kind: "text", text: "panel\n" },
              },
              {
                kind: "write",
                path: "workers/agent/index.ts",
                content: { kind: "text", text: "export default {};\n" },
              },
            ],
          },
        ])
      ).rejects.toThrow(/cannot enforce baseStateHash across multiple repos/);
      expect(recordEdit).not.toHaveBeenCalled();
    });

    it("suggests a repo-shaped path for dotted project filenames at repo root", async () => {
      const recordEdit = vi.fn();
      const service = createVcsService({
        workspaceVcs: { recordEdit } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-1", "do"),
      });
      const caller = createVerifiedCaller("do:agent", "do");

      await expect(
        service.handler({ caller }, "edit", [
          {
            edits: [
              {
                kind: "write",
                path: "projects/file-roundtrip-test.txt",
                content: { kind: "text", text: "nope\n" },
              },
            ],
          },
        ])
      ).rejects.toThrow(
        /repo-shaped path.*projects\/file-roundtrip-test\/file-roundtrip-test\.txt/s
      );
      expect(recordEdit).not.toHaveBeenCalled();
    });
  });

  describe("commit (fold working edits into a snapshot)", () => {
    it("commits the caller context's uncommitted edits per repo, requiring a message", async () => {
      const commit = vi.fn(async () => ({
        head: "ctx:ctx-1",
        stateHash: "state:snapshot",
        eventId: "evt-1",
        headHash: "h1",
        editCount: 2,
        status: "committed" as const,
        changedPaths: ["a.txt", "b.txt"],
      }));
      const contextStatus = vi.fn(async () => [
        {
          repoPath: "panels/source",
          forked: true,
          uncommitted: true,
          ahead: false,
          behind: false,
          deleted: false,
        },
      ]);
      const service = createVcsService({
        workspaceVcs: { commit, contextStatus } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = (await service.handler({ caller: panelCaller() }, "commit", [
        { message: "snapshot a+b" },
      ])) as Array<{ repoPath: string; status: string; editCount: number }>;

      expect(commit).toHaveBeenCalledWith(
        expect.objectContaining({
          head: "ctx:ctx-1",
          repoPath: "panels/source",
          message: "snapshot a+b",
          actor: { id: "panel-source", kind: "panel" },
        })
      );
      expect(result).toHaveLength(1);
      expect(result[0]!.status).toBe("committed");
      expect(result[0]!.editCount).toBe(2);
    });

    it("rejects a commit with no message", async () => {
      const commit = vi.fn();
      const service = createVcsService({
        workspaceVcs: { commit } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "commit", [{ message: "   " }])
      ).rejects.toThrow(/message/);
      expect(commit).not.toHaveBeenCalled();
    });

    it("rejects a commit on the main head", async () => {
      const commit = vi.fn();
      const service = createVcsService({
        workspaceVcs: { commit } as never,
      });
      const shell = createVerifiedCaller("shell:dev_cli", "shell");

      await expect(
        service.handler({ caller: shell }, "commit", [{ message: "x", head: "main" }])
      ).rejects.toThrow(/main advances only via push/);
      expect(commit).not.toHaveBeenCalled();
    });
  });

  describe("revert (lands as a working edit)", () => {
    it("reverts a change as a working edit on the caller's own head", async () => {
      // revert now returns a VcsEditResult — a tracked WORKING edit, not a commit.
      const revert = vi.fn(async () => ({
        head: "ctx:ctx-1",
        stateHash: "state:reverted",
        committed: false as const,
        status: "uncommitted" as const,
        editSeq: 3,
        changedPaths: ["panels/source/a.txt"],
      }));
      const service = createVcsService({
        workspaceVcs: { revert } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = (await service.handler({ caller: panelCaller() }, "revert", [
        { eventId: "evt-9", repoPath: "panels/source" },
      ])) as { committed: boolean; status: string };

      expect(revert).toHaveBeenCalledWith(
        expect.objectContaining({
          head: "ctx:ctx-1",
          target: { stateHash: undefined, eventId: "evt-9" },
          actor: { id: "panel-source", kind: "panel" },
          repoPath: "panels/source",
        })
      );
      expect(result.committed).toBe(false);
      expect(result.status).toBe("uncommitted");
    });

    it("rejects a revert onto a foreign context head", async () => {
      const revert = vi.fn();
      const service = createVcsService({
        workspaceVcs: { revert } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "revert", [
          { eventId: "evt-9", repoPath: "panels/source", head: "ctx:ctx-other" },
        ])
      ).rejects.toThrow("Callers may only write their own context head (ctx:ctx-1)");
      expect(revert).not.toHaveBeenCalled();
    });
  });

  describe("push authorization (per-repo, build-gated)", () => {
    function pushService(opts: { entityCache?: EntityCache } = {}) {
      const push = vi.fn(async () => ({
        status: "pushed" as const,
        repoPaths: ["panels/source"],
        reports: [],
      }));
      const service = createVcsService({
        workspaceVcs: { push } as never,
        ...(opts.entityCache ? { entityCache: opts.entityCache } : {}),
      });
      return { service, push };
    }

    it("pushes the panel caller's repo (build-gated, atomic)", async () => {
      const { service, push } = pushService({
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = (await service.handler({ caller: panelCaller() }, "push", [
        { repoPaths: ["panels/source"] },
      ])) as { status: string };

      expect(push).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPaths: ["panels/source"],
          sourceHead: "ctx:ctx-1",
        })
      );
      expect(result.status).toBe("pushed");
    });

    it("lets autonomous agents (do/worker) push their own context head", async () => {
      for (const kind of ["do", "worker"] as const) {
        const { service, push } = pushService({
          entityCache: entityCacheWithContext(`${kind}:agent`, "ctx-1"),
        });
        const caller = createVerifiedCaller(`${kind}:agent`, kind);

        const result = (await service.handler({ caller }, "push", [
          { repoPaths: ["panels/source"] },
        ])) as { status: string };

        expect(push).toHaveBeenCalledWith(
          expect.objectContaining({ repoPaths: ["panels/source"], sourceHead: "ctx:ctx-1" })
        );
        expect(result.status).toBe("pushed");
      }
    });

    it("rejects a userland push from a foreign source head", async () => {
      const { service, push } = pushService({
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "push", [
          { repoPaths: ["panels/source"], sourceHead: "ctx:other" },
        ])
      ).rejects.toThrow("Callers may only push their own context head");
      expect(push).not.toHaveBeenCalled();
    });

    it("passes the main-advance approval hook into push", async () => {
      const push = vi.fn(async () => ({
        status: "pushed" as const,
        repoPaths: ["panels/source"],
        reports: [],
      }));
      const approve = vi.fn(async () => {});
      const service = createVcsService({
        workspaceVcs: { push } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
        mainAdvanceGate: {
          approve,
          approveRepoDeletion: vi.fn(async () => {}),
          approveRepoRestore: vi.fn(async () => {}),
        },
      });

      await service.handler({ caller: panelCaller() }, "push", [{ repoPaths: ["panels/source"] }]);

      const [pushArg] = push.mock.calls[0] as unknown as [
        { beforeAdvance?: (event: never) => Promise<void> | void; sourceHead: string },
      ];
      expect(pushArg.sourceHead).toBe("ctx:ctx-1");
      expect(pushArg.beforeAdvance).toEqual(expect.any(Function));
      const event = {
        head: "main",
        stateHash: "state:candidate",
        sinceStateHash: "state:base",
        eventId: null,
        headHash: null,
        actor: { id: "panel-source", kind: "panel" },
        transitionKind: "merge",
        changedPaths: ["panels/source/index.tsx"],
        fileChanges: [],
        editOps: [],
      } as never;
      await pushArg.beforeAdvance?.(event);
      expect(approve).toHaveBeenCalledWith(
        expect.objectContaining({ caller: panelCaller(), event, operation: "push" })
      );
    });

    it("surfaces a structured divergence (not a conflicted status) to the caller", async () => {
      // Fast-forward-only push no longer has a "conflicted" status; a push that
      // can't fast-forward returns `diverged` with per-repo divergences for the
      // caller to reconcile via vcs.merge.
      const push = vi.fn(async () => ({
        status: "diverged" as const,
        divergences: [
          {
            repoPath: "panels/source",
            base: "state:base",
            mainTip: "state:main",
            upstreamCommits: [
              { eventId: "evt-up", message: "upstream", stateHash: "state:up", createdAt: null },
            ],
            mergeable: "clean" as const,
          },
        ],
      }));
      const service = createVcsService({
        workspaceVcs: { push } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = (await service.handler({ caller: panelCaller() }, "push", [
        { repoPaths: ["panels/source"] },
      ])) as { status: string; divergences: Array<{ repoPath: string; mergeable: string }> };

      expect(push).toHaveBeenCalledWith(
        expect.objectContaining({ repoPaths: ["panels/source"], sourceHead: "ctx:ctx-1" })
      );
      expect(result.status).toBe("diverged");
      expect(result.divergences[0]!.repoPath).toBe("panels/source");
      expect(result.divergences[0]!.mergeable).toBe("clean");
    });

    it("reports push status for the requested repos", async () => {
      const pushStatus = vi.fn(async () => ({
        repoPath: "panels/source",
        head: "ctx:ctx-1",
        headStateHash: "ctx-state",
        mainStateHash: "main-state",
        ahead: 2,
        uncommitted: 0,
        diverged: false,
        deleted: false,
        files: [
          { path: "a.mdx", kind: "changed" as const },
          { path: "b.mdx", kind: "added" as const },
        ],
      }));
      const service = createVcsService({
        workspaceVcs: { pushStatus } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = (await service.handler({ caller: panelCaller() }, "pushStatus", [
        ["panels/source"],
      ])) as Array<{ ahead: number }>;

      expect(pushStatus).toHaveBeenCalledWith("panels/source", "ctx:ctx-1");
      expect(result[0]!.ahead).toBe(2);
    });
  });
});
