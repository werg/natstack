import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createConnectDeepLink } from "@natstack/shared/connect";
import { clearShellTokenCache } from "./rpcClient.js";

const mocks = vi.hoisted(() => ({
  discoverNatstackServers: vi.fn(
    async (): Promise<Array<{ url: string; hostname: string; discoveryVersion: number }>> => []
  ),
}));

vi.mock("@natstack/shared/tailscaleDiscovery", () => ({
  discoverNatstackServers: mocks.discoverNatstackServers,
}));

describe("natstack CLI", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-cli-"));
    vi.stubEnv("HOME", tmpDir);
    clearShellTokenCache();
    mocks.discoverNatstackServers.mockReset();
    mocks.discoverNatstackServers.mockResolvedValue([]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("pairs from a natstack link and writes a 0600 device credential file", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ deviceId: "dev_cli", refreshToken: "refresh_cli" }));
      })
    );

    const { main } = await import("./client.js");
    const code = await main([
      "remote",
      "pair",
      createConnectDeepLink("https://host.tailnet.ts.net", "A".repeat(24)),
    ]);

    expect(code).toBe(0);
    expect(bodies).toEqual([
      {
        code: "A".repeat(24),
        label: expect.stringContaining("@"),
        platform: "desktop",
      },
    ]);
    const filePath = path.join(tmpDir, ".config", "natstack", "cli-credentials.json");
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
      schemaVersion: 1,
      kind: "device",
      url: "https://host.tailnet.ts.net",
      hubUrl: "https://host.tailnet.ts.net",
      deviceId: "dev_cli",
      refreshToken: "refresh_cli",
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it("tightens an existing CLI credential file to 0600 when pairing", async () => {
    if (process.platform === "win32") return;
    const credentialDir = path.join(tmpDir, ".config", "natstack");
    const filePath = path.join(credentialDir, "cli-credentials.json");
    fs.mkdirSync(credentialDir, { recursive: true });
    fs.writeFileSync(filePath, "{}", { mode: 0o644 });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ deviceId: "dev_cli", refreshToken: "refresh_cli" }))
      )
    );

    const { main } = await import("./client.js");
    const code = await main([
      "remote",
      "pair",
      "--url",
      "https://host.tailnet.ts.net",
      "--code",
      "A".repeat(24),
    ]);

    expect(code).toBe(0);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("logs out by removing the CLI credential file", async () => {
    const credentialDir = path.join(tmpDir, ".config", "natstack");
    const filePath = path.join(credentialDir, "cli-credentials.json");
    fs.mkdirSync(credentialDir, { recursive: true });
    fs.writeFileSync(filePath, "{}");

    const { main } = await import("./client.js");
    await expect(main(["remote", "logout"])).resolves.toBe(0);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("prints discovered NatStack server URLs", async () => {
    mocks.discoverNatstackServers.mockResolvedValue([
      {
        url: "https://host.tailnet.ts.net",
        hostname: "host.tailnet.ts.net",
        discoveryVersion: 1,
      },
    ]);

    const log = vi.mocked(console.log);
    const { main } = await import("./client.js");
    await expect(main(["remote", "discover", "--json"])).resolves.toBe(0);

    const output = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(JSON.parse(output)).toEqual([
      {
        url: "https://host.tailnet.ts.net",
        hostname: "host.tailnet.ts.net",
        discoveryVersion: 1,
      },
    ]);
  });

  it("shows the unified CLI groups in top-level help", async () => {
    const { main } = await import("./client.js");
    await expect(main(["--help"])).resolves.toBe(0);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("natstack remote pair"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("natstack mobile install"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("natstack mobile smoke"));
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining(["natstack", "remote", "start"].join(" "))
    );
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("natstack-client"));
  });

  it("keeps remote pairing available under the unified command", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ deviceId: "dev_cli", refreshToken: "refresh_cli" }))
      )
    );

    const { main } = await import("./client.js");
    await expect(
      main([
        "remote",
        "pair",
        "--url",
        "https://host.tailnet.ts.net",
        "--code",
        "A".repeat(24),
        "--json",
      ])
    ).resolves.toBe(0);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(JSON.parse(output)).toMatchObject({ url: "https://host.tailnet.ts.net" });
  });

  it("reports a failed or expired pairing code as an auth error (exit 3)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ error: "pairing code expired" }), { status: 401 })
      )
    );

    const { main } = await import("./client.js");
    await expect(
      main(["remote", "pair", "--url", "https://host.tailnet.ts.net", "--code", "A".repeat(24)])
    ).resolves.toBe(3);
  });

  it("rejects old top-level remote commands", async () => {
    const { main } = await import("./client.js");
    await expect(main(["pair", "--url", "https://host.tailnet.ts.net"])).resolves.toBe(2);
    expect(console.error).toHaveBeenCalledWith("Unknown command: pair");
  });

  it("checks the stored device refresh credential for status", async () => {
    const credentialDir = path.join(tmpDir, ".config", "natstack");
    fs.mkdirSync(credentialDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialDir, "cli-credentials.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "device",
        url: "https://host.tailnet.ts.net/_workspace/dev",
        hubUrl: "https://host.tailnet.ts.net",
        workspaceName: "dev",
        deviceId: "dev_cli",
        refreshToken: "refresh_cli",
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/_r/s/auth/refresh-shell")) {
          return new Response(
            JSON.stringify({
              shellToken: "shell_token",
              callerId: "shell:dev_cli",
              deviceId: "dev_cli",
              workspaceId: "ws_1",
              serverId: "srv_1",
            })
          );
        }
        return new Response(JSON.stringify({ ok: true, product: "natstack", discoveryVersion: 1 }));
      })
    );

    const { main } = await import("./client.js");
    await expect(main(["remote", "status", "--json"])).resolves.toBe(0);
    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(JSON.parse(output)).toMatchObject({ workspaceId: "ws_1", serverId: "srv_1" });
  });

  it("requires workspace selection before checking remote status", async () => {
    const credentialDir = path.join(tmpDir, ".config", "natstack");
    fs.mkdirSync(credentialDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialDir, "cli-credentials.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "device",
        url: "https://host.tailnet.ts.net",
        hubUrl: "https://host.tailnet.ts.net",
        deviceId: "dev_cli",
        refreshToken: "refresh_cli",
      })
    );

    const { main } = await import("./client.js");
    await expect(main(["remote", "status", "--json"])).resolves.toBe(3);
    const output = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("natstack remote select <workspace>");
  });

  it("reports missing credentials for status as an auth error (exit 3)", async () => {
    const { main } = await import("./client.js");
    await expect(main(["remote", "status", "--json"])).resolves.toBe(3);
  });

  it("rejects unknown flags as usage errors (exit 2)", async () => {
    const { main } = await import("./client.js");
    await expect(main(["remote", "status", "--bogus"])).resolves.toBe(2);
    await expect(main(["agent", "call", "--bogus"])).resolves.toBe(2);
  });

  it("creates a pairing invite using the stored device credential", async () => {
    const credentialDir = path.join(tmpDir, ".config", "natstack");
    fs.mkdirSync(credentialDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialDir, "cli-credentials.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "device",
        url: "https://host.tailnet.ts.net",
        hubUrl: "https://host.tailnet.ts.net",
        deviceId: "dev_cli",
        refreshToken: "refresh_cli",
      })
    );
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        bodies.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
        if (String(url).endsWith("/_r/s/auth/refresh-shell")) {
          return new Response(JSON.stringify({ shellToken: "shell_token" }));
        }
        return new Response(
          JSON.stringify({
            result: {
              code: "A".repeat(24),
              deepLink: createConnectDeepLink("https://host.tailnet.ts.net", "A".repeat(24)),
              connectUrl: "https://host.tailnet.ts.net",
              serverUrl: "https://host.tailnet.ts.net",
              expiresAt: 123,
              expiresInMs: 60_000,
              serverId: "srv",
              serverBootId: "boot",
              workspaceId: "ws",
            },
          })
        );
      })
    );

    const { main } = await import("./client.js");
    await expect(main(["remote", "invite", "--ttl-ms", "60000", "--json"])).resolves.toBe(0);

    expect(bodies).toEqual([
      {
        url: "https://host.tailnet.ts.net/_r/s/auth/refresh-shell",
        body: { deviceId: "dev_cli", refreshToken: "refresh_cli" },
      },
      {
        url: "https://host.tailnet.ts.net/rpc",
        body: { method: "auth.createPairingInvite", args: [{ ttlMs: 60_000 }] },
      },
    ]);
    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(JSON.parse(output)).toMatchObject({
      code: "A".repeat(24),
      deepLink: createConnectDeepLink("https://host.tailnet.ts.net", "A".repeat(24)),
    });
  });

  it("requires a hub credential before creating pairing invites", async () => {
    const credentialDir = path.join(tmpDir, ".config", "natstack");
    fs.mkdirSync(credentialDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialDir, "cli-credentials.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "device",
        url: "https://host.tailnet.ts.net",
        deviceId: "dev_cli",
        refreshToken: "refresh_cli",
      })
    );

    const { main } = await import("./client.js");
    await expect(main(["remote", "invite", "--json"])).resolves.toBe(3);
    const output = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("missing a hub URL");
  });

  it("pairs inline before starting the terminal app through the launch gate", async () => {
    const rpcMethods: string[] = [];
    const bodies: Array<{ url: string; body: unknown }> = [];
    const approval = {
      approvalId: "approval-1",
      kind: "unit-batch",
      callerId: "system:apps",
      callerKind: "system",
      repoPath: "apps/remote-cli",
      effectiveVersion: "ev-1",
      trigger: "startup",
      title: "Approve terminal app",
      description: "Approve before launch",
      units: [
        {
          unitKind: "app",
          unitName: "@workspace-apps/remote-cli",
          displayName: "Remote CLI",
          target: "terminal",
          source: { kind: "workspace-repo", repo: "apps/remote-cli", ref: "main" },
          ev: "terminal-ev",
          capabilities: ["connection-management"],
        },
      ],
      requestedAt: 1,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        bodies.push({ url: String(url), body });
        if (String(url).endsWith("/_r/s/auth/complete-pairing")) {
          return new Response(
            JSON.stringify({ deviceId: "dev_terminal", refreshToken: "refresh_terminal" })
          );
        }
        if (String(url).endsWith("/_r/s/workspaces/select")) {
          return new Response(
            JSON.stringify({
              workspaceName: "dev",
              serverUrl: "https://host.tailnet.ts.net/_workspace/dev",
              running: true,
            })
          );
        }
        if (String(url).endsWith("/_r/s/auth/refresh-shell")) {
          return new Response(JSON.stringify({ shellToken: "shell_token" }));
        }
        rpcMethods.push(body.method);
        if (body.method === "workspace.hostTargets.beginLaunch") {
          return new Response(
            JSON.stringify({
              result: {
                sessionId: "launch_terminal",
                target: "terminal",
                status: "approval-required",
                currentPhase: "review-trust",
                message: "Terminal launch needs approval.",
                timeline: [],
                approvals: [approval],
                approvalViews: [],
                approvalsResolved: 0,
                startedAt: 1,
                updatedAt: 1,
                settled: false,
              },
            })
          );
        }
        if (body.method === "workspace.hostTargets.resolveLaunchSessionApproval") {
          return new Response(
            JSON.stringify({
              result: {
                sessionId: "launch_terminal",
                target: "terminal",
                status: "ready",
                currentPhase: "connected",
                message: "Terminal app is ready.",
                timeline: [],
                approvals: [],
                approvalViews: [],
                approvalsResolved: 1,
                startedAt: 1,
                updatedAt: 2,
                settled: true,
                launch: {
                  status: "ready",
                  target: "terminal",
                  appId: "@workspace-apps/remote-cli",
                  buildKey: "build-terminal",
                },
              },
            })
          );
        }
        return new Response(JSON.stringify({ error: `unexpected ${body.method}` }), {
          status: 500,
        });
      })
    );

    const { main } = await import("./client.js");
    const code = await main([
      "terminal",
      "start",
      "--pair",
      createConnectDeepLink("https://host.tailnet.ts.net", "A".repeat(24)),
      "--workspace",
      "dev",
      "--yes",
      "--json",
    ]);

    expect(code).toBe(0);
    expect(bodies[0]).toMatchObject({
      url: "https://host.tailnet.ts.net/_r/s/auth/complete-pairing",
      body: {
        code: "A".repeat(24),
        label: expect.stringContaining("Terminal on "),
        platform: "terminal",
      },
    });
    expect(rpcMethods).toEqual([
      "workspace.hostTargets.beginLaunch",
      "workspace.hostTargets.resolveLaunchSessionApproval",
    ]);
    const filePath = path.join(tmpDir, ".config", "natstack", "cli-credentials.json");
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      kind: "device",
      url: "https://host.tailnet.ts.net/_workspace/dev",
      hubUrl: "https://host.tailnet.ts.net",
      workspaceName: "dev",
      deviceId: "dev_terminal",
      refreshToken: "refresh_terminal",
    });
    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(JSON.parse(output)).toMatchObject({ status: "ready", approvalsResolved: 1 });
  });

  it("points unpaired terminal users at the inline pairing command", async () => {
    const { main } = await import("./client.js");
    await expect(main(["terminal", "start"])).resolves.toBe(3);
    const output = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("natstack terminal start --pair");
  });

  function writeCredentials(content?: string): void {
    const credentialDir = path.join(tmpDir, ".config", "natstack");
    fs.mkdirSync(credentialDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialDir, "cli-credentials.json"),
      content ??
        JSON.stringify({
          schemaVersion: 1,
          kind: "device",
          url: "https://host.tailnet.ts.net/_workspace/dev",
          hubUrl: "https://host.tailnet.ts.net",
          workspaceName: "dev",
          deviceId: "dev_cli",
          refreshToken: "refresh_cli",
        })
    );
  }

  it("prints per-command help for --help and -h (exit 0)", async () => {
    const { main } = await import("./client.js");
    await expect(main(["remote", "invite", "--help"])).resolves.toBe(0);
    await expect(main(["fs", "ls", "-h"])).resolves.toBe(0);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("natstack remote invite [--ttl-ms <milliseconds>]");
    expect(output).toContain("--ttl-ms <value>");
    expect(output).toContain("--json");
    expect(output).toContain("Emit JSON");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("accepts --flag=value syntax for value flags", async () => {
    writeCredentials();
    const bodies: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        bodies.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
        if (String(url).endsWith("/_r/s/auth/refresh-shell")) {
          return new Response(JSON.stringify({ shellToken: "shell_token" }));
        }
        return new Response(
          JSON.stringify({
            result: { code: "A".repeat(24), connectUrl: "https://host.tailnet.ts.net" },
          })
        );
      })
    );

    const { main } = await import("./client.js");
    await expect(main(["remote", "invite", "--ttl-ms=60000", "--json"])).resolves.toBe(0);
    expect(bodies[1]?.body).toEqual({
      method: "auth.createPairingInvite",
      args: [{ ttlMs: 60_000 }],
    });
  });

  it("accepts --flag=true|false for boolean flags and rejects other values", async () => {
    writeCredentials();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/_r/s/auth/refresh-shell")) {
          return new Response(JSON.stringify({ shellToken: "shell_token", workspaceId: "ws_1" }));
        }
        return new Response(JSON.stringify({ ok: true }));
      })
    );

    const { main } = await import("./client.js");
    await expect(main(["remote", "status", "--json=true"])).resolves.toBe(0);
    await expect(main(["remote", "status", "--json=banana"])).resolves.toBe(2);
  });

  it("rejects a non-numeric --ttl-ms as a usage error (exit 2)", async () => {
    writeCredentials();
    const { main } = await import("./client.js");
    await expect(main(["remote", "invite", "--ttl-ms", "soon", "--json"])).resolves.toBe(2);
  });

  it("treats corrupted credentials as not paired (exit 3, no crash)", async () => {
    writeCredentials("{not json");
    const { main } = await import("./client.js");
    await expect(main(["remote", "status", "--json"])).resolves.toBe(3);
    const output = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("not paired");
  });
});
