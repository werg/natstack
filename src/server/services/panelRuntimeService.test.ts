import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { PanelRuntimeCoordinator } from "../panelRuntimeCoordinator.js";
import { createPanelRuntimeService } from "./panelRuntimeService.js";

describe("panelRuntimeService", () => {
  it("accepts headless CDP-capable clients with stable host ids", async () => {
    const coordinator = {
      registerClient: vi.fn(),
      unregisterClient: vi.fn(),
      getSnapshot: vi.fn(),
      acquire: vi.fn(),
      takeOver: vi.fn(),
      release: vi.fn(),
      ownsClientSession: vi.fn(() => true),
    };
    const service = createPanelRuntimeService({ coordinator: coordinator as never });
    const input = {
      clientSessionId: "headless-session",
      hostConnectionId: "headless-host",
      label: "Headless",
      platform: "headless",
      loadOnLeaseAssignment: true,
      supportsCdp: true,
    };

    expect(() => service.methods["registerClient"]?.args.parse([input])).not.toThrow();
    await service.handler(
      { caller: createVerifiedCaller("shell:desktop", "shell") },
      "registerClient",
      [input]
    );

    expect(coordinator.registerClient).toHaveBeenCalledWith({
      ...input,
      ownerCallerId: "shell:desktop",
    });
  });

  it("accepts lease requests that carry a provider host id", () => {
    const service = createPanelRuntimeService({ coordinator: {} as never });

    expect(() =>
      service.methods["acquire"]?.args.parse([
        "panel:entity",
        {
          slotId: "slot",
          clientSessionId: "headless-session",
          connectionId: "runtime-connection",
          hostConnectionId: "headless-host",
        },
      ])
    ).not.toThrow();
  });

  it("forwards client unregister requests to the coordinator", async () => {
    const coordinator = {
      registerClient: vi.fn(),
      unregisterClient: vi.fn(),
      getSnapshot: vi.fn(),
      acquire: vi.fn(),
      takeOver: vi.fn(),
      release: vi.fn(),
      ownsClientSession: vi.fn(() => true),
    };
    const service = createPanelRuntimeService({ coordinator: coordinator as never });

    expect(() =>
      service.methods["unregisterClient"]?.args.parse(["headless-session"])
    ).not.toThrow();
    await service.handler(
      { caller: createVerifiedCaller("shell:desktop", "shell") },
      "unregisterClient",
      ["headless-session"]
    );

    expect(coordinator.unregisterClient).toHaveBeenCalledWith("headless-session");
    expect(coordinator.ownsClientSession).toHaveBeenCalledWith("headless-session", "shell:desktop");
  });

  it("rejects lease mutations for client sessions owned by another caller", async () => {
    const coordinator = new PanelRuntimeCoordinator();
    const service = createPanelRuntimeService({ coordinator });
    const desktopCtx = { caller: createVerifiedCaller("shell:desktop", "shell") };
    const headlessCtx = { caller: createVerifiedCaller("shell:headless", "shell") };

    await service.handler(desktopCtx, "registerClient", [
      {
        clientSessionId: "desktop-session",
        hostConnectionId: "desktop-host",
        label: "Desktop",
        platform: "desktop",
      },
    ]);
    await service.handler(desktopCtx, "acquire", [
      "panel:nav-a",
      {
        slotId: "panel:tree/slot-a",
        clientSessionId: "desktop-session",
        connectionId: "desktop-runtime",
      },
    ]);

    await expect(
      service.handler(headlessCtx, "release", ["panel:nav-a", "desktop-runtime"])
    ).rejects.toMatchObject({
      code: "PANEL_RUNTIME_CLIENT_FORBIDDEN",
    });
    await expect(
      service.handler(headlessCtx, "unregisterClient", ["desktop-session"])
    ).rejects.toMatchObject({
      code: "PANEL_RUNTIME_CLIENT_FORBIDDEN",
    });
    await expect(
      service.handler(headlessCtx, "acquire", [
        "panel:nav-b",
        {
          slotId: "panel:tree/slot-b",
          clientSessionId: "desktop-session",
          connectionId: "headless-runtime",
        },
      ])
    ).rejects.toMatchObject({
      code: "PANEL_RUNTIME_CLIENT_FORBIDDEN",
    });
    await expect(
      service.handler(headlessCtx, "takeOver", [
        "panel:nav-a",
        {
          slotId: "panel:tree/slot-a",
          clientSessionId: "desktop-session",
          connectionId: "headless-runtime",
        },
      ])
    ).rejects.toMatchObject({
      code: "PANEL_RUNTIME_CLIENT_FORBIDDEN",
    });

    expect(coordinator.getLease("panel:nav-a")).toEqual(
      expect.objectContaining({
        clientSessionId: "desktop-session",
        connectionId: "desktop-runtime",
      })
    );
  });
});
