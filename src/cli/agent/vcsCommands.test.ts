import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearShellTokenCache } from "../rpcClient.js";

vi.mock("@natstack/shared/tailscaleDiscovery", () => ({
  discoverNatstackServers: vi.fn(async () => []),
}));

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
      const body = JSON.parse(String(init?.body ?? "{}")) as RpcRequest;
      rpcBodies.push(body);
      try {
        return new Response(JSON.stringify({ result: handle(body) }));
      } catch (error) {
        return new Response(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
        );
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

  it("status calls vcs.unitStatus with the repo and session context head", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    // The server now does the unit-scoping (unitStatusFromHead) and returns a
    // UnitVcsStatus; the CLI passes it through.
    const statusResult = {
      unitPath: "panels/notes",
      head: "ctx:ctx_1",
      stateHash: "state:abc123",
      dirty: true,
      files: [{ path: "panels/notes/index.ts", status: "modified" }],
    };
    const { rpcBodies } = stubServer(() => statusResult);

    const { main } = await import("../client.js");
    await expect(main(["vcs", "status", "--repo", "panels/notes", "--json"])).resolves.toBe(0);

    expect(rpcBodies).toEqual([{ method: "vcs.unitStatus", args: ["panels/notes", "ctx:ctx_1"] }]);
    expect(jsonOutput()).toEqual(statusResult);
  });

  it("diff renders name-status output from vcs.unitStatus", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => ({
      unitPath: "panels/notes",
      head: "ctx:ctx_1",
      stateHash: "state:abc123",
      dirty: true,
      files: [
        { path: "panels/notes/new.ts", status: "added" },
        { path: "panels/notes/index.ts", status: "modified" },
        { path: "panels/notes/old.ts", status: "deleted" },
      ],
    }));

    const { main } = await import("../client.js");
    await expect(main(["vcs", "diff", "--repo", "panels/notes", "--json"])).resolves.toBe(0);

    expect(rpcBodies).toEqual([{ method: "vcs.unitStatus", args: ["panels/notes", "ctx:ctx_1"] }]);
    expect(jsonOutput()).toBe(
      "A\tpanels/notes/new.ts\nM\tpanels/notes/index.ts\nD\tpanels/notes/old.ts"
    );
  });

  it("honors --session for non-default sessions", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir, "work");
    const { rpcBodies } = stubServer(() => ({
      unitPath: "panels/notes",
      head: "ctx:ctx_1",
      stateHash: null,
      dirty: false,
      files: [],
    }));

    const { main } = await import("../client.js");
    await expect(
      main(["vcs", "status", "--repo", "panels/notes", "--session", "work", "--json"])
    ).resolves.toBe(0);
    expect(rpcBodies[0]).toEqual({ method: "vcs.unitStatus", args: ["panels/notes", "ctx:ctx_1"] });
  });

  it("maps failures to the exit-code conventions", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { main } = await import("../client.js");

    await expect(main(["vcs", "status", "--json"])).resolves.toBe(2);
    await expect(main(["git", "status", "--repo", "panels/notes", "--json"])).resolves.toBe(2);

    stubServer(() => {
      throw new Error("workspace VCS unavailable");
    });
    await expect(main(["vcs", "status", "--repo", "panels/notes", "--json"])).resolves.toBe(1);
  });
});
