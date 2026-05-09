import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelRegistry } from "../panelRegistry.js";
import { PanelManager } from "./panelManager.js";
import { PanelStoreMemory } from "./panelStoreMemory.js";

describe("PanelManager", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates panel state locally, builds panel init, updates state args, and closes panels", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    const panelDir = path.join(workspacePath, "panels", "example");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(path.join(panelDir, "package.json"), JSON.stringify({
      name: "example",
      natstack: {
        title: "Example Panel",
        stateArgs: {
          type: "object",
          properties: {
            greeting: { type: "string" },
          },
        },
      },
    }));

    const registry = new PanelRegistry({});
    const tokenClient = {
      ensurePanelToken: vi.fn(async (panelId: string) => ({
        token: `rpc-${panelId}`,
      })),
      revokePanelToken: vi.fn(async () => {}),
      updatePanelContext: vi.fn(async () => {}),
      updatePanelParent: vi.fn(async () => {}),
    };

    const manager = new PanelManager({
      store: new PanelStoreMemory(),
      registry,
      workspacePath,
      tokenClient,
      serverInfo: {
        gatewayConfig: { serverUrl: "http://127.0.0.1:42773" },
      },
    });

    const created = await manager.create("panels/example", {
      isRoot: true,
      addAsRoot: true,
      stateArgs: { greeting: "hello" },
    });

    expect(created.title).toBe("Example Panel");
    expect(registry.getRootPanels()).toHaveLength(1);
    expect(tokenClient.ensurePanelToken).toHaveBeenCalledWith(
      created.panelId,
      created.contextId,
      null,
      "panels/example",
    );

    const init = await manager.getPanelInit(created.panelId) as {
      panelId: string;
      contextId: string;
      sourceRepo: string;
      gatewayConfig: { serverUrl: string; token: string };
      stateArgs: Record<string, unknown>;
    };
    expect(init.panelId).toBe(created.panelId);
    expect(init.contextId).toBe(created.contextId);
    expect(init.sourceRepo).toBe("panels/example");
    expect(init.gatewayConfig).toEqual({
      serverUrl: "http://127.0.0.1:42773",
      token: `rpc-${created.panelId}`,
    });
    expect(init.stateArgs).toEqual({ greeting: "hello" });

    const nextStateArgs = await manager.updateStateArgs(created.panelId, { greeting: "updated" });
    expect(nextStateArgs).toEqual({ greeting: "updated" });
    expect(registry.getPanel(created.panelId)?.snapshot.stateArgs).toEqual({ greeting: "updated" });

    await manager.close(created.panelId);
    expect(tokenClient.revokePanelToken).toHaveBeenCalledWith(created.panelId);
    expect(registry.getPanel(created.panelId)).toBeUndefined();
  });

  it("builds remote bootstrap URLs with gateway-routed RPC and pubsub endpoints", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    const panelDir = path.join(workspacePath, "panels", "remote");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(path.join(panelDir, "package.json"), JSON.stringify({
      name: "remote",
      natstack: {
        title: "Remote Panel",
      },
    }));

    const manager = new PanelManager({
      store: new PanelStoreMemory(),
      registry: new PanelRegistry({}),
      workspacePath,
      tokenClient: {
        ensurePanelToken: vi.fn(async (panelId: string) => ({
          token: `rpc-${panelId}`,
        })),
        revokePanelToken: vi.fn(async () => {}),
        updatePanelContext: vi.fn(async () => {}),
        updatePanelParent: vi.fn(async () => {}),
      },
      serverInfo: {
        gatewayConfig: { serverUrl: "https://natstack.example.com" },
      },
    });

    const created = await manager.create("panels/remote", {
      isRoot: true,
      addAsRoot: true,
    });

    const init = await manager.getPanelInit(created.panelId) as {
      gatewayConfig: { serverUrl: string; token: string };
    };

    expect(init.gatewayConfig).toEqual({
      serverUrl: "https://natstack.example.com",
      token: `rpc-${created.panelId}`,
    });
  });
});
