import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { createServer, type Server as HttpServer } from "http";
import { RpcServer } from "./rpcServer.js";
import { Gateway } from "./gateway.js";
import type {
  ServiceDispatcher,
  ServiceContext,
  CallerKind,
} from "../../packages/shared/src/serviceDispatcher.js";
import { TokenManager } from "../../packages/shared/src/tokenManager.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function createTestSetup() {
  const tokenManager = new TokenManager();
  const adminToken = "test-admin-token";
  tokenManager.setAdminToken(adminToken);
  const workerToken = tokenManager.ensureToken("do:test:Worker:obj1", "worker");
  const panelToken = tokenManager.ensureToken("panel-abc", "panel");
  const parentPanelToken = tokenManager.ensureToken("panel-parent", "panel");
  tokenManager.setPanelParent("panel-parent", null);
  const childPanelToken = tokenManager.ensureToken("panel-child", "panel");
  tokenManager.setPanelParent("panel-child", "panel-parent");
  const unrelatedPanelToken = tokenManager.ensureToken("panel-unrelated", "panel");
  tokenManager.setPanelParent("panel-unrelated", null);

  const dispatchResults = new Map<string, unknown>();
  const dispatched: Array<{
    ctx: ServiceContext;
    service: string;
    method: string;
    args: unknown[];
  }> = [];

  const dispatcher = {
    dispatch: vi.fn(
      async (ctx: ServiceContext, service: string, method: string, args: unknown[]) => {
        dispatched.push({ ctx, service, method, args });
        const key = `${service}.${method}`;
        if (dispatchResults.has(key)) return dispatchResults.get(key);
        return { ok: true };
      }
    ),
    getPolicy: vi.fn((service: string) => {
      if (service === "credentials")
        return { allowed: ["shell", "panel", "worker"] as CallerKind[] };
      if (service === "harness")
        return { allowed: ["harness", "server", "worker"] as CallerKind[] };
      if (service === "build")
        return { allowed: ["panel", "shell", "server", "worker"] as CallerKind[] };
      return undefined;
    }),
    getMethodPolicy: vi.fn(() => undefined),
    initialized: true,
  } as unknown as ServiceDispatcher;

  const server = new RpcServer({ tokenManager, dispatcher });

  return {
    server,
    tokenManager,
    adminToken,
    workerToken,
    panelToken,
    parentPanelToken,
    childPanelToken,
    unrelatedPanelToken,
    dispatcher,
    dispatched,
    dispatchResults,
    workerCaller: { callerId: "do:test:Worker:obj1", callerKind: "worker" as CallerKind },
    panelCaller: { callerId: "panel-abc", callerKind: "panel" as CallerKind },
    parentPanelCaller: { callerId: "panel-parent", callerKind: "panel" as CallerKind },
    childPanelCaller: { callerId: "panel-child", callerKind: "panel" as CallerKind },
    shellCaller: { callerId: "electron-shell", callerKind: "shell" as CallerKind },
  };
}

async function postRpc(
  port: number,
  caller: { callerId: string; callerKind: CallerKind },
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-caller-id": caller.callerId,
      "x-test-caller-kind": caller.callerKind,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body: json };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RpcServer HTTP POST /rpc", () => {
  let setup: ReturnType<typeof createTestSetup>;
  let gateway: Gateway | null;
  let rpcHttpServer: HttpServer | null;
  let port: number;

  beforeEach(async () => {
    setup = createTestSetup();
    setup.server.initHandlers();
    gateway = null;
    rpcHttpServer = createServer((req, res) => {
      const callerId =
        typeof req.headers["x-test-caller-id"] === "string" ? req.headers["x-test-caller-id"] : "";
      const callerKind = req.headers["x-test-caller-kind"];
      if (
        callerId &&
        (callerKind === "panel" ||
          callerKind === "worker" ||
          callerKind === "shell" ||
          callerKind === "server")
      ) {
        req.natstackCaller = { callerId, callerKind };
      }
      void setup.server.handleGatewayHttpRequest(req, res);
    });
    port = await new Promise((resolve) => {
      rpcHttpServer!.listen(0, "127.0.0.1", () => {
        const addr = rpcHttpServer!.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
  });

  afterEach(async () => {
    if (gateway) await gateway.stop();
    if (rpcHttpServer) {
      await new Promise<void>((resolve) => rpcHttpServer!.close(() => resolve()));
    }
    await setup.server.stop();
  });

  async function startGatewayForOriginTest(options?: {
    externalHost?: string;
    getPublicUrl?: () => string;
  }): Promise<void> {
    if (rpcHttpServer) {
      await new Promise<void>((resolve) => rpcHttpServer!.close(() => resolve()));
      rpcHttpServer = null;
    }
    gateway = new Gateway({
      externalHost: options?.externalHost ?? "localhost",
      getPublicUrl: options?.getPublicUrl,
      getRpcHandler: () => setup.server,
    });
    port = await gateway.start(0);
  }

  // ── Authentication ──────────────────────────────────────────────────────────

  describe("authentication", () => {
    it("rejects requests without authorization header", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "credentials.listStoredCredentials", args: [] }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body["error"]).toContain("Missing verified caller identity");
    });

    it("rejects bearer tokens without verified caller identity", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer invalid-token-xxx",
        },
        body: JSON.stringify({
          method: "credentials.listStoredCredentials",
          args: [],
        }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(401);
      expect(body["error"]).toContain("Missing verified caller identity");
    });

    it("accepts verified worker caller", async () => {
      const { status, body } = await postRpc(port, setup.workerCaller, {
        method: "credentials.listStoredCredentials",
        args: [],
      });
      expect(status).toBe(200);
      expect(body["result"]).toBeDefined();
    });
  });

  describe("websocket origin allow-list", () => {
    it("rejects websocket upgrades from disallowed origins", async () => {
      await startGatewayForOriginTest();
      await expect(
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
            headers: { Origin: "https://evil.example" },
          });
          ws.once("open", () => {
            ws.close();
            reject(new Error("unexpected websocket upgrade"));
          });
          ws.once("error", (err) => {
            try {
              expect(err.message).toContain("Unexpected server response: 403");
              resolve();
            } catch (expectErr) {
              reject(expectErr);
            }
          });
        })
      ).resolves.toBeUndefined();
    });

    it("allows loopback websocket origins", async () => {
      await startGatewayForOriginTest();
      await expect(
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
            headers: { Origin: "http://localhost:5173" },
          });
          ws.once("open", () => {
            ws.close();
            reject(new Error("unexpected websocket upgrade without caller identity"));
          });
          ws.once("error", (err) => {
            try {
              expect(err.message).toContain("Unexpected server response: 401");
              resolve();
            } catch (expectErr) {
              reject(expectErr);
            }
          });
        })
      ).resolves.toBeUndefined();
    });

    it("allows the configured public URL origin", async () => {
      await startGatewayForOriginTest({
        externalHost: "internal.example",
        getPublicUrl: () => "https://public.example:8443/base",
      });

      await expect(
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
            headers: { Origin: "https://public.example:8443" },
          });
          ws.once("open", () => {
            ws.close();
            reject(new Error("unexpected websocket upgrade without caller identity"));
          });
          ws.once("error", (err) => {
            try {
              expect(err.message).toContain("Unexpected server response: 401");
              resolve();
            } catch (expectErr) {
              reject(expectErr);
            }
          });
        })
      ).resolves.toBeUndefined();
    });
  });

  // ── Service dispatch ────────────────────────────────────────────────────────

  describe("service dispatch", () => {
    it("dispatches to correct service and method", async () => {
      setup.dispatchResults.set("credentials.listStoredCredentials", [
        { id: "cred-1", label: "Example" },
      ]);

      const { body } = await postRpc(port, setup.workerCaller, {
        method: "credentials.listStoredCredentials",
        args: [],
      });

      expect(body["result"]).toEqual([{ id: "cred-1", label: "Example" }]);
      expect(setup.dispatched[0]!.service).toBe("credentials");
      expect(setup.dispatched[0]!.method).toBe("listStoredCredentials");
    });

    it("passes args to dispatcher", async () => {
      await postRpc(port, setup.workerCaller, {
        method: "credentials.resolveCredential",
        args: [{ url: "https://api.example.com/", credentialId: "cred-1" }],
      });

      expect(setup.dispatched[0]!.args).toEqual([
        { url: "https://api.example.com/", credentialId: "cred-1" },
      ]);
    });

    it("builds correct ServiceContext from worker token", async () => {
      await postRpc(port, setup.workerCaller, {
        method: "credentials.listStoredCredentials",
        args: [],
      });

      expect(setup.dispatched[0]!.ctx).toEqual({
        callerId: "do:test:Worker:obj1",
        callerKind: "worker",
      });
    });

    it("builds correct ServiceContext from shell token", async () => {
      await postRpc(port, setup.shellCaller, {
        method: "build.recompute",
        args: [],
      });

      expect(setup.dispatched[0]!.ctx).toEqual({
        callerId: "electron-shell",
        callerKind: "shell",
      });
    });

    it("returns dispatch errors in body (not HTTP error)", async () => {
      (setup.dispatcher.dispatch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("token expired")
      );

      const { status, body } = await postRpc(port, setup.workerCaller, {
        method: "credentials.resolveCredential",
        args: [{ url: "https://api.example.com/", credentialId: "cred-1" }],
      });

      // HTTP 200, error in body (RPC convention)
      expect(status).toBe(200);
      expect(body["error"]).toBe("token expired");
    });
  });

  // ── Policy enforcement ──────────────────────────────────────────────────────

  describe("policy enforcement", () => {
    it("rejects panel calling harness service", async () => {
      const { body } = await postRpc(port, setup.panelCaller, {
        method: "harness.spawn",
        args: [{}],
      });

      expect(body["error"]).toContain("not accessible");
      expect(setup.dispatched).toHaveLength(0);
    });

    it("allows worker calling credentials service", async () => {
      await postRpc(port, setup.workerCaller, {
        method: "credentials.listStoredCredentials",
        args: [],
      });

      expect(setup.dispatched).toHaveLength(1);
    });

    it("rejects invalid method format", async () => {
      const { body } = await postRpc(port, setup.workerCaller, {
        method: "no-dot-separator",
        args: [],
      });

      expect(body["error"]).toContain("Invalid method format");
    });

    it("rejects unknown service", async () => {
      const { body } = await postRpc(port, setup.workerCaller, {
        method: "nonexistent.foo",
        args: [],
      });

      expect(body["error"]).toContain("Unknown service");
    });
  });

  // ── HTTP routing ────────────────────────────────────────────────────────────

  describe("HTTP routing", () => {
    it("does not expose POST /rpc on the direct gateway HTTP listener", async () => {
      await startGatewayForOriginTest();
      const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "credentials.listStoredCredentials", args: [] }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 for non-/rpc paths", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/other`, {
        method: "POST",
        headers: { Authorization: `Bearer ${setup.workerToken}` },
        body: "{}",
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 for GET /rpc", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: "GET",
        headers: { Authorization: `Bearer ${setup.workerToken}` },
      });
      expect(res.status).toBe(404);
    });

    it("treats targetId=main as direct dispatch", async () => {
      await postRpc(port, setup.workerCaller, {
        targetId: "main",
        method: "credentials.listStoredCredentials",
        args: [],
      });

      expect(setup.dispatched).toHaveLength(1);
    });

    it("allows panel relay to unrelated panels and reports reachability separately", async () => {
      const { body } = await postRpc(port, setup.childPanelCaller, {
        type: "call",
        targetId: "panel-unrelated",
        method: "foo.bar",
        args: [],
      });

      expect(body["error"]).toContain("Target not reachable");
      expect(body["error"]).not.toContain("cannot relay to unrelated panel");
    });

    it("allows panel relay to an ancestor panel", async () => {
      const { body } = await postRpc(port, setup.childPanelCaller, {
        type: "call",
        targetId: "panel-parent",
        method: "foo.bar",
        args: [],
      });

      expect(body["error"]).toContain("Target not reachable");
      expect(body["error"]).not.toContain("cannot relay to unrelated panel");
    });

    it("allows panel relay to itself", async () => {
      const { body } = await postRpc(port, setup.parentPanelCaller, {
        type: "call",
        targetId: "panel-parent",
        method: "foo.bar",
        args: [],
      });

      expect(body["error"]).toContain("Target not reachable");
      expect(body["error"]).not.toContain("cannot relay to unrelated panel");
    });
  });
});
