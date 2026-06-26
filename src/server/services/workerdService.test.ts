import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ServiceDispatcher,
  type ServiceContext,
} from "../../../packages/shared/src/serviceDispatcher.js";
import { createWorkerdService } from "./workerdService.js";
import type { WorkerdManager } from "../workerdManager.js";

const workerCtx: ServiceContext = { caller: createVerifiedCaller("worker:test", "worker") };

function createDeps() {
  return {
    workerdManager: {
      cloneDO: vi.fn(async (ref, newObjectKey) => ({ ...ref, objectKey: newObjectKey })),
      destroyDO: vi.fn(async () => undefined),
    } as unknown as WorkerdManager,
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
});
