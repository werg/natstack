import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@natstack/extension";
import { activate } from "./index.js";

async function makeApi(approval: "allow" | "deny" = "allow") {
  const root = await mkdtemp(join(tmpdir(), "natstack-shell-test-"));
  const request = vi.fn(async () => ({ kind: "choice" as const, choice: approval }));
  const ctx = {
    workspace: { getInfo: async () => ({ id: "ws", name: "ws", path: root, contextsPath: join(root, ".contexts") }) },
    invocation: { current: () => ({ caller: { callerId: "panel:test", callerKind: "panel" } }) },
    approvals: { request, revoke: vi.fn(), list: vi.fn() },
    health: { healthy: vi.fn(), degraded: vi.fn(), unhealthy: vi.fn(), report: vi.fn() },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ExtensionContext;
  return { api: await activate(ctx), request, root };
}

describe("@workspace-extensions/shell", () => {
  it("rejects cwd escapes before requesting approval", async () => {
    const { api, request } = await makeApi();
    await expect(api.exec({ command: "pwd", cwd: "../../" })).rejects.toMatchObject({ code: "EACCES" });
    expect(request).not.toHaveBeenCalled();
  });

  it("maps denied exec approval to EACCES before spawning", async () => {
    const { api, request } = await makeApi("deny");
    await expect(api.exec({ command: "node", args: ["-e", "console.log('nope')"] })).rejects.toMatchObject({ code: "EACCES" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("runs approved argv-style exec without invoking a shell", async () => {
    const { api } = await makeApi("allow");
    const result = await api.exec({
      command: "node",
      args: ["-e", "console.log(process.argv[1])", "hello;not-a-shell"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello;not-a-shell");
  });
});
