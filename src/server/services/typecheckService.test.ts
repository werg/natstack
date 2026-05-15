import { describe, expect, it, vi } from "vitest";
import { ServiceAccessError, ServiceDispatcher } from "@natstack/shared/serviceDispatcher";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import { createTypecheckService } from "./typecheckService.js";

/**
 * Regression coverage: typecheck service must reject panel/worker callers
 * that supply a contextId other than their own bound context.
 *
 * Critical invariant: the binding check must run BEFORE any call into
 * `resolveContextScope` / `ensureContextFolder` — otherwise a malicious
 * caller could trigger `git clone --shared` for a foreign context folder
 * as a side-effect of the rejected call. Each "reject" test asserts
 * `ensureContextFolder` was *never* invoked.
 */

function createServiceWithBinding(bindings: Record<string, string>) {
  const ensureContextFolder = vi.fn(async (id: string) => `/contexts/${id}`);
  const service = createTypecheckService({
    contextFolderManager: { ensureContextFolder } as never,
    getCallerContext: (callerId: string) => bindings[callerId],
  });
  return { service, ensureContextFolder };
}

const panelOwnsCtx1: ServiceContext = {
  callerId: "tree/panels~my-app/abc123",
  callerKind: "panel",
};
const workerOwnsCtx2: ServiceContext = {
  callerId: "tree/workers~alpha/xyz",
  callerKind: "worker",
};
const serverCtx: ServiceContext = { callerId: "server", callerKind: "server" };

describe("typecheckService — caller↔context binding (H1)", () => {
  it("rejects a panel that supplies a contextId belonging to a different panel", async () => {
    const { service, ensureContextFolder } = createServiceWithBinding({
      [panelOwnsCtx1.callerId]: "ctx_owned_by_panel",
    });

    await expect(
      service.handler(panelOwnsCtx1, "check", [
        "panels/my-app",
        undefined,
        undefined,
        "ctx_owned_by_someone_else",
      ])
    ).rejects.toBeInstanceOf(ServiceAccessError);

    expect(ensureContextFolder).not.toHaveBeenCalled();
  });

  it("rejects a worker that supplies a contextId belonging to a different caller", async () => {
    const { service, ensureContextFolder } = createServiceWithBinding({
      [workerOwnsCtx2.callerId]: "ctx_owned_by_worker",
    });

    await expect(
      service.handler(workerOwnsCtx2, "getTypeInfo", [
        "panels/my-app",
        "src/index.ts",
        1,
        1,
        undefined,
        "ctx_owned_by_someone_else",
      ])
    ).rejects.toBeInstanceOf(ServiceAccessError);

    expect(ensureContextFolder).not.toHaveBeenCalled();
  });

  it("rejects a panel with no registered binding that supplies any contextId", async () => {
    const { service, ensureContextFolder } = createServiceWithBinding({});

    await expect(
      service.handler(panelOwnsCtx1, "getCompletions", [
        "panels/my-app",
        "src/index.ts",
        1,
        1,
        undefined,
        "ctx_anything",
      ])
    ).rejects.toBeInstanceOf(ServiceAccessError);

    expect(ensureContextFolder).not.toHaveBeenCalled();
  });

  it("carries EACCES error code on policy rejection", async () => {
    const { service } = createServiceWithBinding({
      [panelOwnsCtx1.callerId]: "ctx_owned_by_panel",
    });

    await expect(
      service.handler(panelOwnsCtx1, "check", [
        "panels/my-app",
        undefined,
        undefined,
        "ctx_owned_by_someone_else",
      ])
    ).rejects.toMatchObject({ name: "ServiceAccessError", code: "EACCES" });
  });

  it("allows a panel that supplies its own bound contextId — resolveContextScope is reached", async () => {
    const { service, ensureContextFolder } = createServiceWithBinding({
      [panelOwnsCtx1.callerId]: "ctx_owned_by_panel",
    });

    await service.handler(panelOwnsCtx1, "check", [
      "panels/my-app",
      undefined,
      undefined,
      "ctx_owned_by_panel",
    ]);

    expect(ensureContextFolder).toHaveBeenCalledWith("ctx_owned_by_panel");
  });

  it("allows a panel call that omits the contextId argument (binding gate is a no-op)", async () => {
    const { service, ensureContextFolder } = createServiceWithBinding({
      [panelOwnsCtx1.callerId]: "ctx_owned_by_panel",
    });

    await service.handler(panelOwnsCtx1, "check", [
      "panels/my-app",
      undefined,
      undefined,
      undefined,
    ]);

    // No contextId → no resolveContextScope → no ensureContextFolder.
    expect(ensureContextFolder).not.toHaveBeenCalled();
  });

  it("allows server callers to supply any contextId (server is trusted)", async () => {
    const { service, ensureContextFolder } = createServiceWithBinding({});

    await service.handler(serverCtx, "check", [
      "panels/my-app",
      undefined,
      undefined,
      "ctx_anything_server_wants",
    ]);

    expect(ensureContextFolder).toHaveBeenCalledWith("ctx_anything_server_wants");
  });

  it("dispatcher integration: cross-context attempts surface as ServiceAccessError (not re-wrapped)", async () => {
    const { service, ensureContextFolder } = createServiceWithBinding({
      [panelOwnsCtx1.callerId]: "ctx_owned_by_panel",
    });
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(service);
    dispatcher.markInitialized();

    await expect(
      dispatcher.dispatch(panelOwnsCtx1, "typecheck", "check", [
        "panels/my-app",
        undefined,
        undefined,
        "ctx_owned_by_someone_else",
      ])
    ).rejects.toBeInstanceOf(ServiceAccessError);

    expect(ensureContextFolder).not.toHaveBeenCalled();
  });
});
