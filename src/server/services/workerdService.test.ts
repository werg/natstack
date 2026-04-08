import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServiceDispatcher, type ServiceContext } from "../../../packages/shared/src/serviceDispatcher.js";
import { createWorkerdService } from "./workerdService.js";

const workerCtx: ServiceContext = { callerId: "worker:test", callerKind: "worker" };

function createDeps() {
  return {
    workerdManager: {
      createInstance: vi.fn(async (options) => ({ ...options, token: "secret", status: "running" })),
      destroyInstance: vi.fn(async () => undefined),
      updateInstance: vi.fn(async (_name, updates) => ({ name: "hello", ...updates, token: "secret", status: "running" })),
      listInstances: vi.fn(() => []),
      getInstanceStatus: vi.fn(() => null),
      getPort: vi.fn(() => 8787),
      restartAll: vi.fn(async () => undefined),
      cloneDO: vi.fn(async (ref, newObjectKey) => ({ ...ref, objectKey: newObjectKey })),
      destroyDO: vi.fn(async () => undefined),
    } as any,
    buildSystem: {
      getGraph: vi.fn(() => ({
        allNodes: () => [
          { kind: "worker", name: "hello", relativePath: "workers/hello", manifest: { title: "Hello" } },
        ],
      })),
    } as any,
  };
}

describe("workerdService", () => {
  let dispatcher: ServiceDispatcher;
  let deps: ReturnType<typeof createDeps>;

  beforeEach(() => {
    dispatcher = new ServiceDispatcher();
    deps = createDeps();
    dispatcher.registerService(createWorkerdService(deps));
    dispatcher.markInitialized();
  });

  it("rejects fake limits on createInstance", async () => {
    await expect(
      dispatcher.dispatch(workerCtx, "workerd", "createInstance", [{
        source: "workers/hello",
        contextId: "ctx-1",
        limits: { cpuMs: 100 },
      }]),
    ).rejects.toThrow(/Invalid args/);
  });

  it("accepts parentId on createInstance", async () => {
    await dispatcher.dispatch(workerCtx, "workerd", "createInstance", [{
      source: "workers/hello",
      contextId: "ctx-1",
      parentId: "panel:abc",
    }]);

    expect(deps.workerdManager.createInstance).toHaveBeenCalledWith({
      source: "workers/hello",
      contextId: "ctx-1",
      parentId: "panel:abc",
    });
  });

  it("rejects unknown createInstance fields", async () => {
    await expect(
      dispatcher.dispatch(workerCtx, "workerd", "createInstance", [{
        source: "workers/hello",
        contextId: "ctx-1",
        nope: true,
      }]),
    ).rejects.toThrow(/Invalid args/);
  });

  it("rejects unknown updateInstance fields", async () => {
    await expect(
      dispatcher.dispatch(workerCtx, "workerd", "updateInstance", [
        "hello",
        { env: { FOO: "bar" }, limits: { cpuMs: 100 } },
      ]),
    ).rejects.toThrow(/Invalid args/);
  });

  it("lists instance sources via the renamed method", async () => {
    const result = await dispatcher.dispatch(workerCtx, "workerd", "listInstanceSources", []);

    expect(result).toEqual([
      { name: "hello", source: "workers/hello", title: "Hello" },
    ]);
  });
});
