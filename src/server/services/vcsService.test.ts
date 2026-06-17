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
      // through `merge` (whose target is a head write) now that the FS-snapshot
      // `commit` RPC is gone.
      const mergeHeads = vi.fn();
      const service = createVcsService({
        workspaceVcs: { mergeHeads } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "merge", ["ctx:ctx-1", "ctx:ctx-2"])
      ).rejects.toThrow("Callers may only write their own context head (ctx:ctx-1)");
      expect(mergeHeads).not.toHaveBeenCalled();
    });

    it("allows shell callers to read explicit head status", async () => {
      const statusHead = vi.fn(async () => ({
        stateHash: "state:abc",
        dirty: true,
        added: ["panels/spectrolite/index.ts"],
        removed: [],
        changed: [],
      }));
      const service = createVcsService({
        workspaceVcs: { statusHead } as never,
      });
      const shell = createVerifiedCaller("shell:dev_cli", "shell");

      const result = await service.handler({ caller: shell }, "status", ["ctx:ctx-1"]);

      expect(statusHead).toHaveBeenCalledWith("ctx:ctx-1");
      expect(result).toMatchObject({ stateHash: "state:abc", dirty: true });
    });

    it("allows context callers to inspect explicit heads", async () => {
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

      const result = await service.handler({ caller: panelCaller() }, "status", ["ctx:ctx-2"]);

      expect(statusHead).toHaveBeenCalledWith("ctx:ctx-2");
      expect(result).toMatchObject({ stateHash: "state:foreign", dirty: false });
    });

    it("rejects path-looking status args with actionable VCS guidance", async () => {
      const statusHead = vi.fn();
      const service = createVcsService({
        workspaceVcs: { statusHead } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "status", ["panels/spectrolite"])
      ).rejects.toThrow(
        "vcs.status expects an optional materialized VCS head, not a filesystem path"
      );
      expect(statusHead).not.toHaveBeenCalled();
    });

    it("rejects unknown status heads with actionable VCS guidance", async () => {
      const statusHead = vi.fn();
      const service = createVcsService({
        workspaceVcs: { statusHead } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(service.handler({ caller: panelCaller() }, "status", ["root"])).rejects.toThrow(
        'vcs.status expects an optional materialized VCS head ("main" or "ctx:...")'
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
  });

  describe("merge authorization", () => {
    function mergeService(opts: { entityCache?: EntityCache } = {}) {
      const mergeHeads = vi.fn(async () => ({
        status: "merged" as const,
        stateHash: "state:merged",
        conflicts: [],
      }));
      const service = createVcsService({
        workspaceVcs: { mergeHeads } as never,
        ...(opts.entityCache ? { entityCache: opts.entityCache } : {}),
      });
      return { service, mergeHeads };
    }

    it("rejects a panel caller merging into the main head", async () => {
      const { service, mergeHeads } = mergeService({
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "merge", ["ctx:ctx-1", "main"])
      ).rejects.toThrow("Callers may only write their own context head (ctx:ctx-1)");
      expect(mergeHeads).not.toHaveBeenCalled();
    });

    it("rejects a contextless panel caller whose implicit target is main", async () => {
      const { service, mergeHeads } = mergeService({ entityCache: new EntityCache() });

      await expect(
        service.handler({ caller: panelCaller() }, "merge", ["ctx:ctx-1"])
      ).rejects.toThrow("vcs head writes require a context");
      expect(mergeHeads).not.toHaveBeenCalled();
    });

    it("rejects a panel caller merging into another context's head", async () => {
      const { service, mergeHeads } = mergeService({
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      await expect(
        service.handler({ caller: panelCaller() }, "merge", ["main", "ctx:ctx-other"])
      ).rejects.toThrow("Callers may only write their own context head (ctx:ctx-1)");
      expect(mergeHeads).not.toHaveBeenCalled();
    });

    it("allows a panel caller to merge into its own context head", async () => {
      const { service, mergeHeads } = mergeService({
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = (await service.handler({ caller: panelCaller() }, "merge", ["main"])) as {
        status: string;
      };

      expect(mergeHeads).toHaveBeenCalledWith(
        "ctx:ctx-1",
        "main",
        expect.objectContaining({ actor: { id: "panel-source", kind: "panel" } })
      );
      expect(result.status).toBe("merged");
    });

    it("allows shell and server callers to merge into main", async () => {
      for (const kind of ["shell", "server"] as const) {
        const { service, mergeHeads } = mergeService();
        const caller = createVerifiedCaller(`${kind}:test`, kind);

        const result = (await service.handler({ caller }, "merge", ["ctx:ctx-1", "main"])) as {
          status: string;
        };

        expect(mergeHeads).toHaveBeenCalledWith("main", "ctx:ctx-1", expect.anything());
        expect(result.status).toBe("merged");
      }
    });
  });

  describe("abortMerge authorization", () => {
    it("gates shell aborts of pending main merges", async () => {
      const abortMerge = vi.fn(async () => ({ aborted: true }));
      const approve = vi.fn(async () => {});
      const service = createVcsService({
        workspaceVcs: { abortMerge } as never,
        mainAdvanceGate: { approve },
      });
      const shell = createVerifiedCaller("shell:dev_cli", "shell");

      const result = (await service.handler({ caller: shell }, "abortMerge", ["main"])) as {
        aborted: boolean;
      };

      expect(result.aborted).toBe(true);
      expect(abortMerge).toHaveBeenCalledWith(
        "main",
        expect.objectContaining({
          actor: { id: "shell:dev_cli", kind: "shell" },
          beforeAdvance: expect.any(Function),
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
  });

  describe("applyEdits authorization", () => {
    it("allows do callers to write their own context head", async () => {
      const applyEdits = vi.fn(async () => ({
        head: "ctx:ctx-1",
        stateHash: "state:next",
        eventId: "e1",
        headHash: "h1",
        status: "clean" as const,
        conflicts: [],
        changedPaths: ["agent.txt"],
      }));
      const service = createVcsService({
        workspaceVcs: { applyEdits } as never,
        entityCache: entityCacheWithContext("do:agent", "ctx-1", "do"),
      });
      const caller = createVerifiedCaller("do:agent", "do");

      const result = (await service.handler({ caller }, "applyEdits", [
        {
          baseStateHash: "state:base",
          edits: [{ kind: "write", path: "agent.txt", content: { kind: "text", text: "ok\n" } }],
        },
      ])) as { stateHash: string };

      expect(applyEdits).toHaveBeenCalledWith(
        expect.objectContaining({
          head: "ctx:ctx-1",
          baseStateHash: "state:base",
          actor: { id: "do:agent", kind: "do" },
        })
      );
      expect(result.stateHash).toBe("state:next");
    });
  });

  describe("publish authorization (privileged ctx→main)", () => {
    function publishService(opts: { entityCache?: EntityCache } = {}) {
      const mergeHeads = vi.fn(async () => ({
        status: "merged" as const,
        stateHash: "state:published",
        conflicts: [],
      }));
      const service = createVcsService({
        workspaceVcs: { mergeHeads } as never,
        ...(opts.entityCache ? { entityCache: opts.entityCache } : {}),
      });
      return { service, mergeHeads };
    }

    it("publishes the panel caller's own context head into main", async () => {
      const { service, mergeHeads } = publishService({
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = (await service.handler({ caller: panelCaller() }, "publish", [])) as {
        status: string;
      };

      // Publish always targets main with the caller's own ctx head as source —
      // the one sanctioned escalation past the per-caller write gate.
      expect(mergeHeads).toHaveBeenCalledWith("main", "ctx:ctx-1", expect.anything());
      expect(result.status).toBe("merged");
    });

    it("denies autonomous agents (do/worker) from publishing", async () => {
      for (const kind of ["do", "worker"] as const) {
        const { service, mergeHeads } = publishService({
          entityCache: entityCacheWithContext(`${kind}:agent`, "ctx-1"),
        });
        const caller = createVerifiedCaller(`${kind}:agent`, kind);

        await expect(service.handler({ caller }, "publish", [])).rejects.toThrow(
          `vcs.publish is reserved for user-facing callers, not ${kind}`
        );
        expect(mergeHeads).not.toHaveBeenCalled();
      }
    });

    it("reports publish status from the caller's context head", async () => {
      const publishStatus = vi.fn(async () => ({
        head: "ctx:ctx-1",
        ctxStateHash: "state:ctx",
        mainStateHash: "state:main",
        ahead: 2,
        files: [
          { path: "a.mdx", kind: "changed" as const },
          { path: "b.mdx", kind: "added" as const },
        ],
      }));
      const service = createVcsService({
        workspaceVcs: { publishStatus } as never,
        entityCache: entityCacheWithContext("panel-source", "ctx-1"),
      });

      const result = (await service.handler({ caller: panelCaller() }, "publishStatus", [])) as {
        ahead: number;
      };

      expect(publishStatus).toHaveBeenCalledWith("ctx:ctx-1");
      expect(result.ahead).toBe(2);
    });
  });
});
