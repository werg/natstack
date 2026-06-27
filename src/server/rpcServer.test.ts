import { afterEach, describe, it, expect, vi } from "vitest";
import { WebSocket } from "ws";
import { TokenManager } from "../../packages/shared/src/tokenManager.js";
import { RpcServer } from "./rpcServer.js";
import { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";
import type { WsClientState } from "./rpcServer.js";
import { createVerifiedCaller, type ServiceDispatcher } from "@natstack/shared/serviceDispatcher";
import { EntityCache } from "@natstack/shared/runtime/entityCache";
import type { EntityKind, EntityRecord } from "@natstack/shared/runtime/entitySpec";
import { ConnectionGrantService } from "@natstack/shared/connectionGrants";
import { envelopeFromMessage, type RpcEnvelope, type RpcMessage } from "@natstack/rpc";

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
  handleRoute(
    client: WsClientState,
    targetId: string,
    message: RpcMessage,
    targetConnectionId: string | undefined,
    routeEnvelope: RpcEnvelope
  ): Promise<void> | void;
  handleClose(client: WsClientState, code: number, reason: string): void;
  handleRpc(client: WsClientState, message: RpcMessage, envelope: RpcEnvelope): Promise<void>;
  relayCall(
    sourceId: string,
    callerKind: string,
    targetId: string,
    method: string,
    args: unknown[],
    targetConnectionId?: string,
    meta?: { requestId?: string; idempotencyKey?: string; readOnly?: boolean }
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
  entityCache._onActivate(makeRecord("panel:nav-a", "panel"));
  entityCache._onActivate(makeRecord("panel:nav-b", "panel"));
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
  runtimeCoordinator.acquire("panel:nav-a", {
    slotId: "panel:tree/slot-a",
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

function createClient(callerId = "panel:nav-a"): WsClientState {
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

afterEach(() => {
  vi.unstubAllGlobals();
});

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

function makeEnvelope(
  from: string,
  target: string,
  callerKind: RpcEnvelope["delivery"]["caller"]["callerKind"],
  message: RpcMessage
): RpcEnvelope {
  return envelopeFromMessage({
    selfId: from,
    from,
    target,
    callerKind,
    message,
  });
}

function clientEnvelope(client: WsClientState, targetId: string, message: RpcMessage): RpcEnvelope {
  return makeEnvelope(client.caller.runtime.id, targetId, client.caller.runtime.kind, message);
}

function handleRoute(
  server: RpcServer,
  client: WsClientState,
  targetId: string,
  message: RpcMessage,
  targetConnectionId?: string
): Promise<void> | void {
  return testServer(server).handleRoute(
    client,
    targetId,
    message,
    targetConnectionId,
    clientEnvelope(client, targetId, message)
  );
}

function handleRpc(server: RpcServer, client: WsClientState, message: RpcMessage): Promise<void> {
  return testServer(server).handleRpc(client, message, clientEnvelope(client, "main", message));
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

    expect(testServer(server).checkRelayAuth("panel:nav-a", "panel", "panel:nav-b")).toEqual({
      ok: true,
    });

    expect(
      testServer(server).checkRelayAuth("panel:nav-a", "panel", "do:workers/example:Store:key")
    ).toEqual({ ok: true });

    expect(
      testServer(server).checkRelayAuth("panel:nav-a", "panel", "worker:workers/example")
    ).toEqual({ ok: true });
  });

  it("throws DO_NOT_CREATED when relaying to a DO with no registered entity record", async () => {
    const tokenManager = new TokenManager();
    const dispatcher = {
      dispatch: vi.fn(),
      getPolicy: vi.fn(),
      getMethodPolicy: vi.fn(),
    } as unknown as MockDispatcher;
    const entityCache = new EntityCache();
    entityCache._onActivate(makeRecord("panel:nav-a", "panel", { contextId: "ctx-1" }));
    const server = new RpcServer({ tokenManager, dispatcher, entityCache });

    await expect(
      testServer(server).relayToDO(
        "panel:nav-a",
        "panel",
        "do:workers/example:Store:key",
        "ping",
        []
      )
    ).rejects.toMatchObject({ code: "DO_NOT_CREATED" });
  });

  it("refreshes workerd connection details after ensureDO before retrying DO relay", async () => {
    const { server, entityCache } = createServer();
    const targetId = "do:workers/example:Store:key";
    entityCache._onActivate(makeRecord(targetId, "do"));
    server.setWorkerdUrl("http://127.0.0.1:1111");
    server.setWorkerdGatewayToken("gateway-token");

    const fetchError = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(fetchError)
      .mockResolvedValueOnce(
        // Envelope-native: the DO replies with a response envelope; relayToDO unwraps result.
        new Response(
          JSON.stringify({
            from: "do",
            target: "main",
            delivery: { caller: { callerId: "do", callerKind: "do" } },
            provenance: [],
            message: { type: "response", requestId: "x", result: { ok: true } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    server.setEnsureDO(
      vi.fn(async () => {
        server.setWorkerdUrl("http://127.0.0.1:2222");
      })
    );

    await expect(
      testServer(server).relayToDO("panel:nav-a", "panel", targetId, "ping", [])
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/^http:\/\/127\.0\.0\.1:1111\//);
    expect(fetchMock.mock.calls[1]?.[0]).toMatch(/^http:\/\/127\.0\.0\.1:2222\//);
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

    testServer(server).handleAuth(ws1, grantPanel("panel:nav-a"), "conn-1");
    testServer(server).handleAuth(ws2, grantPanel("panel:nav-a"), "conn-2");

    expect(ws1.close).not.toHaveBeenCalled();
    expect(ws2.close).toHaveBeenCalledWith(4090, "Panel runtime lease denied");
    expect(testServer(server).connections.getCallerConnections("panel:nav-a")).toHaveLength(1);
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

  it("keeps the replacement bridge and lease when the old same-connection socket closes late", () => {
    const { server, grantPanel, runtimeCoordinator } = createServer();
    const ws1 = createTestWs();
    const ws2 = createTestWs();

    testServer(server).handleAuth(ws1, grantPanel("panel:nav-a"), "conn-1");
    const firstBridge = server.getClientBridge("panel:nav-a");
    expect(firstBridge).toBeTruthy();

    testServer(server).handleAuth(ws2, grantPanel("panel:nav-a"), "conn-1");
    const replacementBridge = server.getClientBridge("panel:nav-a");
    expect(replacementBridge).toBeTruthy();
    expect(replacementBridge).not.toBe(firstBridge);
    expect(ws1.close).toHaveBeenCalledWith(4002, "Replaced by new connection");

    ws1.emitClose(4002, "Replaced by new connection");

    expect(server.getClientBridge("panel:nav-a")).toBe(replacementBridge);
    expect(testServer(server).connections.getCallerConnections("panel:nav-a")).toEqual([
      expect.objectContaining({ connectionId: "conn-1", ws: ws2 }),
    ]);
    expect(runtimeCoordinator.getLease("panel:nav-a")).toEqual(
      expect.objectContaining({ connectionId: "conn-1" })
    );
    expect(runtimeCoordinator.getLease("panel:nav-a")).not.toHaveProperty("expiresAt");
  });

  it("ignores late frames from a replaced same-connection socket", async () => {
    const { server, grantPanel } = createServer();
    const ws1 = createTestWs();
    const ws2 = createTestWs();

    testServer(server).dispatcher.getPolicy.mockReturnValue({ allowed: ["panel"] });
    testServer(server).dispatcher.dispatch.mockResolvedValue("ok");

    testServer(server).handleAuth(ws1, grantPanel("panel:nav-a"), "conn-1");
    testServer(server).handleAuth(ws2, grantPanel("panel:nav-a"), "conn-1");

    const lateMessage: RpcMessage = {
      type: "request",
      requestId: "late-old-frame",
      fromId: "panel:nav-a",
      method: "workspace.ping",
      args: [],
    };
    ws1.emitMessage({
      type: "ws:rpc",
      envelope: makeEnvelope("panel:nav-a", "main", "panel", lateMessage),
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
      { caller: { callerId: "panel:nav-a", callerKind: "panel" } }
    );
    const sent = ws.send.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .find(
        (message) =>
          message.type === "ws:rpc" && message.envelope?.message?.type === "stream-request"
      );
    expect(sent).toBeTruthy();
    const requestId = sent.envelope.message.requestId as string;

    const headFrame: RpcMessage = {
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
    };
    ws.emitMessage({
      type: "ws:rpc",
      envelope: makeEnvelope("@workspace-extensions/shell", "server", "extension", headFrame),
    });
    const response = await responsePromise;

    const chunkFrame: RpcMessage = {
      type: "stream-frame",
      requestId,
      fromId: "@workspace-extensions/shell",
      frameType: 0x02,
      payload: Buffer.from("hello").toString("base64"),
    };
    ws.emitMessage({
      type: "ws:rpc",
      envelope: makeEnvelope("@workspace-extensions/shell", "server", "extension", chunkFrame),
    });
    const endFrame: RpcMessage = {
      type: "stream-frame",
      requestId,
      fromId: "@workspace-extensions/shell",
      frameType: 0x03,
      payload: JSON.stringify({ bytesIn: 5 }),
    };
    ws.emitMessage({
      type: "ws:rpc",
      envelope: makeEnvelope("@workspace-extensions/shell", "server", "extension", endFrame),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    await expect(response.text()).resolves.toBe("hello");
  });

  it("rejects server bridge calls when a client routes a response to server", async () => {
    const { server, tokenManager } = createServer();
    const extensionId = "@workspace-extensions/process-test";
    const extensionToken = tokenManager.ensureToken(extensionId, "extension");
    const ws = createTestWs();

    testServer(server).handleAuth(ws, extensionToken, "ext-conn-1");
    const bridge = server.getClientBridge(extensionId);
    expect(bridge).toBeTruthy();

    const call = bridge!.call(extensionId, "extension.invoke", ["ping", []]);
    await Promise.resolve();

    const sent = ws.send.mock.calls
      .map(([raw]) => JSON.parse(raw as string))
      .find(
        (message) => message.type === "ws:rpc" && message.envelope?.message?.type === "request"
      );
    expect(sent).toBeTruthy();
    const requestId = sent.envelope.message.requestId as string;

    ws.emitMessage({
      type: "ws:route",
      envelope: {
        from: extensionId,
        target: "server",
        delivery: { caller: { callerId: extensionId, callerKind: "extension" } },
        provenance: [{ callerId: extensionId, callerKind: "extension" }],
        message: {
          type: "response",
          requestId,
          result: "pong",
        },
      },
    });

    await expect(call).rejects.toMatchObject({
      message: expect.stringContaining("was sent via ws:route"),
      code: "RPC_PROTOCOL_ERROR",
    });

    const routedError = ws.send.mock.calls
      .map(([raw]) => JSON.parse(raw as string))
      .find((message) => message.type === "ws:routed-response-error");
    expect(routedError).toMatchObject({
      type: "ws:routed-response-error",
      targetId: "server",
      requestId,
      error: expect.stringContaining("was sent via ws:route"),
      errorCode: "RPC_PROTOCOL_ERROR",
    });
  });

  it("fans routed events out to every live connection for the target caller", () => {
    const { server } = createServer();
    const source = createClientWithConnection("panel:nav-a", "source-conn");
    const target1 = createClientWithConnection("panel:nav-b", "conn-1");
    const target2 = createClientWithConnection("panel:nav-b", "conn-2");
    registerClient(server, target1);
    registerClient(server, target2);

    handleRoute(server, source, "panel:nav-b", {
      type: "event",
      fromId: "panel:nav-a",
      event: "test:event",
      payload: { ok: true },
    });

    expect(target1.ws.send).toHaveBeenCalledTimes(1);
    expect(target2.ws.send).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse((target1.ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    ).toMatchObject({
      type: "ws:routed",
      envelope: {
        from: "panel:nav-a",
        message: { type: "event", event: "test:event", payload: { ok: true } },
      },
    });
  });

  it("steers routed responses back to the origin connection", async () => {
    const { server } = createServer();
    const origin1 = createClientWithConnection("panel:nav-a", "conn-1");
    const origin2 = createClientWithConnection("panel:nav-a", "conn-2");
    const target = createClientWithConnection("panel:nav-b", "target-conn");
    registerClient(server, origin1);
    registerClient(server, origin2);
    registerClient(server, target);

    handleRoute(server, origin2, "panel:nav-b", {
      type: "request",
      requestId: "req-origin-2",
      fromId: "panel:nav-a",
      method: "test.method",
      args: [],
    });
    (target.ws.send as ReturnType<typeof vi.fn>).mockClear();

    handleRoute(server, target, "panel:nav-a", {
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
      envelope: {
        from: "panel:nav-b",
        message: { type: "response", requestId: "req-origin-2", result: { ok: true } },
      },
    });
  });

  it("keeps routed response origins while the origin connection reconnects", async () => {
    vi.useFakeTimers();
    try {
      const { server, grantPanel, runtimeCoordinator } = createServer();
      const origin1 = createClientWithConnection("panel:nav-a", "conn-1");
      const origin2 = createClientWithConnection("panel:nav-a", "conn-2");
      const target = createClientWithConnection("panel:nav-b", "target-conn");
      registerClient(server, origin1);
      registerClient(server, origin2);
      registerClient(server, target);

      handleRoute(server, origin2, "panel:nav-b", {
        type: "request",
        requestId: "req-reconnect",
        fromId: "panel:nav-a",
        method: "test.method",
        args: [],
      });
      testServer(server).handleClose(origin2, 1006, "network");

      handleRoute(server, target, "panel:nav-a", {
        type: "response",
        requestId: "req-reconnect",
        result: { ok: true },
      });
      await Promise.resolve();

      const reconnectedWs = createTestWs();
      runtimeCoordinator.takeOver("panel:nav-a", {
        slotId: "panel:tree/slot-a",
        clientSessionId: "test-desktop",
        connectionId: "conn-2",
      });
      testServer(server).handleAuth(reconnectedWs, grantPanel("panel:nav-a"), "conn-2");
      await Promise.resolve();
      await Promise.resolve();

      expect(origin1.ws.send).not.toHaveBeenCalled();
      const routedCall = reconnectedWs.send.mock.calls
        .map(([raw]) => JSON.parse(raw as string))
        .find((msg) => msg.type === "ws:routed");
      expect(routedCall).toMatchObject({
        type: "ws:routed",
        envelope: {
          from: "panel:nav-b",
          message: { type: "response", requestId: "req-reconnect", result: { ok: true } },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes events between unrelated authenticated panels", () => {
    const { server } = createServer();
    const client = createClient();
    const target = createClientWithConnection("panel:nav-b", "target-conn");
    registerClient(server, target);

    handleRoute(server, client, "panel:nav-b", {
      type: "event",
      fromId: "panel:nav-a",
      event: "test:event",
      payload: { ok: true },
    });

    expect(client.ws.send).not.toHaveBeenCalled();
    expect(target.ws.send).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse((target.ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    ).toMatchObject({
      type: "ws:routed",
      envelope: {
        from: "panel:nav-a",
        message: { type: "event", event: "test:event", payload: { ok: true } },
      },
    });
  });

  it("delivers a routed event to a connectionless DO target via postToDO (no silent drop)", async () => {
    const { server } = createServer();
    server.setWorkerdUrl("http://127.0.0.1:1111");
    server.setWorkerdGatewayToken("gateway-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // A connectionless DO participant (e.g. an EvalDO subscribed to a channel via
    // connectViaRpc) holds NO ws connection. Pre-fix, this event was silently dropped
    // (getCallerConnections empty → the WS loop no-ops), hanging the subscriber.
    handleRoute(server, createClient(), "do:natstack/internal:EvalDO:k", {
      type: "event",
      fromId: "panel:nav-a",
      event: "channel:message",
      payload: { hello: "world" },
    });

    // Fire-and-forget HTTP delivery — assert the postToDO actually happened.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("EvalDO");
    const body = String((init as RequestInit | undefined)?.body ?? "");
    expect(body).toContain("channel:message");
    expect(body).toContain("world");
  });

  it("routes stable panel slot events to the current runtime entity connection", () => {
    const { server, runtimeCoordinator } = createServer();
    runtimeCoordinator.acquire("panel:nav-b", {
      slotId: "panel:tree/slot-b",
      clientSessionId: "test-desktop",
      connectionId: "target-conn",
    });
    const client = createClient();
    const target = createClientWithConnection("panel:nav-b", "target-conn");
    registerClient(server, target);

    handleRoute(server, client, "panel:tree/slot-b", {
      type: "event",
      fromId: "panel:nav-a",
      event: "test:event",
      payload: { ok: true },
    });

    expect(target.ws.send).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse((target.ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    ).toMatchObject({
      type: "ws:routed",
      envelope: {
        from: "panel:nav-a",
        message: { type: "event", event: "test:event", payload: { ok: true } },
      },
    });
  });

  it("routes stable panel slot RPC calls to the current runtime entity bridge", async () => {
    const { server, grantPanel, runtimeCoordinator } = createServer();
    runtimeCoordinator.acquire("panel:nav-b", {
      slotId: "panel:tree/slot-b",
      clientSessionId: "test-desktop",
      connectionId: "target-conn",
    });
    const targetWs = createTestWs();
    testServer(server).handleAuth(targetWs, grantPanel("panel:nav-b"), "target-conn");

    const relay = testServer(server).relayCall(
      "do:channel",
      "do",
      "panel:tree/slot-b",
      "onMethodCall",
      ["channel-1", "call-1", "eval", { code: "1 + 1" }],
      undefined,
      { idempotencyKey: "idem-1", readOnly: true }
    );

    const sent = targetWs.send.mock.calls
      .map(([raw]) => JSON.parse(raw as string))
      .find(
        (message) => message.type === "ws:rpc" && message.envelope?.message?.type === "request"
      ) as { envelope: RpcEnvelope } | undefined;
    expect(sent).toMatchObject({
      type: "ws:rpc",
      envelope: {
        delivery: { idempotencyKey: "idem-1", readOnly: true },
        message: { method: "onMethodCall" },
      },
    });
    expect(sent).not.toHaveProperty("message");
    expect(sent?.envelope.message).not.toHaveProperty("idempotencyKey");
    expect(sent?.envelope.message).not.toHaveProperty("readOnly");
    expect(sent).toBeTruthy();

    const responseMessage: RpcMessage = {
      type: "response",
      requestId: sent!.envelope.message.type === "request" ? sent!.envelope.message.requestId : "",
      result: { ok: true },
    };
    targetWs.emitMessage({
      type: "ws:rpc",
      envelope: makeEnvelope("panel:nav-b", "server", "panel", responseMessage),
    });

    await expect(relay).resolves.toEqual({ ok: true });
  });

  it("throws TARGET_NOT_REACHABLE when a panel target is disconnected", async () => {
    const { server } = createServer();

    await expect(
      testServer(server).relayCall("panel:nav-a", "panel", "panel:nav-b", "test.method", [])
    ).rejects.toMatchObject({
      message: "Target not reachable: panel:nav-b",
      code: "TARGET_NOT_REACHABLE",
    });
  });

  it("preserves reconnect grace expiry on relayCall", async () => {
    const { server } = createServer();
    const deferred = createSignalDeferred();
    testServer(server).reconnectWaiters.set("panel:nav-b", { ...deferred });

    const relay = testServer(server).relayCall(
      "panel:nav-a",
      "panel",
      "panel:nav-b",
      "test.method",
      []
    );
    deferred.reject(
      Object.assign(new Error("Client did not reconnect within grace window"), {
        code: "RECONNECT_GRACE_EXPIRED",
      })
    );

    await expect(relay).rejects.toMatchObject({
      message: "Target panel:nav-b did not reconnect within grace window",
      code: "RECONNECT_GRACE_EXPIRED",
    });
  });

  it("preserves server shutdown on relayCall", async () => {
    const { server } = createServer();
    const deferred = createSignalDeferred();
    testServer(server).reconnectWaiters.set("panel:nav-b", { ...deferred });

    const relay = testServer(server).relayCall(
      "panel:nav-a",
      "panel",
      "panel:nav-b",
      "test.method",
      []
    );
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
    testServer(server).reconnectWaiters.set("panel:nav-b", { ...deferred });

    const relay = testServer(server).relayCall(
      "panel:nav-a",
      "panel",
      "panel:nav-b",
      "test.method",
      []
    );
    deferred.resolve();

    await expect(relay).rejects.toThrow(
      "Invariant violated: reconnect waiter resolved for panel:nav-b but no client found"
    );
  });

  it("surfaces response relay failures with ws:routed-response-error", async () => {
    const { server } = createServer();
    const client = createClient();

    handleRoute(server, client, "panel:nav-b", {
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
      targetId: "panel:nav-b",
      requestId: "req-123",
      error: "Target not reachable: panel:nav-b",
      errorCode: "TARGET_NOT_REACHABLE",
    });
  });
});

describe("RpcServer caller identity", () => {
  function rpcRequest(requestId: string, method: string) {
    return {
      type: "request" as const,
      requestId,
      fromId: "test",
      method,
      args: [],
    };
  }

  function sentResponse(client: WsClientState) {
    const calls = (client.ws.send as ReturnType<typeof vi.fn>).mock.calls;
    const raw = calls[calls.length - 1]![0] as string;
    return JSON.parse(raw) as { envelope: { message: { result?: unknown; error?: string } } };
  }

  it("rejects WS authentication for the reserved in-process shell caller id", () => {
    const { server, tokenManager } = createServer();
    const shellToken = tokenManager.createToken("shell", "shell");
    const ws = createTestWs();

    testServer(server).handleAuth(ws, shellToken, "conn-shell");

    expect(ws.close).toHaveBeenCalledWith(4006, expect.stringContaining("shell"));
    expect(testServer(server).connections.getCallerConnections("shell")).toHaveLength(0);
  });

  it("accepts WS authentication for concrete shell host callers", () => {
    const { server, tokenManager } = createServer();
    const remoteToken = tokenManager.createToken("electron-main", "shell");
    const ws = createTestWs();

    testServer(server).handleAuth(ws, remoteToken, "conn-shell-host");

    expect(ws.close).not.toHaveBeenCalled();
    const callers = testServer(server).connections.getCallerConnections("electron-main");
    expect(callers).toHaveLength(1);
    expect(callers[0]!.caller.runtime.kind).toBe("shell");
  });

  it("accepts WS authentication when a connection grant resolves to a shell host principal", () => {
    const { server, connectionGrants, entityCache } = createServer();
    entityCache._onActivate(makeRecord("electron-main", "shell"));
    const grant = connectionGrants.grant("electron-main", "shell:test").token;
    const ws = createTestWs();

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

    await handleRpc(server, client, rpcRequest("req-3", "internal.shellOnly"));

    expect(testServer(server).dispatcher.dispatch).not.toHaveBeenCalled();
    expect(sentResponse(client).envelope.message.error).toContain(
      "not accessible to worker callers"
    );
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

    await handleRpc(server, client, rpcRequest("req-4", "internal.ping"));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      caller: { runtime: { id: client.caller.runtime.id, kind: "server" } },
    });
    expect(sentResponse(client).envelope.message.result).toEqual({ ok: true });
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

    await handleRpc(server, client, {
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
