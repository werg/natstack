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
});
