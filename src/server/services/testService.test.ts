import { describe, expect, it, vi } from "vitest";
import {
  createVerifiedCaller,
  ServiceAccessError,
  ServiceDispatcher,
} from "@natstack/shared/serviceDispatcher";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import { createTestService } from "./testService.js";

function createService() {
  return createTestService({
    contextFolderManager: { ensureContextFolder: vi.fn() } as never,
    workspacePath: "/workspace",
    panelTestSetupPath: "/workspace/src/main/services/testSetup.ts",
  });
}

const serverCtx: ServiceContext = { caller: createVerifiedCaller("server", "server") };
const panelCtx: ServiceContext = {
  caller: createVerifiedCaller("panel:tree/panels~my-app/abc123", "panel"),
};
const workerCtx: ServiceContext = {
  caller: createVerifiedCaller("worker:workers/alpha", "worker"),
};

describe("testService policy", () => {
  it("restricts to server-only callers", () => {
    const service = createService();
    expect(service.policy.allowed).toEqual(["server"]);
  });

  it("rejects panel callers with ServiceAccessError via dispatcher", async () => {
    const service = createService();
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(service);
    dispatcher.markInitialized();

    await expect(
      dispatcher.dispatch(panelCtx, "test", "run", ["ctx_123", "panels/my-app"])
    ).rejects.toBeInstanceOf(ServiceAccessError);
  });

  it("rejects worker callers with ServiceAccessError via dispatcher", async () => {
    const service = createService();
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(service);
    dispatcher.markInitialized();

    await expect(
      dispatcher.dispatch(workerCtx, "test", "run", ["ctx_123", "panels/my-app"])
    ).rejects.toBeInstanceOf(ServiceAccessError);
  });

  it("carries EACCES error code on policy rejection", async () => {
    const service = createService();
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(service);
    dispatcher.markInitialized();

    await expect(
      dispatcher.dispatch(panelCtx, "test", "run", ["ctx_123", "panels/my-app"])
    ).rejects.toMatchObject({ name: "ServiceAccessError", code: "EACCES" });
  });

  it("allows server-origin callers to reach the handler", async () => {
    // The handler itself is tested separately in testRunnerService.test.ts.
    // Here we only verify that server callers are not blocked at the policy gate —
    // the handler will throw because vitest/node is not available in this test env,
    // but that error is not a ServiceAccessError, proving the gate was passed.
    const service = createService();
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(service);
    dispatcher.markInitialized();

    const result = dispatcher.dispatch(serverCtx, "test", "run", ["ctx_123", "panels/my-app"]);
    await expect(result).rejects.not.toBeInstanceOf(ServiceAccessError);
  });
});
