import { wsClientTransport } from "./wsClient.js";
import type { WsLike } from "../protocol/wsAdapter.js";

class FakeSocket implements WsLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  authenticate(): void {
    this.onmessage?.({
      data: JSON.stringify({
        success: true,
        type: "ws:auth-result",
      }),
    });
  }
}

function createTransportHarness() {
  const sockets: FakeSocket[] = [];
  const transport = wsClientTransport({
    adapter: {
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      getAuthToken: async () => "token",
      now: () => Date.now(),
    },
    getWsUrl: () => "wss://server.example/rpc",
    selfId: "app:mobile:test",
  });
  return { sockets, transport };
}

describe("wsClientTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the default first-connect timeout", async () => {
    const { transport } = createTransportHarness();
    const promise = transport.connectAndWait();
    const assertion = expect(promise).rejects.toThrow(
      "Server WS connection timeout (10000ms): wss://server.example/rpc"
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
  });

  it("waits without a first-connect deadline when timeout is null", async () => {
    const { sockets, transport } = createTransportHarness();
    let settled = false;
    const promise = transport.connectAndWait(null).finally(() => {
      settled = true;
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(settled).toBe(false);
    sockets[0]?.open();
    sockets[0]?.authenticate();

    await expect(promise).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("delivers pushed ws:event frames to the server-event callback", async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const sockets: FakeSocket[] = [];
    const eventTransport = wsClientTransport({
      adapter: {
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        getAuthToken: async () => "token",
        now: () => Date.now(),
      },
      getWsUrl: () => "wss://server.example/rpc",
      selfId: "app:mobile:test",
      onServerEvent: (event, payload) => events.push({ event, payload }),
    });

    const connected = eventTransport.connectAndWait();
    await Promise.resolve();
    sockets[0]?.open();
    sockets[0]?.authenticate();
    await connected;

    const payload = { pending: [{ approvalId: "approval-1", kind: "credential" }] };
    sockets[0]?.onmessage?.({
      data: JSON.stringify({
        type: "ws:event",
        event: "event:shell-approval:pending-changed",
        payload,
      }),
    });

    expect(events).toEqual([{ event: "event:shell-approval:pending-changed", payload }]);
  });

  it("synthesizes a rejecting response envelope from ws:routed-response-error", async () => {
    const { sockets, transport } = createTransportHarness();
    const delivered: Array<{ from: string; message: unknown }> = [];
    transport.onMessage((envelope) => {
      delivered.push({ from: envelope.from, message: envelope.message });
    });

    const connected = transport.connectAndWait();
    await Promise.resolve();
    sockets[0]?.open();
    sockets[0]?.authenticate();
    await connected;

    sockets[0]?.onmessage?.({
      data: JSON.stringify({
        type: "ws:routed-response-error",
        targetId: "do:notes:Bucket:key",
        requestId: "req-123",
        error: "Target not reachable: do:notes:Bucket:key",
        errorCode: "TARGET_NOT_REACHABLE",
      }),
    });

    expect(delivered).toEqual([
      {
        from: "do:notes:Bucket:key",
        message: {
          type: "response",
          requestId: "req-123",
          error: "Target not reachable: do:notes:Bucket:key",
          errorCode: "TARGET_NOT_REACHABLE",
        },
      },
    ]);
  });

  it("does not synthesize a response for ws:routed-event-error (logs only)", async () => {
    const { sockets, transport } = createTransportHarness();
    const delivered: unknown[] = [];
    transport.onMessage((envelope) => delivered.push(envelope));

    const connected = transport.connectAndWait();
    await Promise.resolve();
    sockets[0]?.open();
    sockets[0]?.authenticate();
    await connected;

    sockets[0]?.onmessage?.({
      data: JSON.stringify({
        type: "ws:routed-event-error",
        targetId: "panel:gone",
        event: "ping",
        error: "Target not reachable: panel:gone",
        errorCode: "TARGET_NOT_REACHABLE",
      }),
    });

    expect(delivered).toEqual([]);
  });
});
