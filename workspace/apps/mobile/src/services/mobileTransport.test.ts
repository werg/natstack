import { buildWsUrl, MobileRpcClient, type MobileConnectionGrant } from "./mobileTransport";

describe("MobileRpcClient", () => {
  it("accepts paired mobile shell principals from native grants", async () => {
    const transport = new MobileRpcClient({
      serverUrl: "https://server.example",
      issueConnectionGrant: async () => ({
        callerId: "shell:dev_123",
        connectionGrant: "grant_123",
      }),
    });

    await expect(
      (
        transport as unknown as {
          issueNativeGrant(): Promise<MobileConnectionGrant>;
        }
      ).issueNativeGrant()
    ).resolves.toMatchObject({
      callerId: "shell:dev_123",
    });
  });

  it("accepts workspace mobile app principals from native grants", async () => {
    const transport = new MobileRpcClient({
      serverUrl: "https://server.example",
      issueConnectionGrant: async () => ({
        callerId: "app:apps/field-mobile:dev_123",
        connectionGrant: "grant_123",
      }),
    });

    await expect(
      (
        transport as unknown as {
          issueNativeGrant(): Promise<MobileConnectionGrant>;
        }
      ).issueNativeGrant()
    ).resolves.toMatchObject({
      callerId: "app:apps/field-mobile:dev_123",
    });
  });

  it("rejects non-canonical app principals from native grants", async () => {
    const transport = new MobileRpcClient({
      serverUrl: "https://server.example",
      issueConnectionGrant: async () => ({
        callerId: "app:other-app:dev_123",
        connectionGrant: "grant_123",
      }),
    });

    await expect(transport.call("main", "noop", [])).rejects.toThrow(
      /invalid mobile host connection grant/
    );
  });

  it("returns to disconnected when connectAndWait cannot initialize native grants", async () => {
    const transport = new MobileRpcClient({
      serverUrl: "https://server.example",
      issueConnectionGrant: async () => {
        throw new Error("grant failed");
      },
    });
    const statuses: string[] = [];
    transport.onStatusChange((status) => statuses.push(status));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(transport.connectAndWait(1)).rejects.toThrow("grant failed");
    } finally {
      warnSpy.mockRestore();
    }

    expect(transport.status).toBe("disconnected");
    expect(statuses).toEqual(["connecting", "connecting", "disconnected"]);
  });

  it("retries transient initial WebSocket failures", async () => {
    const OriginalWebSocket = global.WebSocket;
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    let sockets = 0;
    let grants = 0;

    class FakeWebSocket {
      static readonly OPEN = 1;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      private readonly socketNumber = ++sockets;

      constructor(readonly url: string) {
        setTimeout(() => {
          if (this.socketNumber === 1) {
            this.readyState = 3;
            this.onerror?.({ message: "temporary vpn warmup" });
            this.onclose?.({ code: 1006, reason: "temporary vpn warmup" });
            return;
          }
          this.readyState = 1;
          this.onopen?.();
        }, 0);
      }

      send(data: string): void {
        if (!data.includes('"type":"ws:auth"')) return;
        setTimeout(() => {
          this.onmessage?.({
            data: JSON.stringify({ type: "ws:auth-result", success: true }),
          });
        }, 0);
      }

      close(code?: number, reason?: string): void {
        this.readyState = 3;
        setTimeout(() => this.onclose?.({ code, reason }), 0);
      }
    }

    global.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const transport = new MobileRpcClient({
      serverUrl: "https://server.example",
      initialConnectionRetry: { maxMs: 2_000, delayMs: 1, maxDelayMs: 1 },
      issueConnectionGrant: async () => ({
        callerId: "shell:dev_123",
        connectionGrant: `grant_${++grants}`,
      }),
    });

    try {
      await expect(transport.connectAndWait()).resolves.toBeUndefined();
      expect(sockets).toBe(2);
      expect(grants).toBe(2);
      expect(transport.status).toBe("connected");
    } finally {
      global.WebSocket = OriginalWebSocket;
      warnSpy.mockRestore();
    }
  });

  it("builds websocket URLs only from server origins", () => {
    expect(buildWsUrl("https://server.example")).toBe("wss://server.example/rpc");
    expect(buildWsUrl("http://127.0.0.1:3030")).toBe("ws://127.0.0.1:3030/rpc");
    expect(() => buildWsUrl("https://server.example/base")).toThrow(/Invalid server URL/);
    expect(() => buildWsUrl("https://user@server.example")).toThrow(/Invalid server URL/);
  });
});
