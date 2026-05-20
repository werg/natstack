/**
 * FsService tests — context resolution, mktemp, and error-code preservation.
 *
 *  - `mktemp` creates (and returns) unique paths under `.tmp/` for atomic
 *    write patterns (write to tmp → rename into place) that pi-coding-agent's
 *    edit tool uses.
 *  - `readFile` on a missing file surfaces a `NodeJS.ErrnoException` with
 *    `err.code === "ENOENT"`. This guards the error-code preservation that
 *    pi-coding-agent's tools branch on; if the code is lost (either in
 *    FsService or in the RPC bridge), the tests fail.
 *
 * Context binding has moved upstream: WorkspaceDO is authoritative and the
 * Node-side EntityCache mirrors it. Tests insert active-entity rows directly
 * into the cache to register the panel's context.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { FsService } from "./fsService.js";
import { EntityCache } from "./runtime/entityCache.js";
import type { EntityKind, EntityRecord } from "./runtime/entitySpec.js";
import type { ContextFolderManager } from "./contextFolderManager.js";
import { createVerifiedCaller, type ServiceContext } from "./serviceDispatcher.js";

/**
 * Minimal ContextFolderManager stub.
 */
function makeStubFolderManager(root: string): ContextFolderManager {
  return {
    async ensureContextFolder(contextId: string): Promise<string> {
      const p = path.join(root, contextId);
      mkdirSync(p, { recursive: true });
      return p;
    },
  } as unknown as ContextFolderManager;
}

function makeWorkerCtx(callerId: string): ServiceContext {
  return { caller: createVerifiedCaller(callerId, "worker") };
}

function makeDoCtx(callerId: string): ServiceContext {
  return { caller: createVerifiedCaller(callerId, "do") };
}

function makeExtensionCtx(callerId: string): ServiceContext {
  return { caller: createVerifiedCaller(callerId, "extension") };
}

describe("FsService", () => {
  let tmpRoot: string;
  let service: FsService;
  let entityCache: EntityCache;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "natstack-fsservice-"));
    entityCache = new EntityCache();
    service = new FsService(makeStubFolderManager(tmpRoot), entityCache);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ─── Error code preservation (ENOENT) ─────────────────────────────────────
  describe("error code preservation", () => {
    it("readFile of a missing file throws an error with code=ENOENT", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-c");

      let caught: unknown;
      try {
        await service.handleCall(ctx, "readFile", ["/does-not-exist.txt"]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as NodeJS.ErrnoException).code).toBe("ENOENT");
    });
  });

  // ─── mktemp ───────────────────────────────────────────────────────────────
  describe("mktemp", () => {
    it("creates .tmp/ and returns a unique path on each call", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-d");

      const p1 = (await service.handleCall(ctx, "mktemp", [])) as string;
      const p2 = (await service.handleCall(ctx, "mktemp", [])) as string;
      expect(p1).toMatch(/^\/\.tmp\/tmp-[0-9a-f]{32}$/);
      expect(p2).toMatch(/^\/\.tmp\/tmp-[0-9a-f]{32}$/);
      expect(p1).not.toBe(p2);

      expect(existsSync(path.join(tmpRoot, "ctx-d", ".tmp"))).toBe(true);
    });

    it("honors a custom prefix", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-e");
      const p = (await service.handleCall(ctx, "mktemp", ["edit"])) as string;
      expect(p).toMatch(/^\/\.tmp\/edit-[0-9a-f]{32}$/);
    });

    it("sanitizes path separators AND leading dots in prefix to prevent `.tmp/` escape and hidden-file collisions", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-f");
      const p = (await service.handleCall(ctx, "mktemp", ["../evil"])) as string;
      expect(p).toMatch(/^\/\.tmp\/_evil-[0-9a-f]{32}$/);

      const p2 = (await service.handleCall(ctx, "mktemp", [".htaccess"])) as string;
      expect(p2).toMatch(/^\/\.tmp\/htaccess-[0-9a-f]{32}$/);

      const p3 = (await service.handleCall(ctx, "mktemp", ["..."])) as string;
      expect(p3).toMatch(/^\/\.tmp\/tmp-[0-9a-f]{32}$/);
    });

    it("returned path can be used to writeFile (atomic-write pattern)", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-g");
      const tmp = (await service.handleCall(ctx, "mktemp", ["write"])) as string;
      await service.handleCall(ctx, "writeFile", [tmp, "atomic"]);
      await service.handleCall(ctx, "rename", [tmp, "/target.txt"]);
      const content = await service.handleCall(ctx, "readFile", ["/target.txt", "utf8"]);
      expect(content).toBe("atomic");
    });
  });

  describe("context root resolution", () => {
    it("writeFile+readFile roundtrip through the registered context", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-b");
      await service.handleCall(ctx, "writeFile", ["/hello.txt", "world"]);
      expect(existsSync(path.join(tmpRoot, "ctx-b", "hello.txt"))).toBe(true);
      const content = await service.handleCall(ctx, "readFile", ["/hello.txt", "utf8"]);
      expect(content).toBe("world");
    });

    it("stat sees files that were placed on disk before the service call", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      mkdirSync(path.join(tmpRoot, "ctx-h"), { recursive: true });
      writeFileSync(path.join(tmpRoot, "ctx-h", "greeting.txt"), "hi");

      registerContext(ctx.caller.runtime.id, "do", "ctx-h");
      const stat = (await service.handleCall(ctx, "stat", ["/greeting.txt"])) as {
        isFile: boolean;
        size: number;
      };
      expect(stat.isFile).toBe(true);
      expect(stat.size).toBe(2);
    });

    it("uses an active DO entity context instead of treating the first path argument as a server context id", async () => {
      const ctx = makeDoCtx("do:workers/agent-worker:AiChatWorker:agent-1");
      registerContext(ctx.caller.runtime.id, "do", "ctx-agent");
      mkdirSync(path.join(tmpRoot, "ctx-agent", "skills", "onboarding"), { recursive: true });
      writeFileSync(path.join(tmpRoot, "ctx-agent", "skills", "onboarding", "SKILL.md"), "skill");

      await expect(
        service.handleCall(ctx, "access", ["/skills/onboarding/SKILL.md"])
      ).resolves.toBeUndefined();
      await expect(
        service.handleCall(ctx, "readFile", ["/skills/onboarding/SKILL.md", "utf8"])
      ).resolves.toBe("skill");
    });
  });

  describe("extension callers", () => {
    it("resolve fs paths as unrestricted host paths without a bound context", async () => {
      const ctx = makeExtensionCtx("@workspace-extensions/fs-test");
      const absolutePath = path.join(tmpRoot, "outside-context.txt");
      writeFileSync(absolutePath, "extension-visible");

      await expect(service.handleCall(ctx, "readFile", [absolutePath, "utf8"])).resolves.toBe(
        "extension-visible"
      );
      await service.handleCall(ctx, "writeFile", [absolutePath, "updated"]);
      await expect(service.handleCall(ctx, "readFile", [absolutePath, "utf8"])).resolves.toBe(
        "updated"
      );
    });

    it("binds extension fs calls to the chained caller context when present", async () => {
      const ctx = makeExtensionCtx("@workspace-extensions/file-tools");
      ctx.chainCaller = {
        callerId: "do:workers/agent-worker:AiChatWorker:agent-1",
        callerKind: "do",
        repoPath: "workers/agent-worker",
        effectiveVersion: "ev-1",
      };
      registerContext(ctx.chainCaller.callerId, "do", "ctx-agent");
      mkdirSync(path.join(tmpRoot, "ctx-agent", "skills", "system-testing"), { recursive: true });
      writeFileSync(
        path.join(tmpRoot, "ctx-agent", "skills", "system-testing", "SKILL.md"),
        "skill"
      );

      await expect(
        service.handleCall(ctx, "readFile", ["/skills/system-testing/SKILL.md", "utf8"])
      ).resolves.toBe("skill");
      await expect(
        service.handleCall(ctx, "readFile", [path.join(tmpRoot, "outside-context.txt"), "utf8"])
      ).rejects.toThrow(/ENOENT|no such file|Path traversal/i);
    });

    it("returns the physical context root from realpath for chained extension callers", async () => {
      const ctx = makeExtensionCtx("@workspace-extensions/file-tools");
      ctx.chainCaller = {
        callerId: "do:workers/agent-worker:AiChatWorker:agent-2",
        callerKind: "do",
        repoPath: "workers/agent-worker",
        effectiveVersion: "ev-1",
      };
      registerContext(ctx.chainCaller.callerId, "do", "ctx-realpath");

      await expect(service.handleCall(ctx, "realpath", ["/"])).resolves.toBe(
        path.join(tmpRoot, "ctx-realpath")
      );
    });
  });

  function registerContext(callerId: string, kind: EntityKind, contextId: string): void {
    const record: EntityRecord = {
      id: callerId,
      kind,
      source: { repoPath: "", effectiveVersion: "" },
      contextId,
      key: callerId,
      createdAt: Date.now(),
      status: "active",
      cleanupComplete: true,
    };
    entityCache._onActivate(record);
  }
});
