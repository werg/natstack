import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@natstack/shared/serviceDispatcher";

const mocks = vi.hoisted(() => ({
  app: {
    relaunch: vi.fn(),
    exit: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  loadRemoteCredentials: vi.fn(),
  saveRemoteCredentials: vi.fn(),
  clearRemoteCredentials: vi.fn(),
}));

vi.mock("electron", () => ({ app: mocks.app, dialog: mocks.dialog }));
vi.mock("../remoteCredentialStore.js", () => ({
  loadRemoteCredentials: mocks.loadRemoteCredentials,
  saveRemoteCredentials: mocks.saveRemoteCredentials,
  clearRemoteCredentials: mocks.clearRemoteCredentials,
}));

const shellCtx: ServiceContext = { caller: createVerifiedCaller("shell", "shell") };

describe("remoteCredService", () => {
  let server: Server | null = null;

  beforeEach(() => {
    mocks.app.relaunch.mockClear();
    mocks.app.exit.mockClear();
    mocks.loadRemoteCredentials.mockReset();
    mocks.saveRemoteCredentials.mockReset();
    mocks.clearRemoteCredentials.mockReset();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server = null;
    });
  });

  it("exchanges a pairing code and persists device-only credentials", async () => {
    const seenBodies: unknown[] = [];
    const url = await startAuthServer(async (req, res, body) => {
      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, serverId: "srv_1", workspaceId: "ws_1" }));
        return;
      }
      if (req.method === "POST" && req.url === "/_r/s/auth/complete-pairing") {
        seenBodies.push(JSON.parse(body || "{}"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ deviceId: "dev_1", refreshToken: "refresh_1" }));
        return;
      }
      res.writeHead(404).end();
    });

    const { createRemoteCredService } = await import("./remoteCredService.js");
    const service = createRemoteCredService({
      startupMode: { kind: "local", wsDir: "/tmp/ws", workspaceId: "ws", isEphemeral: false },
    });

    await expect(
      service.handler(shellCtx, "exchangePairingCode", [
        { url, code: "A".repeat(24), label: "Desk" },
      ])
    ).resolves.toEqual({ ok: true });

    expect(seenBodies).toEqual([{ code: "A".repeat(24), label: "Desk", platform: "desktop" }]);
    expect(mocks.saveRemoteCredentials).toHaveBeenCalledWith({
      kind: "device",
      url,
      deviceId: "dev_1",
      refreshToken: "refresh_1",
      caPath: undefined,
      fingerprint: undefined,
    });
    expect(mocks.app.relaunch).toHaveBeenCalled();
    expect(mocks.app.exit).toHaveBeenCalledWith(0);
  });

  it("probes a CA-valid HTTP health endpoint without TOFU", async () => {
    const url = await startAuthServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, version: "0.1.0", serverId: "srv_1" }));
        return;
      }
      res.writeHead(404).end();
    });

    const { probeRemoteTrust } = await import("./remoteCredService.js");
    await expect(probeRemoteTrust({ url })).resolves.toMatchObject({
      ok: true,
      serverVersion: "0.1.0",
      serverId: "srv_1",
    });
  });

  it.runIf(hasOpenssl())("exercises self-signed TLS TOFU and pin matching", async () => {
    const fixture = await startSelfSignedHealthServer();
    try {
      const { probeRemoteTrust } = await import("./remoteCredService.js");

      const unpinned = await probeRemoteTrust({ url: fixture.url });
      expect(unpinned).toMatchObject({
        ok: false,
        error: "tls-mismatch",
        observedFingerprint: fixture.fingerprint,
      });

      await expect(
        probeRemoteTrust({ url: fixture.url, fingerprint: fixture.fingerprint })
      ).resolves.toMatchObject({
        ok: true,
        serverId: "srv_tls",
        workspaceId: "ws_tls",
      });

      await expect(
        probeRemoteTrust({
          url: fixture.url,
          fingerprint: "AA:" + "00:".repeat(30) + "FF",
        })
      ).resolves.toMatchObject({
        ok: false,
        error: "tls-mismatch",
        observedFingerprint: fixture.fingerprint,
      });
    } finally {
      await fixture.close();
    }
  });

  it("proxies paired-device list and self-revoke through the active server client", async () => {
    mocks.loadRemoteCredentials.mockReturnValue({
      kind: "device",
      url: "https://host.tailnet.ts.net",
      deviceId: "dev_self",
      refreshToken: "refresh",
    });
    const call = vi.fn(async (_service: string, method: string) => {
      if (method === "listDevices") {
        return { devices: [{ deviceId: "dev_self", label: "This", createdAt: 1 }] };
      }
      if (method === "revokeDevice") return { revoked: true };
      throw new Error(method);
    });

    const { createRemoteCredService } = await import("./remoteCredService.js");
    const service = createRemoteCredService({
      startupMode: {
        kind: "remote",
        remoteUrl: new URL("https://host.tailnet.ts.net"),
        bootstrap: "device",
        deviceId: "dev_self",
        refreshToken: "refresh",
      },
      getServerClient: () => ({ call }) as never,
    });

    await expect(service.handler(shellCtx, "listDevices", [])).resolves.toEqual([
      { deviceId: "dev_self", label: "This", createdAt: 1 },
    ]);
    await expect(service.handler(shellCtx, "revokeDevice", ["dev_self"])).resolves.toEqual({
      revoked: true,
    });
    expect(call).toHaveBeenCalledWith("auth", "listDevices", []);
    expect(call).toHaveBeenCalledWith("auth", "revokeDevice", ["dev_self"]);
    expect(mocks.clearRemoteCredentials).toHaveBeenCalled();
    expect(mocks.app.relaunch).toHaveBeenCalled();
  });

  it("does not proxy paired-device management while running locally", async () => {
    const call = vi.fn();
    const { createRemoteCredService } = await import("./remoteCredService.js");
    const service = createRemoteCredService({
      startupMode: { kind: "local", wsDir: "/tmp/ws", workspaceId: "ws", isEphemeral: false },
      getServerClient: () => ({ call }) as never,
    });

    await expect(service.handler(shellCtx, "listDevices", [])).resolves.toEqual([]);
    await expect(service.handler(shellCtx, "revokeDevice", ["dev_self"])).rejects.toThrow(
      /remote server/
    );
    expect(call).not.toHaveBeenCalled();
  });

  async function startAuthServer(
    handler: (
      req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
      body: string
    ) => Promise<void> | void
  ): Promise<string> {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        void handler(req, res, Buffer.concat(chunks).toString("utf8"));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server port");
    return `http://127.0.0.1:${address.port}`;
  }
});

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function startSelfSignedHealthServer(): Promise<{
  url: string;
  fingerprint: string;
  close: () => Promise<void>;
}> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-remotecred-tls-"));
  const keyPath = path.join(tmpDir, "key.pem");
  const certPath = path.join(tmpDir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "pipe" }
  );
  const fingerprint = new X509Certificate(fs.readFileSync(certPath)).fingerprint256;
  const httpsServer = createHttpsServer({
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  });
  httpsServer.on("request", (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          product: "natstack",
          discoveryVersion: 1,
          serverId: "srv_tls",
          workspaceId: "ws_tls",
        })
      );
      return;
    }
    res.writeHead(404).end();
  });

  const port = await new Promise<number>((resolve) => {
    httpsServer.listen(0, "127.0.0.1", () => {
      const address = httpsServer.address();
      if (!address || typeof address === "string") throw new Error("missing server port");
      resolve(address.port);
    });
  });

  return {
    url: `https://127.0.0.1:${port}`,
    fingerprint,
    close: async () => {
      await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
