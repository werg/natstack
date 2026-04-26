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
  //
  // Audit finding #39 / #7: workers and panels can only call bindContext to
  // confirm their *host-registered* contextId. Self-registration (worker
  // making up a contextId out of thin air) and cross-pivot (worker re-binding
  // to a different context) are both rejected.
  describe("bindContext", () => {
    it("is an idempotent no-op when worker re-binds to its own host-registered contextId", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      // Host pre-registers the caller (mirrors workerdManager.createRegularInstance).
      service.registerCallerContext(ctx.callerId, "ctx-a");

      // bindContext to the same contextId is allowed (idempotent confirmation).
      await service.handleCall(ctx, "bindContext", ["ctx-a"]);
      const entries = await service.handleCall(ctx, "readdir", ["/"]);
      expect(entries).toEqual([]);
    });

    it("rejects worker self-registration when no host context is set", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      // No registerCallerContext call — worker tries to make up a contextId.
      await expect(
        service.handleCall(ctx, "bindContext", ["ctx-a"]),
      ).rejects.toThrow(/no host-registered context/);
    });

    it("rejects cross-context pivot (worker tries to re-bind to another context)", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      service.registerCallerContext(ctx.callerId, "ctx-a");
      await expect(
        service.handleCall(ctx, "bindContext", ["ctx-other"]),
      ).rejects.toThrow(/cross-context pivot blocked/);
    });

    it("rejects empty / non-string contextId", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      service.registerCallerContext(ctx.callerId, "ctx-a");
      await expect(
        service.handleCall(ctx, "bindContext", [""]),
      ).rejects.toThrow(/non-empty contextId/);
      await expect(
        service.handleCall(ctx, "bindContext", [42]),
      ).rejects.toThrow(/non-empty contextId/);
    });

    it("after host-registration, writeFile+readFile roundtrip through the bound context", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      service.registerCallerContext(ctx.callerId, "ctx-b");
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
      service.registerCallerContext(ctx.callerId, "ctx-c");
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
      service.registerCallerContext(ctx.callerId, "ctx-d");
      await service.handleCall(ctx, "bindContext", ["ctx-d"]);

      const p1 = (await service.handleCall(ctx, "mktemp", [])) as string;
      const p2 = (await service.handleCall(ctx, "mktemp", [])) as string;
      // Suffix widened to 32 hex chars (16 bytes) per audit finding #34.
      expect(p1).toMatch(/^\/\.tmp\/tmp-[0-9a-f]{32}$/);
      expect(p2).toMatch(/^\/\.tmp\/tmp-[0-9a-f]{32}$/);
      expect(p1).not.toBe(p2);

      // .tmp/ dir itself must exist so a subsequent writeFile can land there.
      expect(existsSync(path.join(tmpRoot, "ctx-d", ".tmp"))).toBe(true);
    });

    it("honors a custom prefix", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      service.registerCallerContext(ctx.callerId, "ctx-e");
      await service.handleCall(ctx, "bindContext", ["ctx-e"]);
      const p = (await service.handleCall(ctx, "mktemp", ["edit"])) as string;
      expect(p).toMatch(/^\/\.tmp\/edit-[0-9a-f]{32}$/);
    });

    it("sanitizes path separators AND leading dots in prefix to prevent `.tmp/` escape and hidden-file collisions", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      service.registerCallerContext(ctx.callerId, "ctx-f");
      await service.handleCall(ctx, "bindContext", ["ctx-f"]);
      const p = (await service.handleCall(ctx, "mktemp", ["../evil"])) as string;
      // `..` get stripped (leading dots), `/` replaced with `_` — result stays
      // under `.tmp/` and cannot create a leading-dot hidden file (audit #20).
      expect(p).toMatch(/^\/\.tmp\/_evil-[0-9a-f]{32}$/);

      // Pure leading-dot prefix (`.htaccess`) collapses to `tmp` fallback —
      // never a leading-dot file.
      const p2 = (await service.handleCall(ctx, "mktemp", [".htaccess"])) as string;
      expect(p2).toMatch(/^\/\.tmp\/htaccess-[0-9a-f]{32}$/);

      const p3 = (await service.handleCall(ctx, "mktemp", ["..."])) as string;
      expect(p3).toMatch(/^\/\.tmp\/tmp-[0-9a-f]{32}$/);
    });

    it("returned path can be used to writeFile (atomic-write pattern)", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      service.registerCallerContext(ctx.callerId, "ctx-g");
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

      service.registerCallerContext(ctx.callerId, "ctx-h");
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
