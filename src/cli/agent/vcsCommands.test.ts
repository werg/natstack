import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearShellTokenCache } from "../rpcClient.js";

interface RpcRequest {
  method: string;
  args: unknown[];
}

function stubServer(handle: (body: RpcRequest) => unknown): { rpcBodies: RpcRequest[] } {
  const rpcBodies: RpcRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init?: RequestInit) => {
      if (String(url).endsWith("/_r/s/auth/refresh-shell")) {
        return new Response(
          JSON.stringify({ shellToken: "tok", callerId: "shell:dev_cli", deviceId: "dev_cli" })
        );
      }
      // Envelope-native /rpc: unwrap the request envelope into the legacy
      // {type,targetId,method,args} shape tests assert on, and reply with a
      // response envelope the CLI client unwraps.
      const envelope = JSON.parse(String(init?.body ?? "{}")) as {
        from?: string;
        target?: string;
        message?: {
          type?: string;
          requestId?: string;
          method?: string;
          args?: unknown[];
          event?: string;
          payload?: unknown;
        };
      };
      const msg = envelope.message ?? {};
      const target = envelope.target;
      const body = (msg.type === "event"
        ? { type: "emit", targetId: target, event: msg.event, payload: msg.payload }
        : target && target !== "main"
          ? { type: "call", targetId: target, method: msg.method, args: msg.args ?? [] }
          : { method: msg.method, args: msg.args ?? [] }) as unknown as RpcRequest;
      rpcBodies.push(body);
      const respond = (payload: { result?: unknown; error?: string }): Response =>
        new Response(
          JSON.stringify({
            from: envelope.target,
            target: envelope.from,
            delivery: { caller: { callerId: "main", callerKind: "server" } },
            provenance: [],
            message: { type: "response", requestId: msg.requestId, ...payload },
          })
        );
      try {
        return respond({ result: handle(body) });
      } catch (error) {
        return respond({ error: error instanceof Error ? error.message : String(error) });
      }
    })
  );
  return { rpcBodies };
}

function writeCredentials(tmpDir: string): void {
  const dir = path.join(tmpDir, ".config", "natstack");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "cli-credentials.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "device",
      url: "https://host.tailnet.ts.net",
      workspaceName: "dev",
      deviceId: "dev_cli",
      refreshToken: "refresh_cli",
    })
  );
}

function writeSession(tmpDir: string, name = "default"): void {
  const dir = path.join(tmpDir, ".config", "natstack", "agent-sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify({
      schemaVersion: 1,
      name,
      serverUrl: "https://host.tailnet.ts.net",
      entityId: `session:${name}`,
      contextId: "ctx_1",
      scopeKey: name,
      createdAt: 1,
    })
  );
}

function jsonOutput(): unknown {
  const lines = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
  return JSON.parse(lines[lines.length - 1]!);
}

function withTtyStdout<T>(fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  return fn().finally(() => {
    if (original) {
      Object.defineProperty(process.stdout, "isTTY", original);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
  });
}

describe("natstack vcs commands", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-vcs-cli-"));
    vi.stubEnv("HOME", tmpDir);
    clearShellTokenCache();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("status calls vcs.status with positional (repoPath, head) args", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    // Server returns a per-repo RepoStatus (added/removed/changed of the repo
    // subtree vs its own main); the CLI passes it through under --json.
    const statusResult = {
      stateHash: "state:abc123",
      dirty: true,
      uncommitted: 0,
      added: [],
      removed: [],
      changed: ["index.ts"],
      deleted: false,
    };
    const { rpcBodies } = stubServer(() => statusResult);

    const { main } = await import("../client.js");
    await expect(main(["vcs", "status", "--repo", "panels/notes", "--json"])).resolves.toBe(0);

    expect(rpcBodies).toEqual([{ method: "vcs.status", args: ["panels/notes", "ctx:ctx_1"] }]);
    expect(jsonOutput()).toEqual(statusResult);
  });

  it("diff renders name-status output from vcs.status (added/changed/removed)", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => ({
      stateHash: "state:abc123",
      dirty: true,
      uncommitted: 0,
      added: ["new.ts"],
      changed: ["index.ts"],
      removed: ["old.ts"],
      deleted: false,
    }));

    const { main } = await import("../client.js");
    await expect(main(["vcs", "diff", "--repo", "panels/notes", "--json"])).resolves.toBe(0);

    expect(rpcBodies).toEqual([{ method: "vcs.status", args: ["panels/notes", "ctx:ctx_1"] }]);
    expect(jsonOutput()).toBe("A\tnew.ts\nM\tindex.ts\nD\told.ts");
  });

  it("honors --session for non-default sessions", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir, "work");
    const { rpcBodies } = stubServer(() => ({
      stateHash: null,
      dirty: false,
      uncommitted: 0,
      added: [],
      removed: [],
      changed: [],
      deleted: false,
    }));

    const { main } = await import("../client.js");
    await expect(
      main(["vcs", "status", "--repo", "panels/notes", "--session", "work", "--json"])
    ).resolves.toBe(0);
    expect(rpcBodies[0]).toEqual({ method: "vcs.status", args: ["panels/notes", "ctx:ctx_1"] });
  });

  it("status renders uncommitted-only dirty state in human output", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubServer(() => ({
      stateHash: "state:working",
      dirty: true,
      uncommitted: 2,
      added: [],
      removed: [],
      changed: [],
      deleted: false,
    }));

    const { main } = await import("../client.js");
    await withTtyStdout(async () => {
      await expect(main(["vcs", "status", "--repo", "panels/notes"])).resolves.toBe(0);
    });

    const logs = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(logs).toContain("U\t2 uncommitted working edit(s)");
    expect(logs).not.toContain("clean (in sync with main)");
  });

  it("push --repo (single) calls vcs.push and returns 0 on pushed", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const result = {
      status: "pushed",
      repoPaths: ["panels/notes"],
      reports: [
        {
          repoPath: "panels/notes",
          kind: "panel",
          role: "pushed",
          required: true,
          status: "ok",
          builds: [{ target: "runtime", diagnostics: [] }],
        },
      ],
    };
    const { rpcBodies } = stubServer(() => result);

    const { main } = await import("../client.js");
    await expect(main(["vcs", "push", "--repo", "panels/notes", "--json"])).resolves.toBe(0);

    expect(rpcBodies).toEqual([
      {
        method: "vcs.push",
        args: [{ repoPaths: ["panels/notes"], sourceHead: "ctx:ctx_1" }],
      },
    ]);
    expect(jsonOutput()).toEqual(result);
  });

  it("repeated --repo forms an atomic group push (all repos in one call)", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => ({
      status: "pushed",
      repoPaths: ["packages/core", "panels/notes"],
      reports: [],
    }));

    const { main } = await import("../client.js");
    await expect(
      main(["vcs", "push", "--repo", "packages/core", "--repo", "panels/notes", "--json"])
    ).resolves.toBe(0);

    expect(rpcBodies[0]).toEqual({
      method: "vcs.push",
      args: [{ repoPaths: ["packages/core", "panels/notes"], sourceHead: "ctx:ctx_1" }],
    });
  });

  it("a build-failed push exits non-zero and still emits the full result under --json", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const result = {
      status: "build-failed",
      reports: [
        {
          repoPath: "panels/notes",
          kind: "panel",
          role: "pushed",
          required: true,
          status: "failed",
          builds: [
            {
              target: "runtime",
              diagnostics: [
                {
                  source: "tsc",
                  severity: "error",
                  file: "panels/notes/index.tsx",
                  line: 12,
                  column: 5,
                  message: "Type 'string' is not assignable to type 'number'.",
                },
              ],
            },
          ],
        },
      ],
    };
    stubServer(() => result);

    const { main } = await import("../client.js");
    await expect(main(["vcs", "push", "--repo", "panels/notes", "--json"])).resolves.toBe(1);
    expect(jsonOutput()).toEqual(result);
  });

  it("a diverged push exits non-zero", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubServer(() => ({
      status: "diverged",
      divergences: [
        {
          repoPath: "panels/notes",
          base: "state:base",
          mainTip: "state:main",
          upstreamCommits: [
            { eventId: "evt-1", message: "main moved", stateHash: "state:main", createdAt: null },
          ],
          mergeable: "conflict",
          conflictPaths: ["panels/notes/index.tsx"],
        },
      ],
    }));

    const { main } = await import("../client.js");
    await expect(main(["vcs", "push", "--repo", "panels/notes", "--json"])).resolves.toBe(1);
  });

  it("diverged push human output separates clean merge from conflict commit steps", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubServer(() => ({
      status: "diverged",
      divergences: [
        {
          repoPath: "panels/notes",
          base: "state:base",
          mainTip: "state:main",
          upstreamCommits: [
            { eventId: "evt-1", message: "main moved", stateHash: "state:main", createdAt: null },
          ],
          mergeable: "clean",
        },
      ],
    }));

    const { main } = await import("../client.js");
    await withTtyStdout(async () => {
      await expect(main(["vcs", "push", "--repo", "panels/notes"])).resolves.toBe(1);
    });

    const errors = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    expect(
      errors.some((line) =>
        line.includes(
          "Reconcile with `natstack vcs merge --repo REPOPATH`, then push. " +
            "If the merge conflicts, resolve markers and commit before pushing."
        )
      )
    ).toBe(true);
  });

  it("merge human output distinguishes clean and conflicting resolution steps", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => ({
      status: "merged",
      mergeable: "clean",
      upstreamCommits: [
        { eventId: "evt-1", message: "main moved", stateHash: "state:main", createdAt: null },
      ],
    }));

    const { main } = await import("../client.js");
    await withTtyStdout(async () => {
      await expect(main(["vcs", "merge", "--repo", "panels/notes"])).resolves.toBe(0);
    });

    expect(rpcBodies[0]).toEqual({ method: "vcs.merge", args: ["panels/notes", "ctx:ctx_1"] });
    const logs = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(
      logs.some((line) => line.includes("clean merge committed — push now fast-forwards."))
    ).toBe(true);
    expect(logs).not.toContain("clean merge — `vcs commit` then push (now fast-forwards).");
  });

  it("push-status renders uncommitted, diverged, and deleted blockers", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => [
      {
        repoPath: "panels/notes",
        head: "ctx:ctx_1",
        headStateHash: "state:head",
        mainStateHash: "state:main",
        ahead: 0,
        uncommitted: 2,
        diverged: false,
        deleted: false,
        files: [],
      },
      {
        repoPath: "packages/lib",
        head: "ctx:ctx_1",
        headStateHash: "state:lib",
        mainStateHash: "state:main-lib",
        ahead: 1,
        uncommitted: 0,
        diverged: true,
        deleted: true,
        files: [{ path: "index.ts", kind: "changed" }],
      },
    ]);

    const { main } = await import("../client.js");
    await withTtyStdout(async () => {
      await expect(
        main(["vcs", "push-status", "--repo", "panels/notes", "--repo", "packages/lib"])
      ).resolves.toBe(0);
    });

    expect(rpcBodies[0]).toEqual({
      method: "vcs.pushStatus",
      args: [["panels/notes", "packages/lib"]],
    });
    const logs = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(logs).toContain("panels/notes: 2 uncommitted working edit(s)");
    expect(logs).toContain("  commit or discard uncommitted edits before push");
    expect(logs).toContain("packages/lib: DELETED, diverged, 1 unpushed change(s)");
    expect(logs).toContain("  merge/rebase this context before push");
    expect(logs).toContain(
      "  repo was deleted from workspace main; restore it or drop/rebase this context"
    );
    expect(logs).not.toContain("panels/notes: clean (in sync with main)");
  });

  it("log calls vcs.log scoped to a single repo", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => [
      { stateHash: "state:1", parent: null, message: "init", timestamp: 1 },
    ]);

    const { main } = await import("../client.js");
    await expect(main(["vcs", "log", "--repo", "meta", "--json"])).resolves.toBe(0);
    // Positional (repoPath, limit?); no --limit ⇒ limit serializes to null.
    expect(rpcBodies[0]).toEqual({ method: "vcs.log", args: ["meta", null] });
  });

  it("fork-repo forks to a new path (history-preserving)", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => ({
      repoPath: "panels/mychat",
      head: "main",
      inherited: 3,
      stateHash: "state:fork",
    }));

    const { main } = await import("../client.js");
    await expect(
      main(["vcs", "fork-repo", "panels/chat", "panels/mychat", "--json"])
    ).resolves.toBe(0);
    expect(rpcBodies[0]).toEqual({
      method: "vcs.forkRepo",
      args: ["panels/chat", "panels/mychat"],
    });
  });

  it("delete-repo calls vcs.deleteRepo with the repo path", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => ({
      repoPath: "panels/old",
      archived: true,
      archiveHead: "archived:state:doomed",
      removedPaths: ["panels/old/index.tsx"],
      stateHash: "state:after",
    }));

    const { main } = await import("../client.js");
    await expect(main(["vcs", "delete-repo", "--repo", "panels/old", "--json"])).resolves.toBe(0);
    expect(rpcBodies[0]).toEqual({
      method: "vcs.deleteRepo",
      args: [{ repoPath: "panels/old" }],
    });
  });

  it("restore-repo calls vcs.restoreRepo with the repo path", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => ({
      repoPath: "panels/old",
      restored: true,
      fromArchiveHead: "archived:state:doomed",
      restoredPaths: ["panels/old/index.tsx"],
      stateHash: "state:after",
    }));

    const { main } = await import("../client.js");
    await expect(main(["vcs", "restore-repo", "--repo", "panels/old", "--json"])).resolves.toBe(0);
    expect(rpcBodies[0]).toEqual({
      method: "vcs.restoreRepo",
      args: [{ repoPath: "panels/old" }],
    });
  });

  it("context-status calls vcs.contextStatus and renders forked/ahead/behind", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const result = [
      { repoPath: "panels/chat", forked: true, ahead: true, behind: false },
      { repoPath: "packages/ui", forked: false, ahead: false, behind: true },
    ];
    const { rpcBodies } = stubServer(() => result);
    const { main } = await import("../client.js");
    await expect(main(["vcs", "context-status", "--json"])).resolves.toBe(0);
    expect(rpcBodies[0]).toEqual({ method: "vcs.contextStatus", args: [] });
    expect(jsonOutput()).toEqual(result);
  });

  it("rebase calls vcs.rebaseContext", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => ({
      repos: [{ repoPath: "panels/chat", status: "merged" }],
      baseView: "state:newbase",
    }));
    const { main } = await import("../client.js");
    await expect(main(["vcs", "rebase", "--json"])).resolves.toBe(0);
    expect(rpcBodies[0]).toEqual({ method: "vcs.rebaseContext", args: [] });
  });

  it("rebase conflict human output tells users to commit before re-push", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubServer(() => ({
      repos: [{ repoPath: "panels/chat", status: "conflicted" }],
      baseView: "state:newbase",
    }));
    const { main } = await import("../client.js");
    await withTtyStdout(async () => {
      await expect(main(["vcs", "rebase"])).resolves.toBe(0);
    });

    const logs = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(
      logs.some((line) =>
        line.includes(
          "1 repo(s) conflicted — resolve the markers, commit the resolution, then re-push."
        )
      )
    ).toBe(true);
  });

  it("maps failures to the exit-code conventions", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { main } = await import("../client.js");

    // Missing --repo is a usage error. `commit` and the old `git` group were dropped
    // (FS-snapshot commit was retired — fs writes route through GAD), so they are unknown
    // commands and also usage-error.
    await expect(main(["vcs", "status", "--json"])).resolves.toBe(2);
    await expect(main(["git", "status", "--repo", "panels/notes", "--json"])).resolves.toBe(2);

    // A server-side RPC failure maps to exit 1.
    stubServer(() => {
      throw new Error("workspace VCS unavailable");
    });
    await expect(main(["vcs", "status", "--repo", "panels/notes", "--json"])).resolves.toBe(1);
  });
});
