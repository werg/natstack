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

  it("exposes only service-resolution + DO-storage primitives (no lifecycle)", () => {
    expect(Object.keys(client).sort()).toEqual(
      [
        "cloneDO",
        "destroyDO",
        "durableObjectService",
        "listServices",
        "resolveDurableObject",
        "resolveService",
      ].sort()
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

  it("cloneDO calls workerd.cloneDO", async () => {
    const ref = { source: "workers/x", className: "X", objectKey: "k" };
    await client.cloneDO(ref, "new-key");
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workerd.cloneDO", [ref, "new-key"]);
  });

  it("destroyDO calls workerd.destroyDO", async () => {
    const ref = { source: "workers/x", className: "X", objectKey: "k" };
    await client.destroyDO(ref);
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workerd.destroyDO", [ref]);
  });
});
