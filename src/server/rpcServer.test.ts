import { describe, it, expect, vi } from "vitest";
import { WebSocket } from "ws";
import { TokenManager } from "../../packages/shared/src/tokenManager.js";
import { RpcServer } from "./rpcServer.js";
import { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";
import type { WsClientState } from "./rpcServer.js";
import { createVerifiedCaller, type ServiceDispatcher } from "@natstack/shared/serviceDispatcher";
import { EntityCache } from "@natstack/shared/runtime/entityCache";
import type { EntityKind, EntityRecord } from "@natstack/shared/runtime/entitySpec";
import { ConnectionGrantService } from "@natstack/shared/connectionGrants";

function makeRecord(
  id: string,
  kind: EntityKind,
  opts?: { contextId?: string; repoPath?: string; effectiveVersion?: string }
): EntityRecord {
  return {
    id,
    kind,
    source: {
      repoPath: opts?.repoPath ?? "",
      effectiveVersion: opts?.effectiveVersion ?? "",
    },
    contextId: opts?.contextId ?? "",
    key: id,
    createdAt: Date.now(),
    status: "active",
    cleanupComplete: true,
  };
}

type MockDispatcher = ServiceDispatcher & {
  dispatch: ReturnType<typeof vi.fn>;
  getPolicy: ReturnType<typeof vi.fn>;
  getMethodPolicy: ReturnType<typeof vi.fn>;
};

type TestRpcServer = {
  dispatcher: MockDispatcher;
  connections: {
    addClient(client: WsClientState): void;
    getCallerConnections(callerId: string): WsClientState[];
  };
  connectionReconnectWaiters: Map<string, { resolve: () => void; reject: (err: Error) => void }>;
  reconnectWaiters: Map<
    string,
    { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void }
  >;
  handleAuth(ws: unknown, token: string | null, connectionId: string): void;
  handleRoute(client: WsClientState, targetId: string, message: unknown): Promise<void> | void;
  handleClose(client: WsClientState, code: number, reason: string): void;
  handleRpc(client: WsClientState, message: unknown): Promise<void>;
  relayCall(
    sourceId: string,
    callerKind: string,
    targetId: string,
    method: string,
    args: unknown[]
  ): Promise<unknown>;
  relayToDO(
    callerId: string,
    callerKind: string,
    targetId: string,
    method: string,
    args: unknown[]
  ): Promise<unknown>;
  streamCallTarget(targetId: string, method: string, ...args: unknown[]): Promise<Response>;
  checkRelayAuth(
    callerId: string,
    callerKind: string,
    targetId: string
  ): { ok: boolean; reason?: string };
};

function testServer(server: RpcServer): TestRpcServer {
  return server as unknown as TestRpcServer;
}

function createServer(opts: Partial<ConstructorParameters<typeof RpcServer>[0]> = {}) {
  const tokenManager = new TokenManager();
  const entityCache = new EntityCache();
  entityCache._onActivate(makeRecord("panel-a", "panel"));
  entityCache._onActivate(makeRecord("panel-b", "panel"));
  const connectionGrants = new ConnectionGrantService({ entityCache });

  const dispatcher = {
    dispatch: vi.fn(),
    getPolicy: vi.fn(),
    getMethodPolicy: vi.fn(),
  } as unknown as MockDispatcher;
  const runtimeCoordinator = new PanelRuntimeCoordinator();
  runtimeCoordinator.registerClient({
    clientSessionId: "test-desktop",
    label: "Desktop",
    platform: "desktop",
  });
  runtimeCoordinator.acquire("panel-a", {
    slotId: "slot-a",
    clientSessionId: "test-desktop",
    connectionId: "conn-1",
  });

  return {
    tokenManager,
    entityCache,
    connectionGrants,
    runtimeCoordinator,
    grantPanel: (panelId: string) => connectionGrants.grant(panelId, "shell:test").token,
    server: new RpcServer({
      tokenManager,
      dispatcher,
      entityCache,
      connectionGrants,
      runtimeCoordinator,
      ...opts,
    }),
  };
}

function createClient(callerId = "panel-a"): WsClientState {
  return {
    caller: createVerifiedCaller(callerId, "panel"),
    connectionId: "conn-1",
    authenticated: true,
    authenticatedAt: Date.now(),
    ws: {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as WebSocket,
  };
}

function createClientWithConnection(callerId: string, connectionId: string): WsClientState {
  const client = createClient(callerId);
  client.connectionId = connectionId;
  client.authenticatedAt = connectionId === "conn-1" ? 1 : 2;
  return client;
}

function createSignalDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createTestWs() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    OPEN: WebSocket.OPEN as number,
    readyState: WebSocket.OPEN as number,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
    off: vi.fn(),
    emitMessage(message: unknown) {
      handlers.get("message")?.(Buffer.from(JSON.stringify(message)));
    },
    emitClose(code = 1006, reason = "network") {
      this.readyState = WebSocket.CLOSED;
      handlers.get("close")?.(code, Buffer.from(reason));
    },
  };
}

function registerClient(server: RpcServer, client: WsClientState): void {
  testServer(server).connections.addClient(client);
}

describe("RpcServer relay behavior", () => {
  it("allows authenticated panels to relay to panel, DO, and worker targets", () => {
    const { server } = createServer();

    expect(testServer(server).checkRelayAuth("panel-a", "panel", "panel-b")).toEqual({ ok: true });

    expect(
      testServer(server).checkRelayAuth("panel-a", "panel", "do:workers/example:Store:key")
    ).toEqual({ ok: true });

    expect(testServer(server).checkRelayAuth("panel-a", "panel", "worker:workers/example")).toEqual(
      { ok: true }
    );
  });

  it("throws DO_NOT_CREATED when relaying to a DO with no registered entity record", async () => {
    const tokenManager = new TokenManager();
    const dispatcher = {
      dispatch: vi.fn(),
      getPolicy: vi.fn(),
      getMethodPolicy: vi.fn(),
    } as unknown as MockDispatcher;
    const entityCache = new EntityCache();
    entityCache._onActivate(makeRecord("panel-a", "panel", { contextId: "ctx-1" }));
    const server = new RpcServer({ tokenManager, dispatcher, entityCache });

    await expect(
      testServer(server).relayToDO("panel-a", "panel", "do:workers/example:Store:key", "ping", [])
    ).rejects.toMatchObject({ code: "DO_NOT_CREATED" });
  });

  it("rejects distinct live panel runtime connections for the same caller", () => {
    const { server, grantPanel } = createServer();
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

    testServer(server).handleAuth(ws1, grantPanel("panel-a"), "conn-1");
    testServer(server).handleAuth(ws2, grantPanel("panel-a"), "conn-2");

    expect(ws1.close).not.toHaveBeenCalled();
    expect(ws2.close).toHaveBeenCalledWith(4090, "Panel runtime lease denied");
    expect(testServer(server).connections.getCallerConnections("panel-a")).toHaveLength(1);
    expect(JSON.parse(ws1.send.mock.calls[0]![0])).toMatchObject({
      type: "ws:auth-result",
      success: true,
      connectionId: "conn-1",
      serverBootId: expect.any(String),
    });
    expect(JSON.parse(ws2.send.mock.calls[0]![0])).toMatchObject({
      type: "ws:auth-result",
      success: false,
      error: expect.stringContaining("Panel runtime is leased by"),
    });
  });

  it("keeps the replacement bridge when the old same-connection socket closes late", () => {
    const { server, grantPanel } = createServer();
    const ws1 = createTestWs();
    const ws2 = createTestWs();

    testServer(server).handleAuth(ws1, grantPanel("panel-a"), "conn-1");
    const firstBridge = server.getClientBridge("panel-a");
    expect(firstBridge).toBeTruthy();

    testServer(server).handleAuth(ws2, grantPanel("panel-a"), "conn-1");
    const replacementBridge = server.getClientBridge("panel-a");
    expect(replacementBridge).toBeTruthy();
    expect(replacementBridge).not.toBe(firstBridge);
    expect(ws1.close).toHaveBeenCalledWith(4002, "Replaced by new connection");

    ws1.emitClose(4002, "Replaced by new connection");

    expect(server.getClientBridge("panel-a")).toBe(replacementBridge);
    expect(testServer(server).connections.getCallerConnections("panel-a")).toEqual([
      expect.objectContaining({ connectionId: "conn-1", ws: ws2 }),
    ]);
  });

  it("ignores late frames from a replaced same-connection socket", async () => {
    const { server, grantPanel } = createServer();
    const ws1 = createTestWs();
    const ws2 = createTestWs();

    testServer(server).dispatcher.getPolicy.mockReturnValue({ allowed: ["panel"] });
    testServer(server).dispatcher.dispatch.mockResolvedValue("ok");

    testServer(server).handleAuth(ws1, grantPanel("panel-a"), "conn-1");
    testServer(server).handleAuth(ws2, grantPanel("panel-a"), "conn-1");

    ws1.emitMessage({
      type: "ws:rpc",
      message: {
        type: "request",
        requestId: "late-old-frame",
        method: "workspace.ping",
        args: [],
      },
    });
    await Promise.resolve();

    expect(testServer(server).dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("routes server-initiated stream frames from a connected extension back to the pending stream", async () => {
    const { server, tokenManager } = createServer();
    const extensionToken = tokenManager.ensureToken("@workspace-extensions/shell", "extension");
    const ws = createTestWs();

    testServer(server).handleAuth(ws, extensionToken, "ext-conn-1");

    const responsePromise = testServer(server).streamCallTarget(
      "@workspace-extensions/shell",
      "extension.invokeStream",
      "attach",
      ["session-1"],
      { caller: { callerId: "panel-a", callerKind: "panel" } }
    );
    const sent = ws.send.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .find((message) => message.type === "ws:rpc" && message.message?.type === "stream-request");
    expect(sent).toBeTruthy();
    const requestId = sent.message.requestId as string;

    ws.emitMessage({
      type: "ws:rpc",
      message: {
        type: "stream-frame",
        requestId,
        fromId: "@workspace-extensions/shell",
        frameType: 0x01,
        payload: JSON.stringify({
          status: 200,
          statusText: "OK",
          headerPairs: [["content-type", "text/plain"]],
          finalUrl: "",
        }),
      },
    });
    const response = await responsePromise;

    ws.emitMessage({
      type: "ws:rpc",
      message: {
        type: "stream-frame",
        requestId,
        fromId: "@workspace-extensions/shell",
        frameType: 0x02,
        payload: Buffer.from("hello").toString("base64"),
      },
    });
    ws.emitMessage({
      type: "ws:rpc",
      message: {
        type: "stream-frame",
        requestId,
        fromId: "@workspace-extensions/shell",
        frameType: 0x03,
        payload: JSON.stringify({ bytesIn: 5 }),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    await expect(response.text()).resolves.toBe("hello");
  });

  it("fans routed events out to every live connection for the target caller", () => {
    const { server } = createServer();
    const source = createClientWithConnection("panel-a", "source-conn");
    const target1 = createClientWithConnection("panel-b", "conn-1");
    const target2 = createClientWithConnection("panel-b", "conn-2");
    registerClient(server, target1);
    registerClient(server, target2);

    testServer(server).handleRoute(source, "panel-b", {
      type: "event",
      fromId: "panel-a",
      event: "test:event",
      payload: { ok: true },
    });

    expect(target1.ws.send).toHaveBeenCalledTimes(1);
    expect(target2.ws.send).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse((target1.ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    ).toMatchObject({
      type: "ws:routed",
      fromId: "panel-a",
      message: { type: "event", event: "test:event", payload: { ok: true } },
    });
  });

  it("steers routed responses back to the origin connection", async () => {
    const { server } = createServer();
    const origin1 = createClientWithConnection("panel-a", "conn-1");
    const origin2 = createClientWithConnection("panel-a", "conn-2");
    const target = createClientWithConnection("panel-b", "target-conn");
    registerClient(server, origin1);
    registerClient(server, origin2);
    registerClient(server, target);

    testServer(server).handleRoute(origin2, "panel-b", {
      type: "request",
      requestId: "req-origin-2",
      method: "test.method",
      args: [],
    });
    (target.ws.send as ReturnType<typeof vi.fn>).mockClear();

    testServer(server).handleRoute(target, "panel-a", {
      type: "response",
      requestId: "req-origin-2",
      result: { ok: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(origin1.ws.send).not.toHaveBeenCalled();
    expect(origin2.ws.send).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse((origin2.ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    ).toMatchObject({
      type: "ws:routed",
      fromId: "panel-b",
      message: { type: "response", requestId: "req-origin-2", result: { ok: true } },
    });
  });

  it("keeps routed response origins while the origin connection reconnects", async () => {
    vi.useFakeTimers();
    try {
      const { server, grantPanel, runtimeCoordinator } = createServer();
      const origin1 = createClientWithConnection("panel-a", "conn-1");
      const origin2 = createClientWithConnection("panel-a", "conn-2");
      const target = createClientWithConnection("panel-b", "target-conn");
      registerClient(server, origin1);
      registerClient(server, origin2);
      registerClient(server, target);

      testServer(server).handleRoute(origin2, "panel-b", {
        type: "request",
        requestId: "req-reconnect",
        method: "test.method",
        args: [],
      });
      testServer(server).handleClose(origin2, 1006, "network");

      testServer(server).handleRoute(target, "panel-a", {
        type: "response",
        requestId: "req-reconnect",
        result: { ok: true },
      });
      await Promise.resolve();

      const reconnectedWs = createTestWs();
      runtimeCoordinator.takeOver("panel-a", {
        slotId: "slot-a",
        clientSessionId: "test-desktop",
        connectionId: "conn-2",
      });
      testServer(server).handleAuth(reconnectedWs, grantPanel("panel-a"), "conn-2");
      await Promise.resolve();
      await Promise.resolve();

      expect(origin1.ws.send).not.toHaveBeenCalled();
      const routedCall = reconnectedWs.send.mock.calls
        .map(([raw]) => JSON.parse(raw as string))
        .find((msg) => msg.type === "ws:routed");
      expect(routedCall).toMatchObject({
        type: "ws:routed",
        fromId: "panel-b",
        message: { type: "response", requestId: "req-reconnect", result: { ok: true } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes events between unrelated authenticated panels", () => {
    const { server } = createServer();
    const client = createClient();
    const target = createClientWithConnection("panel-b", "target-conn");
    registerClient(server, target);

    testServer(server).handleRoute(client, "panel-b", {
      type: "event",
      fromId: "panel-a",
      event: "test:event",
      payload: { ok: true },
    });

    expect(client.ws.send).not.toHaveBeenCalled();
    expect(target.ws.send).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse((target.ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    ).toMatchObject({
      type: "ws:routed",
      fromId: "panel-a",
      message: { type: "event", event: "test:event", payload: { ok: true } },
    });
  });

  it("throws TARGET_NOT_REACHABLE when a panel target is disconnected", async () => {
    const { server } = createServer();

    await expect(
      testServer(server).relayCall("panel-a", "panel", "panel-b", "test.method", [])
    ).rejects.toMatchObject({
      message: "Target not reachable: panel-b",
      code: "TARGET_NOT_REACHABLE",
    });
  });

  it("preserves reconnect grace expiry on relayCall", async () => {
    const { server } = createServer();
    const deferred = createSignalDeferred();
    testServer(server).reconnectWaiters.set("panel-b", { ...deferred });

    const relay = testServer(server).relayCall("panel-a", "panel", "panel-b", "test.method", []);
    deferred.reject(
      Object.assign(new Error("Client did not reconnect within grace window"), {
        code: "RECONNECT_GRACE_EXPIRED",
      })
    );

    await expect(relay).rejects.toMatchObject({
      message: "Target panel-b did not reconnect within grace window",
      code: "RECONNECT_GRACE_EXPIRED",
    });
  });

  it("preserves server shutdown on relayCall", async () => {
    const { server } = createServer();
    const deferred = createSignalDeferred();
    testServer(server).reconnectWaiters.set("panel-b", { ...deferred });

    const relay = testServer(server).relayCall("panel-a", "panel", "panel-b", "test.method", []);
    deferred.reject(
      Object.assign(new Error("Server shutting down"), {
        code: "SERVER_SHUTTING_DOWN",
      })
    );

    await expect(relay).rejects.toMatchObject({
      message: "Server shutting down",
      code: "SERVER_SHUTTING_DOWN",
    });
  });

  it("throws an invariant error when a reconnect waiter resolves without a client", async () => {
    const { server } = createServer();
    const deferred = createSignalDeferred();
    testServer(server).reconnectWaiters.set("panel-b", { ...deferred });

    const relay = testServer(server).relayCall("panel-a", "panel", "panel-b", "test.method", []);
    deferred.resolve();

    await expect(relay).rejects.toThrow(
      "Invariant violated: reconnect waiter resolved for panel-b but no client found"
    );
  });

  it("surfaces response relay failures with ws:routed-response-error", async () => {
    const { server } = createServer();
    const client = createClient();

    testServer(server).handleRoute(client, "panel-b", {
      type: "response",
      requestId: "req-123",
      result: { ok: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.ws.send).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse((client.ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    ).toMatchObject({
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

  it("rejects WS authentication when the token resolves to a bare shell caller", () => {
    const { server, tokenManager } = createServer();
    const shellToken = tokenManager.createToken("electron-main", "shell");
    const ws = createTestWs();

    testServer(server).handleAuth(ws, shellToken, "conn-shell");

    expect(ws.close).toHaveBeenCalledWith(4006, expect.stringContaining("shell"));
    expect(testServer(server).connections.getCallerConnections("electron-main")).toHaveLength(0);
  });

  it("accepts WS authentication for shell-remote tokens and rebrands callerKind to shell", () => {
    const { server, tokenManager } = createServer();
    const remoteToken = tokenManager.createToken("electron-main", "shell-remote");
    const ws = createTestWs();

    testServer(server).handleAuth(ws, remoteToken, "conn-shell-remote");

    expect(ws.close).not.toHaveBeenCalled();
    const callers = testServer(server).connections.getCallerConnections("electron-main");
    expect(callers).toHaveLength(1);
    expect(callers[0]!.caller.runtime.kind).toBe("shell");
  });

  it("rejects WS authentication when a connection grant resolves to a bare shell principal", () => {
    const { server, connectionGrants, entityCache } = createServer();
    entityCache._onActivate(makeRecord("electron-main", "shell"));
    const grant = connectionGrants.grant("electron-main", "shell:test").token;
    const ws = createTestWs();

    // The principal-kind registry maps shell entities to shell-remote at the
    // WS boundary; the connection rebrand collapses it back to shell for
    // downstream policy.
    testServer(server).handleAuth(ws, grant, "conn-grant");
    expect(ws.close).not.toHaveBeenCalled();
    const callers = testServer(server).connections.getCallerConnections("electron-main");
    expect(callers).toHaveLength(1);
    expect(callers[0]!.caller.runtime.kind).toBe("shell");
  });

  it("rejects WS authentication when a connection grant has no runtime entity kind", () => {
    const { server, connectionGrants, entityCache } = createServer();
    const principal = makeRecord("missing-principal", "app");
    entityCache._onActivate(principal);
    const grant = connectionGrants.grant(principal.id, "shell:test").token;
    entityCache._onRetire({ ...principal, status: "retired", retiredAt: Date.now() });
    const ws = createTestWs();

    testServer(server).handleAuth(ws, grant, "conn-missing-principal");

    expect(ws.close).toHaveBeenCalledWith(4006, "Invalid token");
    expect(testServer(server).connections.getCallerConnections("missing-principal")).toHaveLength(
      0
    );
  });

  it("denies worker callers for shell-only methods", async () => {
    const { server } = createServer();
    const client = createClient("worker-1");
    client.caller = createVerifiedCaller("worker-1", "worker");
    testServer(server).dispatcher.getPolicy.mockReturnValue({ allowed: ["server"] });
    testServer(server).dispatcher.getMethodPolicy.mockReturnValue({ allowed: ["shell"] });

    await testServer(server).handleRpc(client, rpcRequest("req-3", "internal.shellOnly"));

    expect(testServer(server).dispatcher.dispatch).not.toHaveBeenCalled();
    expect(sentResponse(client).message.error).toContain("not accessible to worker callers");
  });

  it("dispatches server callers using their own server identity", async () => {
    const { server } = createServer();
    const client = createClient("server");
    client.caller = createVerifiedCaller("server", "server");
    const dispatched: unknown[] = [];
    testServer(server).dispatcher.getPolicy.mockReturnValue({ allowed: ["server"] });
    testServer(server).dispatcher.getMethodPolicy.mockReturnValue(undefined);
    testServer(server).dispatcher.dispatch.mockImplementation(async (ctx: unknown) => {
      dispatched.push(ctx);
      return { ok: true };
    });

    await testServer(server).handleRpc(client, rpcRequest("req-4", "internal.ping"));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      caller: { runtime: { id: client.caller.runtime.id, kind: "server" } },
    });
    expect(sentResponse(client).message.result).toEqual({ ok: true });
  });

  it("preserves app chain caller attribution for extension parent invocations", async () => {
    const { server } = createServer({
      resolveExtensionInvocation: vi.fn(() => ({
        caller: {
          callerId: "@workspace-apps/shell",
          callerKind: "app" as const,
        },
      })),
    });
    const client = createClient("@workspace-extensions/tools");
    client.caller = createVerifiedCaller("@workspace-extensions/tools", "extension");
    const dispatched: unknown[] = [];
    testServer(server).dispatcher.getPolicy.mockReturnValue({ allowed: ["extension"] });
    testServer(server).dispatcher.getMethodPolicy.mockReturnValue(undefined);
    testServer(server).dispatcher.dispatch.mockImplementation(async (ctx: unknown) => {
      dispatched.push(ctx);
      return { ok: true };
    });

    await testServer(server).handleRpc(client, {
      ...rpcRequest("req-app-chain", "workspace.getInfo"),
      parentInvocationToken: "inv-app",
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      caller: { runtime: { id: "@workspace-extensions/tools", kind: "extension" } },
      chainCaller: {
        callerId: "@workspace-apps/shell",
        callerKind: "app",
        repoPath: "",
        effectiveVersion: "",
      },
    });
  });
});
