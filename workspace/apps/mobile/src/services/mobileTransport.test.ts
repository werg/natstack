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
    expect(statuses).toEqual(["connecting", "disconnected"]);
  });

  it("builds websocket URLs only from server origins", () => {
    expect(buildWsUrl("https://server.example")).toBe("wss://server.example/rpc");
    expect(buildWsUrl("http://127.0.0.1:3030")).toBe("ws://127.0.0.1:3030/rpc");
    expect(() => buildWsUrl("https://server.example/base")).toThrow(/Invalid server URL/);
    expect(() => buildWsUrl("https://user@server.example")).toThrow(/Invalid server URL/);
  });
});
