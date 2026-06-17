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
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsService,
  _setRipgrepPathForTests,
  type GrepResult,
  type FsVcsBridge,
  type FsVcsContent,
  type FsVcsEditOp,
} from "./fsService.js";
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
    getContextFolderState(contextId: string) {
      const p = path.join(root, contextId);
      return existsSync(p)
        ? { status: "ready" as const, path: p }
        : { status: "missing" as const, path: p };
    },
    getContextRoot(contextId: string): string | null {
      const p = path.join(root, contextId);
      return existsSync(p) ? p : null;
    },
  } as unknown as ContextFolderManager;
}

function makeWorkerCtx(callerId: string): ServiceContext {
  return { caller: createVerifiedCaller(callerId, "worker") };
}

function makeAppCtx(callerId: string): ServiceContext {
  return { caller: createVerifiedCaller(callerId, "app") };
}

function makeDoCtx(callerId: string): ServiceContext {
  return { caller: createVerifiedCaller(callerId, "do") };
}

function makeExtensionCtx(callerId: string): ServiceContext {
  return { caller: createVerifiedCaller(callerId, "extension") };
}

function makeShellCtx(callerId: string): ServiceContext {
  return { caller: createVerifiedCaller(callerId, "shell") };
}

function makeHarnessCtx(callerId: string): ServiceContext {
  return { caller: createVerifiedCaller(callerId, "harness") };
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

    it("uses an active app entity context for app callers", async () => {
      const ctx = makeAppCtx("@workspace-apps/shell");
      registerContext(ctx.caller.runtime.id, "app", "ctx-app");

      await service.handleCall(ctx, "writeFile", ["/app.txt", "from-app"]);

      expect(existsSync(path.join(tmpRoot, "ctx-app", "app.txt"))).toBe(true);
      await expect(service.handleCall(ctx, "readFile", ["/app.txt", "utf8"])).resolves.toBe(
        "from-app"
      );
    });
  });

  describe("symlink sandboxing", () => {
    it("rejects reads through an invalid .git/objects symlink escape", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-git-invalid");
      const contextRoot = path.join(tmpRoot, "ctx-git-invalid");
      const repoGit = path.join(contextRoot, "repo", ".git");
      const externalObjects = path.join(tmpRoot, "external-objects");
      mkdirSync(path.join(externalObjects, "ab"), { recursive: true });
      writeFileSync(
        path.join(externalObjects, "ab", "cdef1234567890abcdef1234567890abcdef12"),
        "outside"
      );
      mkdirSync(repoGit, { recursive: true });
      symlinkSync(path.relative(repoGit, externalObjects), path.join(repoGit, "objects"), "dir");

      await expect(
        service.handleCall(ctx, "readFile", [
          "/repo/.git/objects/ab/cdef1234567890abcdef1234567890abcdef12",
          "utf8",
        ])
      ).rejects.toThrow(/Symlink escapes sandbox/i);
    });
  });

  describe("extension callers", () => {
    it("fails loud for an extension fs call without an on-behalf-of context or host-fs capability", async () => {
      const ctx = makeExtensionCtx("@workspace-extensions/fs-test");
      const absolutePath = path.join(tmpRoot, "outside-context.txt");
      writeFileSync(absolutePath, "extension-visible");

      // Phase 3: no silent unrestricted-host-fs fallback — the call throws
      // instead of reading `/`.
      await expect(service.handleCall(ctx, "readFile", [absolutePath, "utf8"])).rejects.toThrow(
        /host-fs-access capability/i
      );
    });

    it("grants unrestricted host fs only to an extension holding the explicit host-fs capability", async () => {
      const capableService = new FsService(makeStubFolderManager(tmpRoot), entityCache, {
        hostFsCapableExtensions: ["@workspace-extensions/fs-test"],
      });
      const ctx = makeExtensionCtx("@workspace-extensions/fs-test");
      const absolutePath = path.join(tmpRoot, "outside-context.txt");
      writeFileSync(absolutePath, "extension-visible");

      await expect(
        capableService.handleCall(ctx, "readFile", [absolutePath, "utf8"])
      ).resolves.toBe("extension-visible");
      await capableService.handleCall(ctx, "writeFile", [absolutePath, "updated"]);
      await expect(
        capableService.handleCall(ctx, "readFile", [absolutePath, "utf8"])
      ).resolves.toBe("updated");
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
      mkdirSync(path.join(tmpRoot, "ctx-realpath"), { recursive: true });

      await expect(service.handleCall(ctx, "realpath", ["/"])).resolves.toBe(
        path.join(tmpRoot, "ctx-realpath")
      );
    });

    it("fails fast for chained extension fs calls before context materialization", async () => {
      const ctx = makeExtensionCtx("@workspace-extensions/file-tools");
      ctx.chainCaller = {
        callerId: "do:workers/agent-worker:AiChatWorker:agent-3",
        callerKind: "do",
        repoPath: "workers/agent-worker",
        effectiveVersion: "ev-1",
      };
      registerContext(ctx.chainCaller.callerId, "do", "ctx-not-ready");

      await expect(service.handleCall(ctx, "realpath", ["/"])).rejects.toMatchObject({
        code: "ENOTREADY",
      });
    });
  });

  describe("explicit-contextId callers (shell/harness)", () => {
    it("shell callers resolve an existing context passed as the first argument", async () => {
      mkdirSync(path.join(tmpRoot, "ctx-shell"), { recursive: true });
      const ctx = makeShellCtx("shell-1");
      await service.handleCall(ctx, "writeFile", ["ctx-shell", "/note.txt", "from-shell"]);
      expect(existsSync(path.join(tmpRoot, "ctx-shell", "note.txt"))).toBe(true);
      await expect(
        service.handleCall(ctx, "readFile", ["ctx-shell", "/note.txt", "utf8"])
      ).resolves.toBe("from-shell");
    });

    it("harness callers resolve an existing context passed as the first argument", async () => {
      mkdirSync(path.join(tmpRoot, "ctx-harness"), { recursive: true });
      writeFileSync(path.join(tmpRoot, "ctx-harness", "probe.txt"), "hi");
      const ctx = makeHarnessCtx("harness-1");
      await expect(
        service.handleCall(ctx, "readFile", ["ctx-harness", "/probe.txt", "utf8"])
      ).resolves.toBe("hi");
    });

    it("accepts a contextId known only through an active entity", async () => {
      registerContext("do:src:class:entity-only", "do", "ctx-entity-only");
      const ctx = makeShellCtx("shell-1");
      await service.handleCall(ctx, "writeFile", ["ctx-entity-only", "/x.txt", "ok"]);
      expect(existsSync(path.join(tmpRoot, "ctx-entity-only", "x.txt"))).toBe(true);
    });

    it("rejects unknown contextIds for shell and harness callers", async () => {
      await expect(
        service.handleCall(makeShellCtx("shell-1"), "readFile", ["ctx-nope", "/a.txt", "utf8"])
      ).rejects.toThrow(/Unknown contextId: ctx-nope/);
      await expect(
        service.handleCall(makeHarnessCtx("harness-1"), "stat", ["ctx-nope", "/a.txt"])
      ).rejects.toThrow(/Unknown contextId: ctx-nope/);
    });

    it("rejects calls without a contextId first argument", async () => {
      await expect(
        service.handleCall(makeShellCtx("shell-1"), "readFile", [])
      ).rejects.toThrow(/must provide contextId/);
    });

    it("server callers may address fresh contexts (created on the fly)", async () => {
      const ctx: ServiceContext = { caller: createVerifiedCaller("server-main", "server") };
      await service.handleCall(ctx, "writeFile", ["ctx-fresh", "/s.txt", "srv"]);
      expect(existsSync(path.join(tmpRoot, "ctx-fresh", "s.txt"))).toBe(true);
    });
  });

  describe("removed sandbox-escape primitives", () => {
    it("symlink and chown are no longer dispatchable", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-removed");
      await expect(service.handleCall(ctx, "symlink", ["/a", "/b"])).rejects.toThrow(
        /Unknown fs method: symlink/
      );
      await expect(service.handleCall(ctx, "chown", ["/a", 0, 0])).rejects.toThrow(
        /Unknown fs method: chown/
      );
    });
  });

  describe("readdir recursive", () => {
    function setupTree(contextId: string): void {
      const root = path.join(tmpRoot, contextId);
      mkdirSync(path.join(root, "sub", "deeper"), { recursive: true });
      writeFileSync(path.join(root, "top.txt"), "t");
      writeFileSync(path.join(root, "sub", "mid.txt"), "m");
      writeFileSync(path.join(root, "sub", "deeper", "leaf.txt"), "l");
    }

    it("lists nested entries with relative paths", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-rdr");
      setupTree("ctx-rdr");

      const names = (await service.handleCall(ctx, "readdir", [
        "/",
        { recursive: true },
      ])) as string[];
      expect(names.sort()).toEqual(["sub", "sub/deeper", "sub/deeper/leaf.txt", "sub/mid.txt", "top.txt"]);
    });

    it("supports recursive withFileTypes with nested relative names", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-rdr-ft");
      setupTree("ctx-rdr-ft");

      const entries = (await service.handleCall(ctx, "readdir", [
        "/",
        { recursive: true, withFileTypes: true },
      ])) as Array<{ name: string; _isFile: boolean; _isDirectory: boolean }>;
      const leaf = entries.find((e) => e.name === "sub/deeper/leaf.txt");
      expect(leaf).toBeDefined();
      expect(leaf!._isFile).toBe(true);
      const dir = entries.find((e) => e.name === "sub/deeper");
      expect(dir).toBeDefined();
      expect(dir!._isDirectory).toBe(true);
    });

    it("non-recursive readdir is unchanged", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-rdr-flat");
      setupTree("ctx-rdr-flat");
      const names = (await service.handleCall(ctx, "readdir", ["/"])) as string[];
      expect(names.sort()).toEqual(["sub", "top.txt"]);
    });
  });

  describe("grep", () => {
    function setupSearchTree(contextId: string): string {
      const root = path.join(tmpRoot, contextId);
      mkdirSync(path.join(root, "src"), { recursive: true });
      mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
      mkdirSync(path.join(root, ".git"), { recursive: true });
      writeFileSync(
        path.join(root, "src", "alpha.ts"),
        "line one\nneedle here\nline three\nline four\nNEEDLE again\n"
      );
      writeFileSync(path.join(root, "src", "beta.md"), "no match\nanother needle\n");
      writeFileSync(path.join(root, "node_modules", "dep", "skip.ts"), "needle in dep\n");
      writeFileSync(path.join(root, ".git", "config"), "needle in git\n");
      writeFileSync(path.join(root, "binary.bin"), Buffer.from([0x6e, 0x65, 0x00, 0x6c, 0x65]));
      return root;
    }

    afterEach(() => {
      _setRipgrepPathForTests(undefined);
    });

    for (const [mode, rgOverride] of [
      ["js fallback", null],
      ["auto-detected backend", undefined],
    ] as const) {
      describe(mode, () => {
        function withBackend(): void {
          _setRipgrepPathForTests(rgOverride);
        }

        it("finds matches with sandbox-relative paths and skips .git/node_modules/binary files", async () => {
          const ctx = makeWorkerCtx("do:src:class:key");
          registerContext(ctx.caller.runtime.id, "do", "ctx-grep-a");
          setupSearchTree("ctx-grep-a");
          withBackend();

          const result = (await service.handleCall(ctx, "grep", ["needle"])) as GrepResult;
          expect(result.truncated).toBe(false);
          expect(result.matchCount).toBe(2);
          const files = result.matches.map((m) => m.file).sort();
          expect(files).toEqual(["/src/alpha.ts", "/src/beta.md"]);
          const alpha = result.matches.find((m) => m.file === "/src/alpha.ts")!;
          expect(alpha.lineNumber).toBe(2);
          expect(alpha.line).toBe("needle here");
          expect(alpha.before).toEqual([]);
          expect(alpha.after).toEqual([]);
        });

        it("supports caseInsensitive and contextLines", async () => {
          const ctx = makeWorkerCtx("do:src:class:key");
          registerContext(ctx.caller.runtime.id, "do", "ctx-grep-b");
          setupSearchTree("ctx-grep-b");
          withBackend();

          const result = (await service.handleCall(ctx, "grep", [
            "needle",
            { path: "/src", glob: "*.ts", caseInsensitive: true, contextLines: 1 },
          ])) as GrepResult;
          expect(result.matchCount).toBe(2);
          const first = result.matches.find((m) => m.lineNumber === 2)!;
          expect(first.before).toEqual(["line one"]);
          expect(first.after).toEqual(["line three"]);
          const second = result.matches.find((m) => m.lineNumber === 5)!;
          expect(second.line).toBe("NEEDLE again");
          expect(second.before).toEqual(["line four"]);
        });

        it("truncates at maxMatches", async () => {
          const ctx = makeWorkerCtx("do:src:class:key");
          registerContext(ctx.caller.runtime.id, "do", "ctx-grep-c");
          const root = path.join(tmpRoot, "ctx-grep-c");
          mkdirSync(root, { recursive: true });
          writeFileSync(root + "/many.txt", Array(20).fill("needle").join("\n"));
          withBackend();

          const result = (await service.handleCall(ctx, "grep", [
            "needle",
            { maxMatches: 5 },
          ])) as GrepResult;
          expect(result.matchCount).toBe(5);
          expect(result.truncated).toBe(true);
        });

        it("filters candidate files by glob", async () => {
          const ctx = makeWorkerCtx("do:src:class:key");
          registerContext(ctx.caller.runtime.id, "do", "ctx-grep-d");
          setupSearchTree("ctx-grep-d");
          withBackend();

          const result = (await service.handleCall(ctx, "grep", [
            "needle",
            { glob: "*.md" },
          ])) as GrepResult;
          expect(result.matches.map((m) => m.file)).toEqual(["/src/beta.md"]);
        });
      });
    }

    it("rejects paths escaping the sandbox", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-grep-esc");
      mkdirSync(path.join(tmpRoot, "ctx-grep-esc"), { recursive: true });
      await expect(
        service.handleCall(ctx, "grep", ["needle", { path: "../other-context" }])
      ).rejects.toThrow(/Path traversal/);
    });

    it("works for shell callers with an explicit contextId", async () => {
      mkdirSync(path.join(tmpRoot, "ctx-grep-shell"), { recursive: true });
      writeFileSync(path.join(tmpRoot, "ctx-grep-shell", "f.txt"), "needle\n");
      const result = (await service.handleCall(makeShellCtx("shell-1"), "grep", [
        "ctx-grep-shell",
        "needle",
      ])) as GrepResult;
      expect(result.matchCount).toBe(1);
      expect(result.matches[0]!.file).toBe("/f.txt");
    });
  });

  describe("glob", () => {
    it("returns matching files sorted by mtime desc, skipping node_modules", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-glob");
      const root = path.join(tmpRoot, "ctx-glob");
      mkdirSync(path.join(root, "src", "deep"), { recursive: true });
      mkdirSync(path.join(root, "node_modules"), { recursive: true });
      writeFileSync(path.join(root, "src", "old.ts"), "");
      writeFileSync(path.join(root, "src", "deep", "newer.ts"), "");
      writeFileSync(path.join(root, "src", "skip.md"), "");
      writeFileSync(path.join(root, "node_modules", "dep.ts"), "");
      const now = Date.now() / 1000;
      utimesSync(path.join(root, "src", "old.ts"), now - 100, now - 100);
      utimesSync(path.join(root, "src", "deep", "newer.ts"), now, now);

      const result = (await service.handleCall(ctx, "glob", ["**/*.ts"])) as string[];
      expect(result).toEqual(["/src/deep/newer.ts", "/src/old.ts"]);
    });

    it("scopes the search to options.path", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-glob-scope");
      const root = path.join(tmpRoot, "ctx-glob-scope");
      mkdirSync(path.join(root, "a"), { recursive: true });
      mkdirSync(path.join(root, "b"), { recursive: true });
      writeFileSync(path.join(root, "a", "in.txt"), "");
      writeFileSync(path.join(root, "b", "out.txt"), "");

      const result = (await service.handleCall(ctx, "glob", [
        "*.txt",
        { path: "/a" },
      ])) as string[];
      expect(result).toEqual(["/a/in.txt"]);
    });

    it("matches slash-free patterns against basenames anywhere in the tree", async () => {
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-glob-base");
      const root = path.join(tmpRoot, "ctx-glob-base");
      mkdirSync(path.join(root, "nested"), { recursive: true });
      writeFileSync(path.join(root, "nested", "match.spec.ts"), "");

      const result = (await service.handleCall(ctx, "glob", ["*.spec.ts"])) as string[];
      expect(result).toEqual(["/nested/match.spec.ts"]);
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

  // ─── GAD reroute (tracked context mutations commit through GAD) ────────────
  describe("GAD reroute", () => {
    function makeMockBridge() {
      const files = new Map<string, FsVcsContent>(); // `${contextId}/${rel}` → content
      const applyCalls: Array<{ contextId: string; edits: FsVcsEditOp[] }> = [];
      const isScratch = (rel: string) =>
        rel === ".tmp" ||
        rel.startsWith(".tmp/") ||
        rel === ".testkit" ||
        rel.startsWith(".testkit/");
      const bridge: FsVcsBridge = {
        isTracked: async (rel) => rel.length > 0 && !isScratch(rel),
        applyEdits: async (contextId, edits) => {
          applyCalls.push({ contextId, edits });
          for (const e of edits) {
            const key = `${contextId}/${e.path}`;
            if (e.kind === "write") files.set(key, e.content);
            else if (e.kind === "delete") files.delete(key);
          }
        },
        readFile: async (contextId, rel) => files.get(`${contextId}/${rel}`) ?? null,
        listFiles: async (contextId) =>
          [...files.keys()]
            .filter((k) => k.startsWith(`${contextId}/`))
            .map((k) => k.slice(contextId.length + 1)),
      };
      return { bridge, applyCalls, files };
    }

    it("routes a tracked-path writeFile through GAD, not raw disk", async () => {
      const { bridge, applyCalls, files } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, { vcsBridge: bridge });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-gad");

      await svc.handleCall(ctx, "writeFile", ["/panels/app/index.ts", "export const x = 1;\n"]);

      expect(applyCalls).toHaveLength(1);
      expect(applyCalls[0]!.edits).toEqual([
        {
          kind: "write",
          path: "panels/app/index.ts",
          content: { kind: "text", text: "export const x = 1;\n" },
        },
      ]);
      expect(files.get("ctx-gad/panels/app/index.ts")).toEqual({
        kind: "text",
        text: "export const x = 1;\n",
      });
      // The worktree projection was NOT written directly.
      expect(existsSync(path.join(tmpRoot, "ctx-gad", "panels", "app", "index.ts"))).toBe(false);
    });

    it("leaves scratch-path writes (.tmp) on direct disk, never through GAD", async () => {
      const { bridge, applyCalls } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, { vcsBridge: bridge });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-scratch");

      const tmp = (await svc.handleCall(ctx, "mktemp", ["edit"])) as string;
      await svc.handleCall(ctx, "writeFile", [tmp, "scratch"]);

      expect(applyCalls).toHaveLength(0);
      expect(existsSync(path.join(tmpRoot, "ctx-scratch", tmp.replace(/^\//, "")))).toBe(true);
    });

    it("routes a tracked-path delete through GAD", async () => {
      const { bridge, applyCalls, files } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, { vcsBridge: bridge });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-del");

      await svc.handleCall(ctx, "writeFile", ["/packages/lib/a.ts", "a"]);
      await svc.handleCall(ctx, "unlink", ["/packages/lib/a.ts"]);

      expect(files.has("ctx-del/packages/lib/a.ts")).toBe(false);
      expect(applyCalls.at(-1)!.edits).toEqual([{ kind: "delete", path: "packages/lib/a.ts" }]);
    });

    it("commits an atomic-write rename (.tmp → tracked) through GAD and drops the temp", async () => {
      const { bridge, files } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, { vcsBridge: bridge });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-atomic");

      const tmp = (await svc.handleCall(ctx, "mktemp", ["w"])) as string;
      await svc.handleCall(ctx, "writeFile", [tmp, "final\n"]);
      await svc.handleCall(ctx, "rename", [tmp, "/skills/x/SKILL.md"]);

      expect(files.get("ctx-atomic/skills/x/SKILL.md")).toEqual({
        kind: "bytes",
        base64: Buffer.from("final\n").toString("base64"),
      });
      expect(existsSync(path.join(tmpRoot, "ctx-atomic", tmp.replace(/^\//, "")))).toBe(false);
    });

    it("rejects opening a tracked path for writing (must go through GAD)", async () => {
      const { bridge } = makeMockBridge();
      const svc = new FsService(makeStubFolderManager(tmpRoot), entityCache, { vcsBridge: bridge });
      const ctx = makeWorkerCtx("do:src:class:key");
      registerContext(ctx.caller.runtime.id, "do", "ctx-open");

      await expect(svc.handleCall(ctx, "open", ["/panels/app/index.ts", "w"])).rejects.toThrow(
        /must commit through GAD/
      );
    });
  });
});
