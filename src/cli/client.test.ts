import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createConnectDeepLink } from "@natstack/shared/connect";

const mocks = vi.hoisted(() => ({
  discoverNatstackServers: vi.fn(
    async (): Promise<Array<{ url: string; hostname: string; discoveryVersion: number }>> => []
  ),
}));

vi.mock("@natstack/shared/tailscaleDiscovery", () => ({
  discoverNatstackServers: mocks.discoverNatstackServers,
}));

describe("natstack-client", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-client-"));
    vi.stubEnv("HOME", tmpDir);
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
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        urls.push(String(url));
        bodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ deviceId: "dev_cli", refreshToken: "refresh_cli" }));
      })
    );

    const { main } = await import("./client.js");
    const code = await main([
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
    expect(urls).toEqual(["https://host.tailnet.ts.net/_r/s/auth/complete-pairing"]);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
      schemaVersion: 1,
      kind: "device",
      url: "https://host.tailnet.ts.net",
      deviceId: "dev_cli",
      refreshToken: "refresh_cli",
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it("pairs and stores supervisor tenant URLs without dropping the path prefix", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ deviceId: "dev_cli", refreshToken: "refresh_cli" }));
      })
    );

    const { main } = await import("./client.js");
    const code = await main([
      "pair",
      createConnectDeepLink("https://host.tailnet.ts.net/base/w/alpha", "A".repeat(24)),
    ]);

    expect(code).toBe(0);
    expect(urls).toEqual(["https://host.tailnet.ts.net/base/w/alpha/_r/s/auth/complete-pairing"]);
    const filePath = path.join(tmpDir, ".config", "natstack", "cli-credentials.json");
    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).url).toBe(
      "https://host.tailnet.ts.net/base/w/alpha"
    );
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
    await expect(main(["logout"])).resolves.toBe(0);
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
    await expect(main(["discover"])).resolves.toBe(0);

    expect(log).toHaveBeenCalledWith("https://host.tailnet.ts.net");
  });

  it("reports a failed or expired pairing code as non-zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ error: "pairing code expired" }), { status: 401 })
      )
    );

    const { main } = await import("./client.js");
    await expect(
      main(["pair", "--url", "https://host.tailnet.ts.net", "--code", "A".repeat(24)])
    ).resolves.toBe(1);
  });

  it("checks the stored device refresh credential for status", async () => {
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/_r/s/auth/refresh-shell")) {
          return new Response(JSON.stringify({ workspaceId: "ws_1", serverId: "srv_1" }));
        }
        return new Response(JSON.stringify({ ok: true, product: "natstack", discoveryVersion: 1 }));
      })
    );

    const { main } = await import("./client.js");
    await expect(main(["status"])).resolves.toBe(0);
  });

  it("checks status under a stored supervisor tenant URL", async () => {
    const credentialDir = path.join(tmpDir, ".config", "natstack");
    fs.mkdirSync(credentialDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialDir, "cli-credentials.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "device",
        url: "https://host.tailnet.ts.net/base/w/alpha",
        deviceId: "dev_cli",
        refreshToken: "refresh_cli",
      })
    );
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        urls.push(String(url));
        if (String(url).endsWith("/_r/s/auth/refresh-shell")) {
          return new Response(JSON.stringify({ workspaceId: "alpha", serverId: "srv_1" }));
        }
        return new Response(JSON.stringify({ ok: true, product: "natstack" }));
      })
    );

    const { main } = await import("./client.js");
    await expect(main(["status"])).resolves.toBe(0);
    expect(urls).toEqual([
      "https://host.tailnet.ts.net/base/w/alpha/_r/s/auth/refresh-shell",
      "https://host.tailnet.ts.net/base/w/alpha/healthz",
    ]);
  });
});
