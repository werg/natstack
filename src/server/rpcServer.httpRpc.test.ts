import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RpcServer } from "./rpcServer.js";
import type { ServiceDispatcher, ServiceContext, CallerKind } from "@natstack/shared/serviceDispatcher";
import { TokenManager } from "@natstack/shared/tokenManager";

// ── Helpers ───────────────────────────────────────────────────────────────────

function createTestSetup() {
  const tokenManager = new TokenManager();
  const adminToken = "test-admin-token";
  tokenManager.setAdminToken(adminToken);
  const workerToken = tokenManager.ensureToken("do:test:Worker:obj1", "worker");
  const panelToken = tokenManager.ensureToken("panel-abc", "panel");

  const dispatchResults = new Map<string, unknown>();
  const dispatched: Array<{ ctx: ServiceContext; service: string; method: string; args: unknown[] }> = [];

  const dispatcher = {
    dispatch: vi.fn(async (ctx: ServiceContext, service: string, method: string, args: unknown[]) => {
      dispatched.push({ ctx, service, method, args });
      const key = `${service}.${method}`;
      if (dispatchResults.has(key)) return dispatchResults.get(key);
      return { ok: true };
    }),
    getPolicy: vi.fn((service: string) => {
      if (service === "oauth") return { allowed: ["shell", "panel", "worker"] as CallerKind[] };
      if (service === "harness") return { allowed: ["harness", "server", "worker"] as CallerKind[] };
      if (service === "build") return { allowed: ["panel", "shell", "server", "worker"] as CallerKind[] };
      return undefined;
    }),
    getMethodPolicy: vi.fn(() => undefined),
    initialized: true,
  } as unknown as ServiceDispatcher;

  const server = new RpcServer({ tokenManager, dispatcher });

  return { server, tokenManager, adminToken, workerToken, panelToken, dispatcher, dispatched, dispatchResults };
}

async function postRpc(port: number, token: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json() as Record<string, unknown>;
  return { status: res.status, body: json };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RpcServer HTTP POST /rpc", () => {
  let setup: ReturnType<typeof createTestSetup>;
  let port: number;

  beforeEach(async () => {
    setup = createTestSetup();
    port = await setup.server.start();
  });

  afterEach(async () => {
    await setup.server.stop();
  });

  // ── Authentication ──────────────────────────────────────────────────────────

  describe("authentication", () => {
    it("rejects requests without authorization header", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "oauth.getToken", args: [] }),
      });
      expect(res.status).toBe(401);
      const body = await res.json() as { error: string };
      expect(body["error"]).toContain("Missing authorization");
    });

    it("rejects invalid token", async () => {
      const { status, body } = await postRpc(port, "invalid-token-xxx", {
        method: "oauth.getToken",
        args: [],
      });
      expect(status).toBe(401);
      expect(body["error"]).toContain("Invalid token");
    });

    it("accepts admin token", async () => {
      const { status, body } = await postRpc(port, setup.adminToken, {
        method: "build.recompute",
        args: [],
      });
      expect(status).toBe(200);
      expect(body["result"]).toBeDefined();
    });

    it("accepts worker token", async () => {
      const { status, body } = await postRpc(port, setup.workerToken, {
        method: "oauth.listProviders",
        args: [],
      });
      expect(status).toBe(200);
      expect(body["result"]).toBeDefined();
    });
  });

  // ── Service dispatch ────────────────────────────────────────────────────────

  describe("service dispatch", () => {
    it("dispatches to correct service and method", async () => {
      setup.dispatchResults.set("oauth.listProviders", [{ key: "google", provider: "google" }]);

      const { body } = await postRpc(port, setup.workerToken, {
        method: "oauth.listProviders",
        args: [],
      });

      expect(body["result"]).toEqual([{ key: "google", provider: "google" }]);
      expect(setup.dispatched[0]!.service).toBe("oauth");
      expect(setup.dispatched[0]!.method).toBe("listProviders");
    });

    it("passes args to dispatcher", async () => {
      await postRpc(port, setup.workerToken, {
        method: "oauth.getToken",
        args: ["google-mail", "conn-1"],
      });

      expect(setup.dispatched[0]!.args).toEqual(["google-mail", "conn-1"]);
    });

    it("builds correct ServiceContext from worker token", async () => {
      await postRpc(port, setup.workerToken, {
        method: "oauth.listProviders",
        args: [],
      });

      expect(setup.dispatched[0]!.ctx).toEqual({
        callerId: "do:test:Worker:obj1",
        callerKind: "worker",
      });
    });

    it("builds correct ServiceContext from admin token", async () => {
      await postRpc(port, setup.adminToken, {
        method: "build.recompute",
        args: [],
      });

      expect(setup.dispatched[0]!.ctx).toEqual({
        callerId: "server",
        callerKind: "server",
      });
    });

    it("returns dispatch errors in body (not HTTP error)", async () => {
      (setup.dispatcher.dispatch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("token expired"));

      const { status, body } = await postRpc(port, setup.workerToken, {
        method: "oauth.getToken",
        args: ["google-mail", "conn-1"],
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

    it("allows worker calling oauth service", async () => {
      await postRpc(port, setup.workerToken, {
        method: "oauth.listProviders",
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
        headers: { "Authorization": `Bearer ${setup.workerToken}` },
        body: "{}",
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 for GET /rpc", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${setup.workerToken}` },
      });
      expect(res.status).toBe(404);
    });

    it("treats targetId=main as direct dispatch", async () => {
      await postRpc(port, setup.workerToken, {
        targetId: "main",
        method: "oauth.listProviders",
        args: [],
      });

      expect(setup.dispatched).toHaveLength(1);
    });
  });
});
