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
        gitToken: `git-${panelId}`,
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
        protocol: "http",
        externalHost: "localhost",
        gatewayPort: 42773,
        rpcPort: 49352,
        workerdPort: 49562,
        gitBaseUrl: "http://127.0.0.1:56049",
        rpcWsUrl: "ws://127.0.0.1:49352",
        pubsubUrl: "ws://127.0.0.1:49562/_w/workers/pubsub-channel/PubSubChannel",
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
      rpcHost: string;
      rpcPort: number;
      rpcWsUrl: string;
      rpcToken: string;
      contextId: string;
      gitConfig: { serverUrl: string; token: string; sourceRepo: string };
      pubsubConfig: { serverUrl: string; token: string };
      stateArgs: Record<string, unknown>;
    };
    expect(init.panelId).toBe(created.panelId);
    expect(init.rpcHost).toBe("127.0.0.1");
    expect(init.rpcPort).toBe(49352);
    expect(init.rpcWsUrl).toBe("ws://127.0.0.1:49352");
    expect(init.rpcToken).toBe(`rpc-${created.panelId}`);
    expect(init.contextId).toBe(created.contextId);
    expect(init.gitConfig).toEqual({
      serverUrl: "http://127.0.0.1:56049",
      token: `git-${created.panelId}`,
      sourceRepo: "panels/example",
    });
    expect(init.pubsubConfig).toEqual({
      serverUrl: "ws://127.0.0.1:49562/_w/workers/pubsub-channel/PubSubChannel",
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
          gitToken: `git-${panelId}`,
        })),
        revokePanelToken: vi.fn(async () => {}),
        updatePanelContext: vi.fn(async () => {}),
        updatePanelParent: vi.fn(async () => {}),
      },
      serverInfo: {
        protocol: "https",
        externalHost: "natstack.example.com",
        gatewayPort: 443,
        rpcPort: 443,
        workerdPort: 443,
        gitBaseUrl: "https://natstack.example.com/_git",
        rpcWsUrl: "wss://natstack.example.com/rpc",
        pubsubUrl: "wss://natstack.example.com/_w/workers/pubsub-channel/PubSubChannel",
      },
    });

    const created = await manager.create("panels/remote", {
      isRoot: true,
      addAsRoot: true,
    });

    const init = await manager.getPanelInit(created.panelId) as {
      rpcHost: string;
      rpcPort: number;
      rpcWsUrl: string;
      pubsubConfig: { serverUrl: string; token: string };
    };

    expect(init.rpcHost).toBe("natstack.example.com");
    expect(init.rpcPort).toBe(443);
    expect(init.rpcWsUrl).toBe("wss://natstack.example.com/rpc");
    expect(init.pubsubConfig).toEqual({
      serverUrl: "wss://natstack.example.com/_w/workers/pubsub-channel/PubSubChannel",
      token: `rpc-${created.panelId}`,
    });
  });
});
