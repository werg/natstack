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
    callerKind: "panel",
    authenticated: true,
    ws: {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as any,
  };
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
