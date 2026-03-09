/**
 * Tests for the typed workerd client.
 */

import { createWorkerdClient, type WorkerdClient, type WorkerCreateOptions } from "./workerd.js";

function createMockRpc() {
  const calls: Array<{ target: string; method: string; args: unknown[] }> = [];

  return {
    rpc: {
      call: vi.fn(async <T>(target: string, method: string, ...args: unknown[]): Promise<T> => {
        calls.push({ target, method, args });
        return undefined as T;
      }),
    },
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

  it("create calls workerd.createInstance with options", async () => {
    const opts: WorkerCreateOptions = {
      source: "workers/hello",
      contextId: "ctx-1",
      limits: { cpuMs: 100 },
    };
    await client.create(opts);

    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workerd.createInstance", opts);
  });

  it("destroy calls workerd.destroyInstance", async () => {
    await client.destroy("hello");
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workerd.destroyInstance", "hello");
  });

  it("update calls workerd.updateInstance", async () => {
    await client.update("hello", { env: { X: "1" } });
    expect(mock.rpc.call).toHaveBeenCalledWith(
      "main",
      "workerd.updateInstance",
      "hello",
      { env: { X: "1" } },
    );
  });

  it("list calls workerd.listInstances", async () => {
    await client.list();
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workerd.listInstances");
  });

  it("status calls workerd.getInstanceStatus", async () => {
    await client.status("hello");
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workerd.getInstanceStatus", "hello");
  });

  it("listSources calls workerd.listSources", async () => {
    await client.listSources();
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workerd.listSources");
  });

  it("getPort calls workerd.getPort", async () => {
    await client.getPort();
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workerd.getPort");
  });

  it("restartAll calls workerd.restartAll", async () => {
    await client.restartAll();
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workerd.restartAll");
  });
});
