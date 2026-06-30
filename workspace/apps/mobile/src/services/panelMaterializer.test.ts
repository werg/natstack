import type { Panel } from "@natstack/shared/types";
import { materializeMobilePanel } from "./panelMaterializer";

const hostConfig = {
  protocol: "https",
  host: "natstack.example.com",
  port: "3000",
  basePath: "/_workspace/dev",
};

function makePanel(source: string): Panel {
  return {
    id: "panel-1",
    title: "Panel 1",
    children: [],
    snapshot: {
      source,
      contextId: "ctx-panel-1",
      options: {},
    },
    artifacts: { buildState: "ready" },
  };
}

function makeDeps(overrides?: {
  panelInit?: unknown;
  acquireResult?: { acquired: boolean; lease?: { holderLabel: string } };
}) {
  return {
    getPanelInit: jest.fn(async () => overrides?.panelInit ?? { entityId: "panel:nav-1" }),
    acquireLease: jest.fn(async () => overrides?.acquireResult ?? { acquired: true }),
    takeOverLease: jest.fn(async () => overrides?.acquireResult ?? { acquired: true }),
  };
}

describe("materializeMobilePanel", () => {
  it("acquires a mobile runtime lease for browser panels before returning the browser URL", async () => {
    const deps = makeDeps();

    const result = await materializeMobilePanel({
      panelId: "panel-1",
      panel: makePanel("browser:https://example.com/docs"),
      hostConfig,
      ...deps,
      leaseMode: "acquire",
    });

    expect(result).toEqual({
      panelId: "panel-1",
      url: "https://example.com/docs",
      managed: false,
      panelInit: null,
    });
    expect(deps.getPanelInit).toHaveBeenCalledWith("panel-1");
    expect(deps.acquireLease).toHaveBeenCalledWith("panel-1", "panel:nav-1", {
      connectionId: expect.stringMatching(/^mobile-panel-1-/),
    });
    expect(deps.takeOverLease).not.toHaveBeenCalled();
  });

  it("uses takeover mode when materializing browser panels during mobile takeover", async () => {
    const deps = makeDeps();

    await materializeMobilePanel({
      panelId: "panel-1",
      panel: makePanel("browser:https://example.com"),
      hostConfig,
      ...deps,
      leaseMode: "takeOver",
    });

    expect(deps.takeOverLease).toHaveBeenCalledWith("panel-1", "panel:nav-1", {
      connectionId: expect.stringMatching(/^mobile-panel-1-/),
    });
    expect(deps.acquireLease).not.toHaveBeenCalled();
  });

  it("rejects browser panel materialization when another client holds the lease", async () => {
    const deps = makeDeps({
      acquireResult: { acquired: false, lease: { holderLabel: "Desktop" } },
    });

    await expect(
      materializeMobilePanel({
        panelId: "panel-1",
        panel: makePanel("browser:https://example.com"),
        hostConfig,
        ...deps,
        leaseMode: "acquire",
      })
    ).rejects.toThrow("Panel panel-1 is running on Desktop");
  });

  it("keeps managed panel materialization payloads lease-bound", async () => {
    const deps = makeDeps({ panelInit: { entityId: "panel:nav-1", slotId: "panel-1" } });

    const result = await materializeMobilePanel({
      panelId: "panel-1",
      panel: makePanel("panels/editor"),
      hostConfig,
      ...deps,
      leaseMode: "acquire",
    });

    expect(result).toMatchObject({
      panelId: "panel-1",
      // Mobile serves panels through the local asset façade (127.0.0.1:<port>) over
      // the WebRTC pipe, not the remote host directly.
      url: "http://127.0.0.1:3000/_workspace/dev/panels/editor/?contextId=ctx-panel-1",
      managed: true,
      panelInit: {
        entityId: "panel:nav-1",
        slotId: "panel-1",
        clientLabel: "Mobile",
        connectionId: expect.stringMatching(/^mobile-panel-1-/),
      },
    });
  });
});
