import { createBridgeAdapter } from "./bridgeAdapter";

function createAdapter(overrides?: Parameters<typeof createBridgeAdapter>[0]) {
  return createBridgeAdapter({
    panelManager: {} as never,
    transport: {} as never,
    callbacks: { navigateToPanel: jest.fn() },
    ...overrides,
  });
}

describe("bridgeAdapter panel init", () => {
  it("uses the mobile panel init provider when available", async () => {
    const panelManager = { getPanelInit: jest.fn() };
    const getPanelInit = jest.fn(async () => ({ entityId: "panel:nav-a", connectionId: "conn-a" }));
    const adapter = createAdapter({
      panelManager: panelManager as never,
      transport: {} as never,
      callbacks: { navigateToPanel: jest.fn() },
      getPanelInit,
    });

    await expect(adapter.handle("panel:tree/panel-a", "getPanelInit", [])).resolves.toEqual({
      entityId: "panel:nav-a",
      connectionId: "conn-a",
    });
    expect(getPanelInit).toHaveBeenCalledWith("panel:tree/panel-a");
    expect(panelManager.getPanelInit).not.toHaveBeenCalled();
  });

  it("falls back to the panel manager init provider", async () => {
    const panelManager = { getPanelInit: jest.fn(async () => ({ entityId: "panel:nav-a" })) };
    const adapter = createAdapter({
      panelManager: panelManager as never,
      transport: {} as never,
      callbacks: { navigateToPanel: jest.fn() },
    });

    await expect(adapter.handle("panel:tree/panel-a", "getPanelInit", [])).resolves.toEqual({
      entityId: "panel:nav-a",
    });
    expect(panelManager.getPanelInit).toHaveBeenCalledWith("panel:tree/panel-a");
  });
});

describe("bridgeAdapter CDP routing", () => {
  it.each(["getCdpEndpoint", "navigate", "goBack", "goForward", "stop"] as const)(
    "rejects mobile CDP fast-path method %s",
    async (method) => {
      const adapter = createAdapter();

      await expect(
        adapter.handle("panel:tree/panel-a", method, ["panel:tree/panel-b"])
      ).rejects.toThrow("CDP automation is routed through the server broker");
    }
  );
});
