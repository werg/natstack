import { describe, it, expect, vi } from "vitest";
import { WebSocket } from "ws";
import { TokenManager } from "../../packages/shared/src/tokenManager.js";
import { RpcServer } from "./rpcServer.js";
import type { WsClientState } from "./rpcServer.js";

function createServer() {
  const tokenManager = new TokenManager();
  tokenManager.ensureToken("panel-a", "panel");
  tokenManager.ensureToken("panel-b", "panel");
  tokenManager.setPanelParent("panel-a", null);
  tokenManager.setPanelParent("panel-b", null);

  const dispatcher = {
    dispatch: vi.fn(),
    getPolicy: vi.fn(),
    getMethodPolicy: vi.fn(),
  } as any;

  return {
    tokenManager,
    server: new RpcServer({ tokenManager, dispatcher }),
  };
}

function createClient(callerId = "panel-a"): WsClientState {
  return {
    callerId,
    connectionId: "conn-1",
    callerKind: "panel",
    authenticated: true,
    authenticatedAt: Date.now(),
    ws: {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as any,
  };
}

function createClientWithConnection(callerId: string, connectionId: string): WsClientState {
  const client = createClient(callerId);
  client.connectionId = connectionId;
  client.authenticatedAt = connectionId === "conn-1" ? 1 : 2;
  return client;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("RpcServer relay behavior", () => {
  it("keeps distinct connections for the same caller authenticated simultaneously", () => {
    const { server, tokenManager } = createServer();
    const token = tokenManager.getToken("panel-a");
    const ws1 = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };
    const ws2 = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };

    (server as any).handleAuth(ws1, token, "conn-1");
    (server as any).handleAuth(ws2, token, "conn-2");

    expect(ws1.close).not.toHaveBeenCalled();
    expect(ws2.close).not.toHaveBeenCalled();
    expect((server as any).callerConnections.get("panel-a").size).toBe(2);
    expect(JSON.parse(ws1.send.mock.calls[0]![0])).toMatchObject({
      type: "ws:auth-result",
      success: true,
      connectionId: "conn-1",
      serverBootId: expect.any(String),
    });
    expect(JSON.parse(ws2.send.mock.calls[0]![0])).toMatchObject({
      type: "ws:auth-result",
      success: true,
      connectionId: "conn-2",
      serverBootId: expect.any(String),
    });
  });

  it("fans routed events out to every live connection for the target caller", () => {
    const { server, tokenManager } = createServer();
    tokenManager.setPanelParent("panel-b", "panel-a");
    const source = createClientWithConnection("panel-a", "source-conn");
    const target1 = createClientWithConnection("panel-b", "conn-1");
    const target2 = createClientWithConnection("panel-b", "conn-2");
    (server as any).callerConnections.set("panel-b", new Map([
      ["conn-1", target1],
      ["conn-2", target2],
    ]));

    (server as any).handleRoute(source, "panel-b", {
      type: "event",
      fromId: "panel-a",
      event: "test:event",
      payload: { ok: true },
    });

    expect(target1.ws.send).toHaveBeenCalledTimes(1);
    expect(target2.ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse((target1.ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toMatchObject({
      type: "ws:routed",
      fromId: "panel-a",
      message: { type: "event", event: "test:event", payload: { ok: true } },
    });
  });

  it("steers routed responses back to the origin connection", async () => {
    const { server, tokenManager } = createServer();
    tokenManager.setPanelParent("panel-b", "panel-a");
    const origin1 = createClientWithConnection("panel-a", "conn-1");
    const origin2 = createClientWithConnection("panel-a", "conn-2");
    const target = createClientWithConnection("panel-b", "target-conn");
    (server as any).callerConnections.set("panel-a", new Map([
      ["conn-1", origin1],
      ["conn-2", origin2],
    ]));
    (server as any).callerConnections.set("panel-b", new Map([["target-conn", target]]));

    (server as any).handleRoute(origin2, "panel-b", {
      type: "request",
      requestId: "req-origin-2",
      method: "test.method",
      args: [],
    });
    (target.ws.send as ReturnType<typeof vi.fn>).mockClear();

    (server as any).handleRoute(target, "panel-a", {
      type: "response",
      requestId: "req-origin-2",
      result: { ok: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(origin1.ws.send).not.toHaveBeenCalled();
    expect(origin2.ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse((origin2.ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toMatchObject({
      type: "ws:routed",
      fromId: "panel-b",
      message: { type: "response", requestId: "req-origin-2", result: { ok: true } },
    });
  });

  it("keeps routed response origins while the origin connection reconnects", async () => {
    vi.useFakeTimers();
    try {
      const { server, tokenManager } = createServer();
      tokenManager.setPanelParent("panel-b", "panel-a");
      const origin1 = createClientWithConnection("panel-a", "conn-1");
      const origin2 = createClientWithConnection("panel-a", "conn-2");
      const target = createClientWithConnection("panel-b", "target-conn");
      (server as any).callerConnections.set("panel-a", new Map([
        ["conn-1", origin1],
        ["conn-2", origin2],
      ]));
      (server as any).callerConnections.set("panel-b", new Map([["target-conn", target]]));

      (server as any).handleRoute(origin2, "panel-b", {
        type: "request",
        requestId: "req-reconnect",
        method: "test.method",
        args: [],
      });
      (server as any).handleClose(origin2, 1006, "network");

      (server as any).handleRoute(target, "panel-a", {
        type: "response",
        requestId: "req-reconnect",
        result: { ok: true },
      });
      await Promise.resolve();

      const reconnected = createClientWithConnection("panel-a", "conn-2");
      (server as any).callerConnections.get("panel-a").set("conn-2", reconnected);
      const waiter = (server as any).connectionReconnectWaiters.get("panel-a:conn-2");
      expect(waiter).toBeTruthy();
      waiter.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(origin1.ws.send).not.toHaveBeenCalled();
      expect(reconnected.ws.send).toHaveBeenCalledTimes(1);
      expect(JSON.parse((reconnected.ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toMatchObject({
        type: "ws:routed",
        fromId: "panel-b",
        message: { type: "response", requestId: "req-reconnect", result: { ok: true } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces event relay auth failures with ws:routed-event-error", () => {
    const { server } = createServer();
    const client = createClient();

    (server as any).handleRoute(client, "panel-b", {
      type: "event",
      fromId: "panel-a",
      event: "test:event",
      payload: { ok: true },
    });

    expect(client.ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse((client.ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toMatchObject({
      type: "ws:routed-event-error",
      targetId: "panel-b",
      event: "test:event",
      error: "Panel panel-a cannot relay to unrelated panel panel-b",
    });
  });

  it("preserves reconnect grace expiry on relayCall", async () => {
    const { server } = createServer();
    const deferred = createDeferred<void>();
    (server as any).reconnectWaiters.set("panel-b", { ...deferred });

    const relay = (server as any).relayCall("panel-a", "panel-b", "test.method", []);
    deferred.reject(Object.assign(new Error("Client did not reconnect within grace window"), {
      code: "RECONNECT_GRACE_EXPIRED",
    }));

    await expect(relay).rejects.toMatchObject({
      message: "Target panel-b did not reconnect within grace window",
      code: "RECONNECT_GRACE_EXPIRED",
    });
  });

  it("preserves server shutdown on relayCall", async () => {
    const { server } = createServer();
    const deferred = createDeferred<void>();
    (server as any).reconnectWaiters.set("panel-b", { ...deferred });

    const relay = (server as any).relayCall("panel-a", "panel-b", "test.method", []);
    deferred.reject(Object.assign(new Error("Server shutting down"), {
      code: "SERVER_SHUTTING_DOWN",
    }));

    await expect(relay).rejects.toMatchObject({
      message: "Server shutting down",
      code: "SERVER_SHUTTING_DOWN",
    });
  });

  it("throws TARGET_NOT_REACHABLE when no reconnect waiter exists", async () => {
    const { server } = createServer();

    await expect(
      (server as any).relayCall("panel-a", "panel-b", "test.method", []),
    ).rejects.toMatchObject({
      message: "Target not reachable: panel-b",
      code: "TARGET_NOT_REACHABLE",
    });
  });

  it("throws an invariant error when a reconnect waiter resolves without a client", async () => {
    const { server } = createServer();
    const deferred = createDeferred<void>();
    (server as any).reconnectWaiters.set("panel-b", { ...deferred });

    const relay = (server as any).relayCall("panel-a", "panel-b", "test.method", []);
    deferred.resolve();

    await expect(relay).rejects.toThrow(
      "Invariant violated: reconnect waiter resolved for panel-b but no client found",
    );
  });

  it("surfaces response relay failures with ws:routed-response-error", async () => {
    const { server, tokenManager } = createServer();
    const client = createClient();
    tokenManager.setPanelParent("panel-b", "panel-a");

    (server as any).handleRoute(client, "panel-b", {
      type: "response",
      requestId: "req-123",
      result: { ok: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse((client.ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toMatchObject({
      type: "ws:routed-response-error",
      targetId: "panel-b",
      requestId: "req-123",
      error: "Target not reachable: panel-b",
      errorCode: "TARGET_NOT_REACHABLE",
    });
  });
});

describe("RpcServer caller identity", () => {
  function rpcRequest(requestId: string, method: string) {
    return {
      type: "request" as const,
      requestId,
      method,
      args: [],
    };
  }

  function sentResponse(client: WsClientState) {
    const calls = (client.ws.send as ReturnType<typeof vi.fn>).mock.calls;
    const raw = calls[calls.length - 1]![0] as string;
    return JSON.parse(raw) as { message: { result?: unknown; error?: string } };
  }

  it("denies worker callers for shell-only browser-data methods", async () => {
    const { server } = createServer();
    const client = createClient("worker-1");
    client.callerKind = "worker";
    (server as any).dispatcher.getPolicy.mockReturnValue({ allowed: ["server"] });
    (server as any).dispatcher.getMethodPolicy.mockReturnValue({ allowed: ["shell"] });

    await (server as any).handleRpc(client, rpcRequest("req-3", "browser-data.getPasswords"));

    expect((server as any).dispatcher.dispatch).not.toHaveBeenCalled();
    expect(sentResponse(client).message.error).toContain("not accessible to worker callers");
  });

  it("dispatches server callers using their own server identity", async () => {
    const { server } = createServer();
    const client = createClient("server");
    client.callerKind = "server";
    const dispatched: unknown[] = [];
    (server as any).dispatcher.getPolicy.mockReturnValue({ allowed: ["server"] });
    (server as any).dispatcher.getMethodPolicy.mockReturnValue(undefined);
    (server as any).dispatcher.dispatch.mockImplementation(async (ctx: unknown) => {
      dispatched.push(ctx);
      return { ok: true };
    });

    await (server as any).handleRpc(client, rpcRequest("req-4", "internal.ping"));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      callerId: client.callerId,
      callerKind: "server",
    });
    expect(sentResponse(client).message.result).toEqual({ ok: true });
  });
});
