import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { CdpHostBridgeClient, type HostBridgeHandlers } from "./hostBridge.js";

/** Minimal fake of the server's cdpBridge /api/cdp-host endpoint. */
class FakeBridgeServer {
  readonly wss: WebSocketServer;
  socket: WebSocket | null = null;
  readonly received: Array<Record<string, unknown>> = [];
  authToken = "good-token";
  private waiters: Array<(message: Record<string, unknown>) => void> = [];

  constructor(port: number) {
    this.wss = new WebSocketServer({ port, path: undefined });
    this.wss.on("connection", (ws) => {
      this.socket = ws;
      ws.on("message", (data) => {
        const message = JSON.parse(String(data)) as Record<string, unknown>;
        if (message["type"] === "natstack:cdp-auth") {
          if (message["token"] === this.authToken) {
            ws.send(JSON.stringify({ type: "natstack:cdp-auth-ok" }));
          } else {
            ws.close(4401);
          }
          return;
        }
        const waiter = this.waiters.shift();
        if (waiter) waiter(message);
        else this.received.push(message);
      });
    });
  }

  next(): Promise<Record<string, unknown>> {
    const pending = this.received.shift();
    if (pending) return Promise.resolve(pending);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  send(message: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(message));
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}

function handlers(overrides: Partial<HostBridgeHandlers> = {}): HostBridgeHandlers {
  return {
    cdpCommand: vi.fn(async () => ({ ok: true })),
    navCommand: vi.fn(async () => undefined),
    hostCommand: vi.fn(async () => ({ nodes: [] })),
    detach: vi.fn(async () => undefined),
    registerRejected: vi.fn(),
    ...overrides,
  };
}

describe("CdpHostBridgeClient", () => {
  let server: FakeBridgeServer;
  let client: CdpHostBridgeClient | null = null;
  let port: number;

  beforeEach(async () => {
    server = new FakeBridgeServer(0);
    await new Promise<void>((resolve) => server.wss.once("listening", () => resolve()));
    port = (server.wss.address() as { port: number }).port;
  });

  afterEach(async () => {
    client?.stop();
    client = null;
    await server.close();
  });

  function startClient(h: HostBridgeHandlers): Promise<void> {
    return new Promise((resolve) => {
      client = new CdpHostBridgeClient({
        serverUrl: `http://127.0.0.1:${port}`,
        hostConnectionId: "headless-test",
        getToken: () => "good-token",
        handlers: h,
        onAuthenticated: () => resolve(),
      });
      client.start();
    });
  }

  it("preserves selected workspace paths in the bridge URL", () => {
    client = new CdpHostBridgeClient({
      serverUrl: "https://server.example/_workspace/dev/",
      hostConnectionId: "headless test",
      getToken: () => "good-token",
      handlers: handlers(),
    });

    expect((client as unknown as { wsUrl(): string }).wsUrl()).toBe(
      "wss://server.example/_workspace/dev/api/cdp-host?hostConnectionId=headless+test"
    );
  });

  it("authenticates and re-registers targets on auth-ok", async () => {
    const h = handlers();
    await startClient(h);
    client!.registerTarget("panel-1", 7);
    const registered = await server.next();
    expect(registered).toEqual({ type: "cdp:register", targetId: "panel-1", tabId: 7 });

    // Force a reconnect: server closes the socket; client reconnects (1s),
    // re-auths and re-registers the known target automatically.
    server.socket?.close();
    const reRegistered = await server.next();
    expect(reRegistered).toEqual({ type: "cdp:register", targetId: "panel-1", tabId: 7 });
  }, 15_000);

  it("relays cdp:command to the handler and returns cdp:result", async () => {
    const h = handlers({
      cdpCommand: vi.fn(async (_t, method) => ({ echoed: method })),
    });
    await startClient(h);
    server.send({
      type: "cdp:command",
      requestId: "r1",
      targetId: "panel-1",
      method: "Runtime.evaluate",
      params: { expression: "1+1" },
      sessionId: "s9",
    });
    const result = await server.next();
    expect(result).toEqual({
      type: "cdp:result",
      requestId: "r1",
      targetId: "panel-1",
      result: { echoed: "Runtime.evaluate" },
    });
    expect(h.cdpCommand).toHaveBeenCalledWith(
      "panel-1",
      "Runtime.evaluate",
      { expression: "1+1" },
      "s9"
    );
  });

  it("maps handler failures to cdp:error / nav:error / host:error", async () => {
    const h = handlers({
      cdpCommand: vi.fn(async () => {
        throw new Error("boom");
      }),
      navCommand: vi.fn(async () => {
        throw new Error("nav-fail");
      }),
    });
    await startClient(h);
    server.send({ type: "cdp:command", requestId: "r1", targetId: "p", method: "X" });
    expect(await server.next()).toMatchObject({ type: "cdp:error", requestId: "r1", error: "boom" });
    server.send({ type: "nav:command", requestId: "r2", targetId: "p", action: "reload" });
    expect(await server.next()).toMatchObject({ type: "nav:error", requestId: "r2", error: "nav-fail" });
  });

  it("handles host:command, cdp:detach and register rejection", async () => {
    const h = handlers();
    await startClient(h);
    client!.registerTarget("panel-1", 1);
    await server.next(); // consume register

    server.send({ type: "host:command", requestId: "r3", targetId: "panel-1", action: "accessibilityTree", args: [] });
    expect(await server.next()).toMatchObject({ type: "host:result", requestId: "r3" });
    expect(h.hostCommand).toHaveBeenCalledWith("panel-1", "accessibilityTree", []);

    server.send({ type: "cdp:detach", targetId: "panel-1" });
    server.send({ type: "cdp:register-rejected", targetId: "panel-1", reason: "lease_mismatch" });
    // Round-trip another message so the detach/rejection have been processed.
    server.send({ type: "host:command", requestId: "r4", targetId: "x", action: "noop", args: [] });
    await server.next();
    expect(h.detach).toHaveBeenCalledWith("panel-1");
    expect(h.registerRejected).toHaveBeenCalledWith("panel-1", "lease_mismatch");
  });

  it("forwards cdp:event with optional sessionId", async () => {
    const h = handlers();
    await startClient(h);
    client!.sendEvent("panel-1", "Runtime.consoleAPICalled", { type: "log" });
    expect(await server.next()).toEqual({
      type: "cdp:event",
      targetId: "panel-1",
      method: "Runtime.consoleAPICalled",
      params: { type: "log" },
    });
    client!.sendEvent("panel-1", "Target.attachedToTarget", {}, "child-session");
    expect(await server.next()).toMatchObject({ sessionId: "child-session" });
  });
});
