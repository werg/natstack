import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { CdpConnection } from "./cdpConnection.js";

/** Fake Chromium browser-level CDP endpoint. */
class FakeCdpServer {
  readonly wss: WebSocketServer;
  socket: WebSocket | null = null;
  readonly commands: Array<{ id: number; method: string; params?: unknown; sessionId?: string }> =
    [];

  constructor() {
    this.wss = new WebSocketServer({ port: 0 });
    this.wss.on("connection", (ws) => {
      this.socket = ws;
      ws.on("message", (data) => {
        const message = JSON.parse(String(data));
        this.commands.push(message);
        // Default: echo success with the method name.
        ws.send(JSON.stringify({ id: message.id, result: { method: message.method } }));
      });
    });
  }

  emit(event: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(event));
  }

  async port(): Promise<number> {
    if (this.wss.address()) return (this.wss.address() as { port: number }).port;
    await new Promise<void>((resolve) => this.wss.once("listening", () => resolve()));
    return (this.wss.address() as { port: number }).port;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}

describe("CdpConnection", () => {
  let server: FakeCdpServer;
  let connection: CdpConnection;

  beforeEach(async () => {
    server = new FakeCdpServer();
    connection = await CdpConnection.connect(`ws://127.0.0.1:${await server.port()}`);
  });

  afterEach(async () => {
    connection.close();
    await server.close();
  });

  it("correlates command results by id and passes sessionId through", async () => {
    const result = await connection.send("Runtime.evaluate", { expression: "1" }, "session-1");
    expect(result).toEqual({ method: "Runtime.evaluate" });
    expect(server.commands[0]).toMatchObject({
      method: "Runtime.evaluate",
      params: { expression: "1" },
      sessionId: "session-1",
    });
  });

  it("routes events by session ownership including nested attaches", async () => {
    const events: Array<{ method: string; sessionId?: string }> = [];
    connection.onEvent((event) => events.push({ method: event.method, sessionId: event.sessionId }));

    connection.claimSession("relay-1", "panel-1");
    // Event on owned session.
    server.emit({ method: "Runtime.consoleAPICalled", params: {}, sessionId: "relay-1" });
    // Nested session attached on the owned session inherits the owner.
    server.emit({
      method: "Target.attachedToTarget",
      params: { sessionId: "child-1" },
      sessionId: "relay-1",
    });
    server.emit({ method: "Network.requestWillBeSent", params: {}, sessionId: "child-1" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(connection.ownerOf("relay-1")).toBe("panel-1");
    expect(connection.ownerOf("child-1")).toBe("panel-1");
    expect(events.map((event) => event.method)).toEqual([
      "Runtime.consoleAPICalled",
      "Target.attachedToTarget",
      "Network.requestWillBeSent",
    ]);
  });

  it("releases sessions per slot and forgets detached children", async () => {
    connection.claimSession("relay-1", "panel-1");
    connection.claimSession("mgmt-1", "__mgmt:panel-1");
    server.emit({
      method: "Target.attachedToTarget",
      params: { sessionId: "child-1" },
      sessionId: "relay-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const released = connection.releaseSlotSessions("panel-1");
    expect(released.sort()).toEqual(["child-1", "relay-1"]);
    expect(connection.ownerOf("child-1")).toBeUndefined();

    server.emit({ method: "Target.detachedFromTarget", params: { sessionId: "mgmt-1" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A detach event clears ownership of the detached session.
    expect(connection.ownerOf("mgmt-1")).toBeUndefined();
  });

  it("rejects pending commands when the connection closes", async () => {
    // Make the server stop replying for this test.
    server.socket?.removeAllListeners("message");
    const pending = connection.send("Runtime.evaluate", { expression: "1" });
    server.socket?.close();
    await expect(pending).rejects.toThrow(/closed/);
  });

  it("rejects pending commands when the WebSocket errors after connect", async () => {
    server.socket?.removeAllListeners("message");
    const pending = connection.send("Runtime.evaluate", { expression: "1" });
    (
      connection as unknown as { ws: { emit(event: "error", error: Error): void } }
    ).ws.emit("error", new Error("socket failure"));
    await expect(pending).rejects.toThrow(/socket failure/);
  });

  it("surfaces CDP protocol errors as rejections", async () => {
    server.socket?.removeAllListeners("message");
    server.socket?.on("message", (data) => {
      const message = JSON.parse(String(data));
      server.socket?.send(
        JSON.stringify({ id: message.id, error: { message: "No such method", data: "details" } })
      );
    });
    await expect(connection.send("Bogus.method")).rejects.toThrow(/No such method: details/);
  });
});
