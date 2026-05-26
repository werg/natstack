import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PanelViewLike } from "@natstack/shared/panelInterfaces";
import {
  AppOrchestrator,
  ELECTRON_APP_HOST_CAPABILITIES,
  readBakedElectronApp,
} from "./appOrchestrator.js";

function createPanelView(): PanelViewLike {
  return {
    createViewForPanel: vi.fn(),
    createViewForApp: vi.fn(async () => {}),
    hasView: vi.fn(() => false),
    destroyView: vi.fn(),
    reloadView: vi.fn(() => false),
    navigateView: vi.fn(async () => {}),
    getWebContents: vi.fn(() => null),
    findViewIdByWebContentsId: vi.fn(() => null),
    setProtectedViews: vi.fn(),
    setViewVisible: vi.fn(),
  };
}

describe("AppOrchestrator", () => {
  it("rejects Electron apps that declare capabilities unsupported by this host", async () => {
    const panelView = createPanelView();
    const orchestrator = new AppOrchestrator({ getPanelView: () => panelView });

    await expect(
      orchestrator.applyAppAvailable({
        appId: "@workspace-apps/shell",
        target: "electron",
        url: "http://localhost/app",
        capabilities: ["notifications", "tray"],
      })
    ).rejects.toThrow(/unsupported host capabilities: tray/);

    expect(panelView.createViewForApp).not.toHaveBeenCalled();
  });

  it("loads Electron apps whose capabilities are implemented by this host", async () => {
    const panelView = createPanelView();
    const orchestrator = new AppOrchestrator({ getPanelView: () => panelView });

    await orchestrator.applyAppAvailable({
      appId: "@workspace-apps/shell",
      source: "apps/shell",
      target: "electron",
      url: "http://localhost/app",
      capabilities: ELECTRON_APP_HOST_CAPABILITIES,
      effectiveVersion: "ev-shell",
    });

    expect(panelView.createViewForApp).toHaveBeenCalledWith(
      "@workspace-apps/shell",
      "http://localhost/app",
      undefined,
      ELECTRON_APP_HOST_CAPABILITIES,
      {
        source: "apps/shell",
        effectiveVersion: "ev-shell",
      }
    );
    expect(panelView.setViewVisible).toHaveBeenCalledWith("@workspace-apps/shell", true);
  });

  it("queues desktop app updates instead of navigating an already loaded app view", async () => {
    const panelView = createPanelView();
    (panelView.hasView as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const orchestrator = new AppOrchestrator({ getPanelView: () => panelView });

    await orchestrator.applyAppAvailable({
      appId: "@workspace-apps/shell",
      source: "apps/shell",
      target: "electron",
      url: "http://localhost/app-v1",
      buildKey: "build-1",
      capabilities: ["panel-hosting"],
      adoptionPolicy: "immediate",
    });
    await orchestrator.applyAppAvailable({
      appId: "@workspace-apps/shell",
      source: "apps/shell",
      target: "electron",
      url: "http://localhost/app-v2",
      buildKey: "build-2",
      capabilities: ["panel-hosting"],
      adoptionPolicy: "prompt",
    });

    expect(panelView.createViewForApp).toHaveBeenCalledTimes(1);
    expect(orchestrator.listPendingAppUpdates()).toMatchObject([
      { appId: "@workspace-apps/shell", buildKey: "build-2" },
    ]);

    await expect(orchestrator.applyPendingAppUpdate("@workspace-apps/shell")).resolves.toBe(true);
    expect(panelView.createViewForApp).toHaveBeenCalledTimes(2);
    expect(panelView.createViewForApp).toHaveBeenLastCalledWith(
      "@workspace-apps/shell",
      "http://localhost/app-v2",
      undefined,
      ["panel-hosting"],
      {
        source: "apps/shell",
        effectiveVersion: undefined,
      }
    );
    expect(orchestrator.listPendingAppUpdates()).toEqual([]);
  });

  it("persists pending desktop app updates across orchestrator restarts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-app-updates-"));
    try {
      const panelView = createPanelView();
      (panelView.hasView as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const orchestrator = new AppOrchestrator({ getPanelView: () => panelView, statePath: root });

      await orchestrator.applyAppAvailable({
        appId: "@workspace-apps/shell",
        source: "apps/shell",
        target: "electron",
        url: "http://localhost/app-v1",
        buildKey: "build-1",
        adoptionPolicy: "immediate",
      });
      await orchestrator.applyAppAvailable({
        appId: "@workspace-apps/shell",
        source: "apps/shell",
        target: "electron",
        url: "http://localhost/app-v2",
        buildKey: "build-2",
        adoptionPolicy: "prompt",
      });

      const restarted = new AppOrchestrator({ getPanelView: () => panelView, statePath: root });
      expect(restarted.listPendingAppUpdates()).toMatchObject([
        { appId: "@workspace-apps/shell", buildKey: "build-2" },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores terminal app process availability for desktop view adoption", async () => {
    const panelView = createPanelView();
    const orchestrator = new AppOrchestrator({ getPanelView: () => panelView });

    await orchestrator.applyAppAvailable({
      appId: "@workspace-apps/remote-cli",
      target: "terminal",
      url: "http://localhost/app.mjs",
      adoptionPolicy: "immediate",
    });

    expect(panelView.createViewForApp).not.toHaveBeenCalled();
  });

  it("reads and mounts packaged baked Electron app payloads", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-baked-app-"));
    try {
      fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
      fs.writeFileSync(path.join(root, "artifacts", "index.html"), "<html></html>");
      fs.writeFileSync(
        path.join(root, "manifest.json"),
        JSON.stringify({
          version: 1,
          app: {
            name: "@workspace-apps/shell",
            source: "apps/shell",
            target: "electron",
            capabilities: ["notifications"],
          },
          build: { effectiveVersion: "ev-shell" },
          artifacts: [{ path: "index.html", role: "html" }],
        })
      );
      const panelView = createPanelView();
      const orchestrator = new AppOrchestrator({ getPanelView: () => panelView });

      expect(readBakedElectronApp(root)).toMatchObject({
        appId: "@workspace-apps/shell",
        source: "apps/shell",
        target: "electron",
        capabilities: ["notifications"],
        effectiveVersion: "ev-shell",
      });
      await expect(orchestrator.loadBakedApp(root)).resolves.toBe(true);

      expect(panelView.createViewForApp).toHaveBeenCalledWith(
        "@workspace-apps/shell",
        expect.stringMatching(/^file:.*index\.html$/),
        undefined,
        ["notifications"],
        {
          source: "apps/shell",
          effectiveVersion: "ev-shell",
        }
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
