import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearShellTokenCache } from "../rpcClient.js";

interface RpcRequest {
  method: string;
  args: unknown[];
  type?: string;
  targetId?: string;
}

/**
 * Stub fetch for a paired server: answers refresh-shell and routes /rpc
 * bodies through `handle`.
 */
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

function sessionFile(tmpDir: string, name: string): string {
  return path.join(tmpDir, ".config", "natstack", "agent-sessions", `${name}.json`);
}

function jsonOutput(): unknown {
  const lines = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
  return JSON.parse(lines[lines.length - 1]!);
}

const SESSION_HANDLE = {
  id: "session:work",
  kind: "session",
  source: { repoPath: "agent-cli", effectiveVersion: "" },
  contextId: "ctx_1",
  targetId: "session:work",
};

describe("natstack agent commands", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-agent-"));
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

  it("attach creates a session entity and persists a 0600 session file", async () => {
    writeCredentials(tmpDir);
    const { rpcBodies } = stubServer((body) => {
      if (body.method === "runtime.listEntities") return [];
      if (body.method === "runtime.createEntity") return SESSION_HANDLE;
      throw new Error(`unexpected method ${body.method}`);
    });

    const { main } = await import("../client.js");
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);

    expect(rpcBodies).toEqual([
      {
        method: "runtime.createEntity",
        args: [{ kind: "session", source: "agent-cli", key: "work", title: "work" }],
      },
    ]);
    const filePath = sessionFile(tmpDir, "work");
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({
      schemaVersion: 1,
      name: "work",
      serverUrl: "https://host.tailnet.ts.net",
      entityId: "session:work",
      contextId: "ctx_1",
      scopeKey: "work",
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
    expect(jsonOutput()).toMatchObject({ entityId: "session:work" });
  });

  it("attach is idempotent when the entity is still live", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    {
      stubServer((body) => (body.method === "runtime.createEntity" ? SESSION_HANDLE : []));
      await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);
    }
    const before = fs.readFileSync(sessionFile(tmpDir, "work"), "utf8");

    const { rpcBodies } = stubServer((body) => {
      if (body.method === "runtime.listEntities") return [{ id: "session:work" }];
      throw new Error(`unexpected method ${body.method}`);
    });
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);
    expect(rpcBodies.map((body) => body.method)).toEqual(["runtime.listEntities"]);
    expect(fs.readFileSync(sessionFile(tmpDir, "work"), "utf8")).toBe(before);
  });

  it("attach recreates the entity when it is gone", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    stubServer((body) => (body.method === "runtime.createEntity" ? SESSION_HANDLE : []));
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);

    const recreated = { ...SESSION_HANDLE, id: "session:work2", contextId: "ctx_2" };
    const { rpcBodies } = stubServer((body) => {
      if (body.method === "runtime.listEntities") return [];
      if (body.method === "runtime.createEntity") return recreated;
      throw new Error(`unexpected method ${body.method}`);
    });
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);
    expect(rpcBodies.map((body) => body.method)).toEqual([
      "runtime.listEntities",
      "runtime.createEntity",
    ]);
    expect(jsonOutput()).toMatchObject({ entityId: "session:work2", contextId: "ctx_2" });
  });

  it("attach rejects pairing options when already paired (exit 2)", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    await expect(
      main(["agent", "attach", "work", "--url", "https://other.ts.net", "--code", "ABC", "--json"])
    ).resolves.toBe(2);
    await expect(main(["agent", "attach", "work", "--code", "ABC", "--json"])).resolves.toBe(2);
  });

  it("attach warns on stderr before overwriting a session from another server", async () => {
    writeCredentials(tmpDir);
    const dir = path.join(tmpDir, ".config", "natstack", "agent-sessions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      sessionFile(tmpDir, "work"),
      JSON.stringify({
        schemaVersion: 1,
        name: "work",
        serverUrl: "https://old.ts.net",
        entityId: "session:old",
        contextId: "ctx_old",
        scopeKey: "work",
        createdAt: 1,
      })
    );
    stubServer((body) => (body.method === "runtime.createEntity" ? SESSION_HANDLE : []));

    const { main } = await import("../client.js");
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);
    const warnings = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    expect(warnings.some((line) => line.includes("https://old.ts.net"))).toBe(true);
    const stored = JSON.parse(fs.readFileSync(sessionFile(tmpDir, "work"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(stored).toMatchObject({
      entityId: "session:work",
      serverUrl: "https://host.tailnet.ts.net",
    });
  });

  it("attach without credentials or pairing options is an auth error (exit 3)", async () => {
    const { main } = await import("../client.js");
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(3);
  });

  it("status reports stale sessions with exit 5", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    stubServer((body) => (body.method === "runtime.createEntity" ? SESSION_HANDLE : []));
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);

    stubServer((body) => {
      if (body.method === "runtime.listEntities") return [{ id: "session:work" }];
      throw new Error(`unexpected method ${body.method}`);
    });
    await expect(main(["agent", "status", "work", "--json"])).resolves.toBe(0);

    stubServer(() => []);
    await expect(main(["agent", "status", "work", "--json"])).resolves.toBe(5);
  });

  it("detach retires the entity and removes the session file", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    stubServer((body) => (body.method === "runtime.createEntity" ? SESSION_HANDLE : []));
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);

    const { rpcBodies } = stubServer((body) => {
      if (body.method === "runtime.retireEntity") return null;
      throw new Error(`unexpected method ${body.method}`);
    });
    await expect(main(["agent", "detach", "work", "--rm", "--json"])).resolves.toBe(0);
    expect(rpcBodies).toEqual([
      {
        method: "runtime.retireEntity",
        args: [{ id: "session:work", removeContext: true }],
      },
    ]);
    expect(fs.existsSync(sessionFile(tmpDir, "work"))).toBe(false);
  });

  it("detach deletes the session file when the entity is already gone", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    stubServer((body) => (body.method === "runtime.createEntity" ? SESSION_HANDLE : []));
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);

    stubServer(() => {
      throw new Error("entity session:work not found");
    });
    await expect(main(["agent", "detach", "work", "--json"])).resolves.toBe(0);
    expect(fs.existsSync(sessionFile(tmpDir, "work"))).toBe(false);
    expect(jsonOutput()).toMatchObject({ detached: "work", entityMissing: true });
  });

  it("detach keeps the session file when retire fails for other reasons", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    stubServer((body) => (body.method === "runtime.createEntity" ? SESSION_HANDLE : []));
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);

    stubServer(() => {
      throw new Error("durable object dispatch failed");
    });
    await expect(main(["agent", "detach", "work", "--json"])).resolves.toBe(1);
    expect(fs.existsSync(sessionFile(tmpDir, "work"))).toBe(true);
  });

  it("sessions reconciles local files against live entities", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    stubServer((body) => (body.method === "runtime.createEntity" ? SESSION_HANDLE : []));
    await expect(main(["agent", "attach", "work", "--json"])).resolves.toBe(0);
    stubServer((body) => {
      if (body.method === "runtime.createEntity") {
        return { ...SESSION_HANDLE, id: "session:gone", contextId: "ctx_gone" };
      }
      return [];
    });
    await expect(main(["agent", "attach", "gone", "--json"])).resolves.toBe(0);

    stubServer((body) => {
      if (body.method === "runtime.listEntities") return [{ id: "session:work" }];
      throw new Error(`unexpected method ${body.method}`);
    });
    await expect(main(["agent", "sessions", "--json"])).resolves.toBe(0);
    expect(jsonOutput()).toEqual([
      expect.objectContaining({ name: "gone", live: false }),
      expect.objectContaining({ name: "work", live: true }),
    ]);
  });

  it("sessions lists local files with unknown liveness when not paired", async () => {
    const dir = path.join(tmpDir, ".config", "natstack", "agent-sessions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      sessionFile(tmpDir, "work"),
      JSON.stringify({
        schemaVersion: 1,
        name: "work",
        serverUrl: "https://host.tailnet.ts.net",
        entityId: "session:work",
        contextId: "ctx_1",
        scopeKey: "work",
        createdAt: 1,
      })
    );

    const { main } = await import("../client.js");
    await expect(main(["agent", "sessions", "--json"])).resolves.toBe(0);
    expect(jsonOutput()).toEqual([expect.objectContaining({ name: "work", live: null })]);
  });

  it("call dispatches direct and relayed RPC and prints the result", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    const { rpcBodies } = stubServer((body) => {
      if (body.type === "call") return { relayed: body.targetId };
      return { direct: body.method };
    });

    await expect(main(["agent", "call", "workspace.getActive", "[]", "--json"])).resolves.toBe(0);
    expect(jsonOutput()).toEqual({ direct: "workspace.getActive" });

    await expect(
      main(["agent", "call", "stats.get", '[{"a":1}]', "--target", "worker:r:k", "--json"])
    ).resolves.toBe(0);
    expect(jsonOutput()).toEqual({ relayed: "worker:r:k" });
    expect(rpcBodies[1]).toEqual({
      type: "call",
      targetId: "worker:r:k",
      method: "stats.get",
      args: [{ a: 1 }],
    });
  });

  it("call allows plain method names when relaying with --target", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    const { rpcBodies } = stubServer(() => "pong");
    await expect(main(["agent", "call", "ping", "--target", "worker:r:k", "--json"])).resolves.toBe(
      0
    );
    expect(rpcBodies[0]).toEqual({
      type: "call",
      targetId: "worker:r:k",
      method: "ping",
      args: [],
    });
  });

  it("call rejects malformed args as usage errors (exit 2)", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    await expect(main(["agent", "call", "no-dot", "--json"])).resolves.toBe(2);
    await expect(main(["agent", "call", "a.b", "{not json", "--json"])).resolves.toBe(2);
    await expect(main(["agent", "call", "a.b", '{"not":"array"}', "--json"])).resolves.toBe(2);
  });

  it("call surfaces server RPC errors as exit 1", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    stubServer(() => {
      throw new Error("Unknown service method");
    });
    await expect(main(["agent", "call", "nope.nope", "--json"])).resolves.toBe(1);
  });

  it("services lists and describes via the docs service", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    const { rpcBodies } = stubServer((body) => {
      if (body.method === "docs.listServices") {
        return [{ name: "runtime", description: "Runtime entity creation" }];
      }
      if (body.method === "docs.describeService") {
        return { name: "runtime", policy: { allowed: ["shell"] }, methods: {} };
      }
      throw new Error(`unexpected method ${body.method}`);
    });

    await expect(main(["agent", "services", "--json"])).resolves.toBe(0);
    expect(jsonOutput()).toEqual([{ name: "runtime", description: "Runtime entity creation" }]);

    await expect(main(["agent", "services", "runtime", "--json"])).resolves.toBe(0);
    expect(rpcBodies[1]).toEqual({ method: "docs.describeService", args: ["runtime"] });
  });

  it("diag hits workspace.units.diagnostics and prints JSON", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    const diagnostics = {
      unit: { name: "foo", kind: "worker", status: "error", lastError: "boom" },
      logs: [],
      errors: [],
      builds: [],
    };
    const { rpcBodies } = stubServer((body) => {
      if (body.method === "workspace.units.diagnostics") return diagnostics;
      throw new Error(`unexpected method ${body.method}`);
    });

    await expect(main(["agent", "diag", "workers/foo", "--limit", "10", "--json"])).resolves.toBe(
      0
    );

    expect(rpcBodies).toEqual([
      { method: "workspace.units.diagnostics", args: ["workers/foo", { limit: 10 }] },
    ]);
    expect(jsonOutput()).toEqual(diagnostics);
  });

  it("skills and logs hit the workspace service with the right shapes", async () => {
    writeCredentials(tmpDir);
    const { main } = await import("../client.js");
    const { rpcBodies } = stubServer((body) => {
      if (body.method === "workspace.listSkills") {
        return [{ name: "alpha", description: "A skill", dirPath: "skills/alpha" }];
      }
      if (body.method === "workspace.readSkill") return "# alpha skill";
      if (body.method === "workspace.units.logs") return [{ level: "info", message: "hi" }];
      throw new Error(`unexpected method ${body.method}`);
    });

    await expect(main(["agent", "skills", "--json"])).resolves.toBe(0);
    await expect(main(["agent", "skills", "alpha", "--json"])).resolves.toBe(0);
    await expect(
      main(["agent", "logs", "workers/foo", "--level", "info", "--limit", "10", "--json"])
    ).resolves.toBe(0);

    expect(rpcBodies).toEqual([
      { method: "workspace.listSkills", args: [] },
      { method: "workspace.readSkill", args: ["alpha"] },
      { method: "workspace.units.logs", args: ["workers/foo", { level: "info", limit: 10 }] },
    ]);
  });
});
