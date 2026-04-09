/**
 * FsService tests — bindContext, mktemp, and error-code preservation.
 *
 * These tests cover W1d's additions to the shim layer that makes FsService
 * a drop-in `node:fs/promises` equivalent for workerd DOs:
 *
 *  - `bindContext` registers a caller→context mapping so DOs (whose callerIds
 *    aren't auto-registered the way worker subprocesses are) can resolve
 *    sandboxed paths in subsequent fs calls.
 *  - `mktemp` creates (and returns) unique paths under `.tmp/` for atomic
 *    write patterns (write to tmp → rename into place) that pi-coding-agent's
 *    edit tool uses.
 *  - `readFile` on a missing file surfaces a `NodeJS.ErrnoException` with
 *    `err.code === "ENOENT"`. This guards the error-code preservation that
 *    pi-coding-agent's tools branch on; if the code is lost (either in
 *    FsService or in the RPC bridge), the tests fail.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { FsService } from "./fsService.js";
import type { ContextFolderManager } from "./contextFolderManager.js";
import type { ServiceContext } from "./serviceDispatcher.js";

/**
 * Minimal ContextFolderManager stub.
 *
 * FsService only calls `ensureContextFolder(contextId)` on the manager, so we
 * don't need the full implementation (with its git-copy machinery and
 * workspace tree plumbing). This stub maps contextIds onto pre-created
 * subdirectories of a tmpdir so each test can assert path-level behavior.
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
  return { callerId, callerKind: "worker" };
}

describe("FsService", () => {
  let tmpRoot: string;
  let service: FsService;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "natstack-fsservice-"));
    service = new FsService(makeStubFolderManager(tmpRoot));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ─── bindContext ──────────────────────────────────────────────────────────
  describe("bindContext", () => {
    it("registers callerId → contextId so subsequent fs ops resolve", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");

      // Without bindContext, resolveContextRoot should throw.
      await expect(
        service.handleCall(ctx, "readdir", ["/"]),
      ).rejects.toThrow(/No context registered/);

      // Bind the caller to a context and verify the same readdir now
      // resolves against the stub folder (empty, so result is []).
      await service.handleCall(ctx, "bindContext", ["ctx-a"]);
      const entries = await service.handleCall(ctx, "readdir", ["/"]);
      expect(entries).toEqual([]);
    });

    it("rejects empty / non-string contextId", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      await expect(
        service.handleCall(ctx, "bindContext", [""]),
      ).rejects.toThrow(/non-empty contextId/);
      await expect(
        service.handleCall(ctx, "bindContext", [42]),
      ).rejects.toThrow(/non-empty contextId/);
    });

    it("after bindContext, writeFile+readFile roundtrip through the bound context", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      await service.handleCall(ctx, "bindContext", ["ctx-b"]);
      await service.handleCall(ctx, "writeFile", ["/hello.txt", "world"]);
      // File should live inside the stub folder for contextId "ctx-b".
      expect(existsSync(path.join(tmpRoot, "ctx-b", "hello.txt"))).toBe(true);
      const content = await service.handleCall(ctx, "readFile", ["/hello.txt", "utf8"]);
      expect(content).toBe("world");
    });
  });

  // ─── Error code preservation (ENOENT) ─────────────────────────────────────
  describe("error code preservation", () => {
    it("readFile of a missing file throws an error with code=ENOENT", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      await service.handleCall(ctx, "bindContext", ["ctx-c"]);

      // Catch rather than `.rejects.toThrow` so we can inspect err.code.
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
      await service.handleCall(ctx, "bindContext", ["ctx-d"]);

      const p1 = (await service.handleCall(ctx, "mktemp", [])) as string;
      const p2 = (await service.handleCall(ctx, "mktemp", [])) as string;
      expect(p1).toMatch(/^\/\.tmp\/tmp-[0-9a-f]{16}$/);
      expect(p2).toMatch(/^\/\.tmp\/tmp-[0-9a-f]{16}$/);
      expect(p1).not.toBe(p2);

      // .tmp/ dir itself must exist so a subsequent writeFile can land there.
      expect(existsSync(path.join(tmpRoot, "ctx-d", ".tmp"))).toBe(true);
    });

    it("honors a custom prefix", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      await service.handleCall(ctx, "bindContext", ["ctx-e"]);
      const p = (await service.handleCall(ctx, "mktemp", ["edit"])) as string;
      expect(p).toMatch(/^\/\.tmp\/edit-[0-9a-f]{16}$/);
    });

    it("sanitizes path separators in prefix to prevent `.tmp/` escape", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      await service.handleCall(ctx, "bindContext", ["ctx-f"]);
      const p = (await service.handleCall(ctx, "mktemp", ["../evil"])) as string;
      // `..` and `/` get replaced with `_` so the result stays under `.tmp/`.
      expect(p).toMatch(/^\/\.tmp\/\.\._evil-[0-9a-f]{16}$/);
    });

    it("returned path can be used to writeFile (atomic-write pattern)", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      await service.handleCall(ctx, "bindContext", ["ctx-g"]);
      const tmp = (await service.handleCall(ctx, "mktemp", ["write"])) as string;
      await service.handleCall(ctx, "writeFile", [tmp, "atomic"]);
      await service.handleCall(ctx, "rename", [tmp, "/target.txt"]);
      const content = await service.handleCall(ctx, "readFile", ["/target.txt", "utf8"]);
      expect(content).toBe("atomic");
    });
  });

  // ─── Sanity: pre-existing files are visible via bound context ─────────────
  describe("context root resolution", () => {
    it("stat sees files that were placed on disk before the service call", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      // Pre-populate the folder the stub will hand back.
      mkdirSync(path.join(tmpRoot, "ctx-h"), { recursive: true });
      writeFileSync(path.join(tmpRoot, "ctx-h", "greeting.txt"), "hi");

      await service.handleCall(ctx, "bindContext", ["ctx-h"]);
      const stat = (await service.handleCall(ctx, "stat", ["/greeting.txt"])) as {
        isFile: boolean;
        size: number;
      };
      expect(stat.isFile).toBe(true);
      expect(stat.size).toBe(2);
    });
  });
});
