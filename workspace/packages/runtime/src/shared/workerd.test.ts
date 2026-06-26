/**
 * Tests for the typed workerd client.
 *
 * Worker instance lifecycle now lives on `runtime.createEntity`/`retireEntity`
 * (no `workerd.*` lifecycle client). What remains is userland service resolution
 * and the fork/storage DO primitives.
 */

import { createWorkerdClient, type WorkerdClient } from "./workerd.js";

function createMockRpc() {
  const calls: Array<{ target: string; method: string; args: unknown[] }> = [];

  return {
    rpc: {
      call: vi.fn(async (target: string, method: string, args: unknown[]) => {
        calls.push({ target, method, args });
        return undefined;
      }),
    } as any,
    calls,
  };
}

describe("createWorkerdClient", () => {
  let client: WorkerdClient;
  let mock: ReturnType<typeof createMockRpc>;

  beforeEach(() => {
    mock = createMockRpc();
    client = createWorkerdClient(mock.rpc);
  });

  it("exposes only service-resolution (no lifecycle, no DO-storage primitives)", () => {
    // cloneDO/destroyDO are closed off — reachable only via runtime.cloneContext/
    // destroyContext (server-internal), never on this userland client.
    expect(Object.keys(client).sort()).toEqual(
      ["durableObjectService", "listServices", "resolveDurableObject", "resolveService"].sort()
    );
  });

  it("listServices calls workers.listServices", async () => {
    await client.listServices();
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workers.listServices", []);
  });

  it("resolveService calls workers.resolveService", async () => {
    await client.resolveService("natstack.channel.v1", "chat-1");
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workers.resolveService", [
      "natstack.channel.v1",
      "chat-1",
    ]);
  });

  it("durableObjectService resolves then calls the service target through unified RPC", async () => {
    mock.rpc.call.mockImplementation(async (target: string, method: string) => {
      if (target === "main" && method === "workers.resolveService") {
        return {
          kind: "durable-object",
          targetId: "do:workers/example:ExampleDO:key-1",
        };
      }
      return "ok";
    });

    await expect(
      client.durableObjectService("example.service.v1", "key-1").call("ping")
    ).resolves.toBe("ok");
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workers.resolveService", [
      "example.service.v1",
      "key-1",
    ]);
    expect(mock.rpc.call).toHaveBeenCalledWith("do:workers/example:ExampleDO:key-1", "ping", []);
  });

  it("resolveDurableObject calls workers.resolveDurableObject", async () => {
    await client.resolveDurableObject("workers/example", "ExampleDO", "key-1");
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workers.resolveDurableObject", [
      "workers/example",
      "ExampleDO",
      "key-1",
    ]);
  });
});
