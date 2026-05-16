import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
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
  };
}

async function postRpc(
  port: number,
  token: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body: json };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RpcServer HTTP POST /rpc", () => {
  let setup: ReturnType<typeof createTestSetup>;
  let gateway: Gateway;
  let port: number;

  beforeEach(async () => {
    setup = createTestSetup();
    setup.server.initHandlers();
    gateway = new Gateway({
      tokenManager: setup.tokenManager,
      externalHost: "localhost",
      getRpcHandler: () => setup.server,
    });
    port = await gateway.start(0);
  });

  afterEach(async () => {
    await gateway.stop();
    await setup.server.stop();
  });

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
      expect(body["error"]).toContain("Missing authorization");
    });

    it("rejects invalid token", async () => {
      const { status, body } = await postRpc(port, "invalid-token-xxx", {
        method: "credentials.listStoredCredentials",
        args: [],
      });
      expect(status).toBe(401);
      expect(body["error"]).toContain("Invalid token");
    });

    it("rejects admin token", async () => {
      const { status, body } = await postRpc(port, setup.adminToken, {
        method: "build.recompute",
        args: [],
      });
      expect(status).toBe(401);
      expect(body["error"]).toContain("issue a device credential");
    });

    it("accepts worker token", async () => {
      const { status, body } = await postRpc(port, setup.workerToken, {
        method: "credentials.listStoredCredentials",
        args: [],
      });
      expect(status).toBe(200);
      expect(body["result"]).toBeDefined();
    });
  });

  describe("websocket origin allow-list", () => {
    it("rejects websocket upgrades from disallowed origins", async () => {
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
      await expect(
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
            headers: { Origin: "http://localhost:5173" },
          });
          ws.once("open", () => {
            ws.close();
            resolve();
          });
          ws.once("error", reject);
        })
      ).resolves.toBeUndefined();
    });

    it("allows the configured public URL origin", async () => {
      await gateway.stop();
      gateway = new Gateway({
        tokenManager: setup.tokenManager,
        externalHost: "internal.example",
        getPublicUrl: () => "https://public.example:8443/base",
        getRpcHandler: () => setup.server,
      });
      port = await gateway.start(0);

      await expect(
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
            headers: { Origin: "https://public.example:8443" },
          });
          ws.once("open", () => {
            ws.close();
            resolve();
          });
          ws.once("error", reject);
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

      const { body } = await postRpc(port, setup.workerToken, {
        method: "credentials.listStoredCredentials",
        args: [],
      });

      expect(body["result"]).toEqual([{ id: "cred-1", label: "Example" }]);
      expect(setup.dispatched[0]!.service).toBe("credentials");
      expect(setup.dispatched[0]!.method).toBe("listStoredCredentials");
    });

    it("passes args to dispatcher", async () => {
      await postRpc(port, setup.workerToken, {
        method: "credentials.resolveCredential",
        args: [{ url: "https://api.example.com/", credentialId: "cred-1" }],
      });

      expect(setup.dispatched[0]!.args).toEqual([
        { url: "https://api.example.com/", credentialId: "cred-1" },
      ]);
    });

    it("builds correct ServiceContext from worker token", async () => {
      await postRpc(port, setup.workerToken, {
        method: "credentials.listStoredCredentials",
        args: [],
      });

      expect(setup.dispatched[0]!.ctx).toEqual({
        callerId: "do:test:Worker:obj1",
        callerKind: "worker",
      });
    });

    it("builds correct ServiceContext from shell token", async () => {
      const shellToken = setup.tokenManager.ensureToken("electron-shell", "shell");
      await postRpc(port, shellToken, {
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

      const { status, body } = await postRpc(port, setup.workerToken, {
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
      const { body } = await postRpc(port, setup.panelToken, {
        method: "harness.spawn",
        args: [{}],
      });

      expect(body["error"]).toContain("not accessible");
      expect(setup.dispatched).toHaveLength(0);
    });

    it("allows worker calling credentials service", async () => {
      await postRpc(port, setup.workerToken, {
        method: "credentials.listStoredCredentials",
        args: [],
      });

      expect(setup.dispatched).toHaveLength(1);
    });

    it("rejects invalid method format", async () => {
      const { body } = await postRpc(port, setup.workerToken, {
        method: "no-dot-separator",
        args: [],
      });

      expect(body["error"]).toContain("Invalid method format");
    });

    it("rejects unknown service", async () => {
      const { body } = await postRpc(port, setup.workerToken, {
        method: "nonexistent.foo",
        args: [],
      });

      expect(body["error"]).toContain("Unknown service");
    });
  });

  // ── HTTP routing ────────────────────────────────────────────────────────────

  describe("HTTP routing", () => {
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
      await postRpc(port, setup.workerToken, {
        targetId: "main",
        method: "credentials.listStoredCredentials",
        args: [],
      });

      expect(setup.dispatched).toHaveLength(1);
    });

    it("rejects panel relay to an unrelated panel", async () => {
      const { body } = await postRpc(port, setup.childPanelToken, {
        type: "call",
        targetId: "panel-unrelated",
        method: "foo.bar",
        args: [],
      });

      expect(body["error"]).toContain("cannot relay to unrelated panel");
    });

    it("allows panel relay to an ancestor panel", async () => {
      const { body } = await postRpc(port, setup.childPanelToken, {
        type: "call",
        targetId: "panel-parent",
        method: "foo.bar",
        args: [],
      });

      expect(body["error"]).toContain("Target not reachable");
      expect(body["error"]).not.toContain("cannot relay to unrelated panel");
    });

    it("allows panel relay to itself", async () => {
      const { body } = await postRpc(port, setup.parentPanelToken, {
        type: "call",
        targetId: "panel-parent",
        method: "foo.bar",
        args: [],
      });

      expect(body["error"]).toContain("Target not reachable");
      expect(body["error"]).not.toContain("cannot relay to unrelated panel");
    });
  });

  describe("/rpc/stream service-policy enforcement", () => {
    it("denies a caller-kind not in the credentials service policy", async () => {
      // Set up an RpcServer whose dispatcher only allows `shell` on
      // `credentials`. A worker token should be rejected by
      // `validateStreamingProxyFetch` BEFORE any frames are emitted.
      const tokenManager = new TokenManager();
      const workerToken = tokenManager.ensureToken("do:test:Worker:obj1", "worker");
      const stubEgress = { forwardProxyFetchStream: vi.fn() };
      const dispatcher = {
        dispatch: vi.fn(),
        getPolicy: vi.fn((service: string) => {
          if (service === "credentials") {
            return { allowed: ["shell"] as CallerKind[] };
          }
          return undefined;
        }),
        getMethodPolicy: vi.fn(() => undefined),
        initialized: true,
      } as unknown as ServiceDispatcher;
      const server = new RpcServer({ tokenManager, dispatcher, egressProxy: stubEgress });
      server.initHandlers();
      const gw = new Gateway({
        tokenManager,
        externalHost: "localhost",
        getRpcHandler: () => server,
      });
      const p = await gw.start(0);
      try {
        const res = await fetch(`http://127.0.0.1:${p}/rpc/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${workerToken}`,
          },
          body: JSON.stringify({
            targetId: "main",
            method: "credentials.proxyFetch",
            args: [{ url: "https://example.com/", method: "GET" }],
          }),
        });
        expect(res.status).toBe(403);
        expect(stubEgress.forwardProxyFetchStream).not.toHaveBeenCalled();
      } finally {
        await gw.stop();
        await server.stop();
      }
    });
  });

  describe("/rpc/stream streaming proxy fetch", () => {
    it("returns 503 when no egressProxy is wired in", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/rpc/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${setup.workerToken}`,
        },
        body: JSON.stringify({
          targetId: "main",
          method: "credentials.proxyFetch",
          args: [{ url: "https://example.com/", method: "GET" }],
        }),
      });
      expect(res.status).toBe(503);
    });

    it("rejects methods other than credentials.proxyFetch", async () => {
      const tokenManager = new TokenManager();
      const workerToken = tokenManager.ensureToken("do:test:Worker:obj1", "worker");
      const stubEgress = {
        forwardProxyFetchStream: vi.fn(),
      };
      const dispatcher = {
        dispatch: vi.fn(),
        getPolicy: vi.fn(),
        getMethodPolicy: vi.fn(() => undefined),
        initialized: true,
      } as unknown as ServiceDispatcher;
      const server = new RpcServer({
        tokenManager,
        dispatcher,
        egressProxy: stubEgress,
      });
      server.initHandlers();
      const gw = new Gateway({
        tokenManager,
        externalHost: "localhost",
        getRpcHandler: () => server,
      });
      const p = await gw.start(0);
      try {
        const res = await fetch(`http://127.0.0.1:${p}/rpc/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${workerToken}`,
          },
          body: JSON.stringify({
            targetId: "main",
            method: "credentials.listStoredCredentials",
            args: [],
          }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain("not exposed on the streaming endpoint");
        expect(stubEgress.forwardProxyFetchStream).not.toHaveBeenCalled();
      } finally {
        await gw.stop();
        await server.stop();
      }
    });

    it("emits framed HEAD, DATA, END frames and decodes round-trip", async () => {
      const tokenManager = new TokenManager();
      const workerToken = tokenManager.ensureToken("do:test:Worker:obj1", "worker");
      const stubEgress = {
        forwardProxyFetchStream: vi.fn(async (
          _params: { callerId: string; url: string; method: string },
          sink: (frame: {
            kind: string;
            status?: number;
            statusText?: string;
            headerPairs?: Array<[string, string]>;
            finalUrl?: string;
            bytes?: Uint8Array;
            bytesIn?: number;
          }) => Promise<void> | void,
        ) => {
          await sink({
            kind: "head",
            status: 200,
            statusText: "OK",
            headerPairs: [
              ["content-type", "text/plain"],
              ["set-cookie", "a=1"],
              ["set-cookie", "b=2"],
            ],
            finalUrl: "https://example.com/landing",
          });
          await sink({ kind: "chunk", bytes: new Uint8Array([0x68, 0x65]) });
          await sink({ kind: "chunk", bytes: new Uint8Array([0x6c, 0x6c, 0x6f]) });
          await sink({ kind: "end", bytesIn: 5 });
          return { status: 200, bytesIn: 5 };
        }),
      };
      const dispatcher = {
        dispatch: vi.fn(),
        getPolicy: vi.fn((service: string) => {
          if (service === "credentials") {
            return { allowed: ["shell", "panel", "worker"] as CallerKind[] };
          }
          return undefined;
        }),
        getMethodPolicy: vi.fn(() => undefined),
        initialized: true,
      } as unknown as ServiceDispatcher;
      const server = new RpcServer({
        tokenManager,
        dispatcher,
        egressProxy: stubEgress,
      });
      server.initHandlers();
      const gw = new Gateway({
        tokenManager,
        externalHost: "localhost",
        getRpcHandler: () => server,
      });
      const p = await gw.start(0);
      try {
        const res = await fetch(`http://127.0.0.1:${p}/rpc/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${workerToken}`,
          },
          body: JSON.stringify({
            targetId: "main",
            method: "credentials.proxyFetch",
            args: [{ url: "https://example.com/", method: "GET" }],
          }),
        });
        expect(res.status).toBe(200);
        const buf = new Uint8Array(await res.arrayBuffer());

        const {
          FrameDecoder,
          FRAME_HEAD,
          FRAME_DATA,
          FRAME_END,
          parseHeadFrame,
          parseEndFrame,
        } = await import("../../packages/shared/src/credentials/streamFraming.js");

        const frames: Array<{ type: number; payload: Uint8Array }> = [];
        const decoder = new FrameDecoder((type, payload) => {
          frames.push({ type, payload });
        });
        await decoder.push(buf);

        expect(frames.map((f) => f.type)).toEqual([FRAME_HEAD, FRAME_DATA, FRAME_DATA, FRAME_END]);
        const head = parseHeadFrame(frames[0]!.payload);
        expect(head.status).toBe(200);
        expect(head.finalUrl).toBe("https://example.com/landing");
        expect(head.headerPairs.filter(([k]) => k === "set-cookie").map(([, v]) => v)).toEqual(["a=1", "b=2"]);
        const bodyBytes = new Uint8Array(
          frames[1]!.payload.byteLength + frames[2]!.payload.byteLength,
        );
        bodyBytes.set(frames[1]!.payload, 0);
        bodyBytes.set(frames[2]!.payload, frames[1]!.payload.byteLength);
        expect(new TextDecoder().decode(bodyBytes)).toBe("hello");
        expect(parseEndFrame(frames[3]!.payload).bytesIn).toBe(5);
      } finally {
        await gw.stop();
        await server.stop();
      }
    });
  });
});
