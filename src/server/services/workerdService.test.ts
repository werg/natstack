import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ServiceDispatcher,
  type ServiceContext,
} from "../../../packages/shared/src/serviceDispatcher.js";
import { createWorkerdService } from "./workerdService.js";
import type { WorkerdManager } from "../workerdManager.js";
import type { BuildSystemV2 } from "../buildV2/index.js";

const workerCtx: ServiceContext = { caller: createVerifiedCaller("worker:test", "worker") };

function createDeps() {
  return {
    workerdManager: {
      createInstance: vi.fn(async (options) => ({
        id: `worker:${options.name ?? options.source.split("/").pop() ?? "worker"}`,
        ...options,
        callerId: `worker:${options.name ?? options.source.split("/").pop() ?? "worker"}`,
        token: "secret",
        status: "running",
      })),
      destroyInstance: vi.fn(async () => undefined),
      updateInstance: vi.fn(async (_name, updates) => ({
        name: "hello",
        ...updates,
        token: "secret",
        status: "running",
      })),
      listInstances: vi.fn(() => []),
      getInstanceStatus: vi.fn(() => null),
      getPort: vi.fn(() => 8787),
      restartAll: vi.fn(async () => undefined),
      cloneDO: vi.fn(async (ref, newObjectKey) => ({ ...ref, objectKey: newObjectKey })),
      destroyDO: vi.fn(async () => undefined),
    } as unknown as WorkerdManager,
    buildSystem: {
      getGraph: vi.fn(() => ({
        allNodes: () => [
          {
            kind: "worker",
            name: "hello",
            relativePath: "workers/hello",
            manifest: { title: "Hello" },
          },
        ],
      })),
    } as unknown as BuildSystemV2,
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
      dispatcher.dispatch(workerCtx, "workerd", "createInstance", [
        {
          source: "workers/hello",
          contextId: "ctx-1",
          limits: { cpuMs: 100 },
        },
      ])
    ).rejects.toThrow(/Invalid args/);
  });

  it("rejects unknown createInstance fields", async () => {
    await expect(
      dispatcher.dispatch(workerCtx, "workerd", "createInstance", [
        {
          source: "workers/hello",
          contextId: "ctx-1",
          nope: true,
        },
      ])
    ).rejects.toThrow(/Invalid args/);
  });

  it("accepts and forwards parent handle metadata for worker parent handles", async () => {
    const result = await dispatcher.dispatch(workerCtx, "workerd", "createInstance", [
      {
        source: "workers/hello",
        contextId: "ctx-1",
        parentId: "panel-parent",
        parentEntityId: "panel:parent-entity",
        parentKind: "panel",
      },
    ]);

    expect(result).not.toHaveProperty("token");
    expect(result).toMatchObject({
      id: "worker:hello",
      parentId: "panel-parent",
      parentEntityId: "panel:parent-entity",
      parentKind: "panel",
    });
    expect(deps.workerdManager.createInstance).toHaveBeenCalledWith({
      source: "workers/hello",
      contextId: "ctx-1",
      parentId: "panel-parent",
      parentEntityId: "panel:parent-entity",
      parentKind: "panel",
    });
  });

  it("rejects unknown updateInstance fields", async () => {
    await expect(
      dispatcher.dispatch(workerCtx, "workerd", "updateInstance", [
        "hello",
        { env: { FOO: "bar" }, limits: { cpuMs: 100 } },
      ])
    ).rejects.toThrow(/Invalid args/);
  });

  it("lists instance sources via the renamed method", async () => {
    const result = await dispatcher.dispatch(workerCtx, "workerd", "listInstanceSources", []);

    expect(result).toEqual([{ name: "hello", source: "workers/hello", title: "Hello" }]);
  });

  it("closes cloneDO/destroyDO to userland (panel/do) callers — fork/storage primitives", async () => {
    const doCtx: ServiceContext = { caller: createVerifiedCaller("do:agent", "do") };
    const ref = { source: "workers/x", className: "X", objectKey: "k" };
    await expect(dispatcher.dispatch(doCtx, "workerd", "cloneDO", [ref, "new"])).rejects.toThrow(
      /not permitted/
    );
    await expect(dispatcher.dispatch(doCtx, "workerd", "destroyDO", [ref])).rejects.toThrow(
      /not permitted/
    );
    // The fork worker (a "worker") is NOT blocked — it is the legitimate caller.
    await dispatcher.dispatch(workerCtx, "workerd", "cloneDO", [ref, "new"]);
    expect(deps.workerdManager.cloneDO).toHaveBeenCalled();
  });

  it("engages the capability gate for a userland (do) createInstance (workers bypass)", async () => {
    const doCtx: ServiceContext = { caller: createVerifiedCaller("do:agent", "do") };
    // No approvalQueue/grantStore wired here, so an ungated userland call is refused —
    // proving the gate engages for "do" (whereas the worker caller above bypasses).
    await expect(
      dispatcher.dispatch(doCtx, "workerd", "createInstance", [
        { source: "workers/hello", contextId: "ctx-1" },
      ])
    ).rejects.toThrow(/approval is unavailable/);
  });
});
