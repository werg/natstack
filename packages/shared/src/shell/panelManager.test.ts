import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelRegistry } from "../panelRegistry.js";
import { getCurrentSnapshot } from "../panel/accessors.js";
import { PanelManager } from "./panelManager.js";
import type { Panel, PanelSnapshot } from "../types.js";
import type { SubmittedPanelOp } from "../panelOpsTypes.js";

function createWorkspaceSyncMemory() {
  const panels = new Map<string, Panel & { parentId: string | null; archived?: boolean }>();
  let revision = 0;
  const buildTree = (): Panel[] => {
    const clones = new Map<string, Panel>();
    for (const panel of panels.values()) {
      if (panel.archived) continue;
      clones.set(panel.id, {
        id: panel.id,
        title: panel.title,
        positionId: panel.positionId,
        snapshot: panel.snapshot,
        history: panel.history,
        artifacts: panel.artifacts,
        children: [],
      });
    }
    const roots: Panel[] = [];
    for (const panel of panels.values()) {
      if (panel.archived) continue;
      const clone = clones.get(panel.id);
      if (!clone) continue;
      if (panel.parentId && clones.has(panel.parentId)) {
        clones.get(panel.parentId)!.children.push(clone);
      } else {
        roots.push(clone);
      }
    }
    const sortByPosition = (items: Panel[]) => {
      items.sort((a, b) => (a.positionId ?? "").localeCompare(b.positionId ?? ""));
      for (const item of items) sortByPosition(item.children);
    };
    sortByPosition(roots);
    return roots;
  };
  const apply = (op: SubmittedPanelOp) => {
    switch (op.type) {
      case "panel.create":
        panels.set(op.panelId, {
          id: op.panelId,
          title: op.title,
          parentId: op.parentId,
          positionId: op.positionId,
          snapshot: op.snapshot,
          history: { entries: [op.snapshot], index: 0 },
          artifacts: {},
          children: [],
        });
        break;
      case "panel.archive":
        {
          const archiveSubtree = (panelId: string) => {
            const panel = panels.get(panelId);
            if (!panel) return;
            panel.archived = true;
            for (const child of panels.values()) {
              if (child.parentId === panelId) archiveSubtree(child.id);
            }
          };
          archiveSubtree(op.panelId);
        }
        break;
      case "panel.move":
        {
          const panel = panels.get(op.panelId);
          if (panel) {
            panel.parentId = op.parentId;
            panel.positionId = op.positionId;
          }
        }
        break;
      case "panel.setTitle":
        {
          const panel = panels.get(op.panelId);
          if (panel) panel.title = op.title;
        }
        break;
      case "panel.setSnapshot":
        {
          const panel = panels.get(op.panelId);
          if (panel) {
            panel.snapshot = op.snapshot;
            panel.history = op.history ?? { entries: [op.snapshot], index: 0 };
          }
        }
        break;
      case "panel.restore":
        {
          const panel = panels.get(op.panelId);
          if (panel) panel.archived = false;
        }
        break;
    }
  };
  return {
    panels,
    sync: {
      async getSnapshot() {
        return { tree: buildTree(), revision };
      },
      async getOpsSince() {
        return { ops: [], revision };
      },
      async submitOps(_baseRevision: number, ops: SubmittedPanelOp[]) {
        for (const op of ops) {
          apply(op);
          revision++;
        }
        return { acceptedOps: ops.map((op) => op.opId), rejectedOps: [], revision };
      },
    },
  };
}

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

    const workspace = createWorkspaceSyncMemory();
    const manager = new PanelManager({
      workspaceSync: workspace.sync,
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
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!).stateArgs).toEqual({ greeting: "updated" });

    const clearedStateArgs = await manager.updateStateArgs(created.panelId, { greeting: null });
    expect(clearedStateArgs).toEqual({});
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!).stateArgs).toEqual({});

    await manager.close(created.panelId);
    expect(tokenClient.revokePanelToken).toHaveBeenCalledWith(created.panelId);
    expect(registry.getPanel(created.panelId)).toBeUndefined();
  });

  it("removes closed panels from the tree even if token cleanup fails", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    const panelDir = path.join(workspacePath, "panels", "cleanup");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(path.join(panelDir, "package.json"), JSON.stringify({
      name: "cleanup",
      natstack: {
        title: "Cleanup Panel",
      },
    }));

    const registry = new PanelRegistry({});
    const workspace = createWorkspaceSyncMemory();
    const tokenClient = {
      ensurePanelToken: vi.fn(async (panelId: string) => ({
        token: `rpc-${panelId}`,
      })),
      revokePanelToken: vi.fn(async () => {
        throw new Error("token cleanup failed");
      }),
      updatePanelContext: vi.fn(async () => {}),
      updatePanelParent: vi.fn(async () => {}),
    };

    const manager = new PanelManager({
      workspaceSync: workspace.sync,
      registry,
      workspacePath,
      tokenClient,
      serverInfo: {
        gatewayConfig: { serverUrl: "http://127.0.0.1:42773" },
      },
    });

    const created = await manager.create("panels/cleanup", {
      isRoot: true,
      addAsRoot: true,
    });

    await expect(manager.close(created.panelId)).resolves.toEqual({ closedIds: [created.panelId] });
    expect(workspace.panels.get(created.panelId)?.archived).toBe(true);
    expect(registry.getPanel(created.panelId)).toBeUndefined();
    expect(registry.getRootPanels()).toHaveLength(0);
    expect(tokenClient.revokePanelToken).toHaveBeenCalledWith(created.panelId);
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
      workspaceSync: createWorkspaceSyncMemory().sync,
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

  it("pushes current-panel navigation into snapshot history and traverses it", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    for (const name of ["first", "second"]) {
      const panelDir = path.join(workspacePath, "panels", name);
      fs.mkdirSync(panelDir, { recursive: true });
      fs.writeFileSync(path.join(panelDir, "package.json"), JSON.stringify({
        name,
        natstack: { title: `${name} Panel` },
      }));
    }

    const registry = new PanelRegistry({});
    const manager = new PanelManager({
      workspaceSync: createWorkspaceSyncMemory().sync,
      registry,
      workspacePath,
      tokenClient: {
        ensurePanelToken: vi.fn(async (panelId: string) => ({ token: `rpc-${panelId}` })),
        revokePanelToken: vi.fn(async () => {}),
        updatePanelContext: vi.fn(async () => {}),
        updatePanelParent: vi.fn(async () => {}),
      },
      serverInfo: {
        gatewayConfig: { serverUrl: "http://127.0.0.1:42773" },
      },
    });

    const created = await manager.create("panels/first", {
      isRoot: true,
      addAsRoot: true,
    });

    await manager.navigate(created.panelId, "panels/second", { ref: "feature" });
    const afterNavigate = registry.getPanel(created.panelId)!;
    expect(getCurrentSnapshot(afterNavigate).source).toBe("panels/second");
    expect(getCurrentSnapshot(afterNavigate).options.ref).toBe("feature");
    expect(afterNavigate.history?.entries.map((entry) => entry.source)).toEqual(["panels/first", "panels/second"]);
    expect(afterNavigate.history?.index).toBe(1);

    await manager.navigateHistory(created.panelId, -1);
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!).source).toBe("panels/first");
    expect(registry.getPanel(created.panelId)?.history?.index).toBe(0);

    await manager.navigateHistory(created.panelId, 1);
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!).source).toBe("panels/second");
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!).options.ref).toBe("feature");
  });

  it("keeps selected descendant path local while using collision-free sibling ranks", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    for (const name of ["root", "first", "second"]) {
      const panelDir = path.join(workspacePath, "panels", name);
      fs.mkdirSync(panelDir, { recursive: true });
      fs.writeFileSync(path.join(panelDir, "package.json"), JSON.stringify({
        name,
        natstack: { title: `${name} Panel` },
      }));
    }

    const registry = new PanelRegistry({});
    const workspace = createWorkspaceSyncMemory();
    const manager = new PanelManager({
      workspaceSync: workspace.sync,
      registry,
      workspacePath,
      tokenClient: {
        ensurePanelToken: vi.fn(async (panelId: string) => ({ token: `rpc-${panelId}` })),
        revokePanelToken: vi.fn(async () => {}),
        updatePanelContext: vi.fn(async () => {}),
        updatePanelParent: vi.fn(async () => {}),
      },
      serverInfo: {
        gatewayConfig: { serverUrl: "http://127.0.0.1:42773" },
      },
    });

    const root = await manager.create("panels/root", { isRoot: true, addAsRoot: true });
    const first = await manager.create("panels/first", { parentId: root.panelId });
    const second = await manager.create("panels/second", { parentId: root.panelId });

    expect(registry.getPanel(root.panelId)?.children.map((child) => child.id)).toEqual([
      second.panelId,
      first.panelId,
    ]);

    await manager.notifyFocused(first.panelId);
    expect(workspace.panels.get(root.panelId)?.selectedChildId).toBeUndefined();
    expect(registry.getPanel(root.panelId)?.selectedChildId).toBe(first.panelId);

    await manager.syncSnapshot();
    expect(registry.getPanel(root.panelId)?.selectedChildId).toBe(first.panelId);
  });

  it("does not leak selected descendant path between shell clients sharing a workspace", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    for (const name of ["root", "first", "second"]) {
      const panelDir = path.join(workspacePath, "panels", name);
      fs.mkdirSync(panelDir, { recursive: true });
      fs.writeFileSync(path.join(panelDir, "package.json"), JSON.stringify({
        name,
        natstack: { title: `${name} Panel` },
      }));
    }

    const workspace = createWorkspaceSyncMemory();
    const makeManager = (registry: PanelRegistry) => new PanelManager({
      workspaceSync: workspace.sync,
      registry,
      workspacePath,
      tokenClient: {
        ensurePanelToken: vi.fn(async (panelId: string) => ({ token: `rpc-${panelId}` })),
        revokePanelToken: vi.fn(async () => {}),
        updatePanelContext: vi.fn(async () => {}),
        updatePanelParent: vi.fn(async () => {}),
      },
      serverInfo: {
        gatewayConfig: { serverUrl: "http://127.0.0.1:42773" },
      },
    });

    const registryA = new PanelRegistry({});
    const managerA = makeManager(registryA);
    const root = await managerA.create("panels/root", { isRoot: true, addAsRoot: true });
    const first = await managerA.create("panels/first", { parentId: root.panelId });
    const second = await managerA.create("panels/second", { parentId: root.panelId });

    const registryB = new PanelRegistry({});
    const managerB = makeManager(registryB);
    await managerB.syncSnapshot();

    await managerA.notifyFocused(first.panelId);
    await managerB.notifyFocused(second.panelId);

    expect(registryA.getPanel(root.panelId)?.selectedChildId).toBe(first.panelId);
    expect(registryB.getPanel(root.panelId)?.selectedChildId).toBe(second.panelId);
    expect(workspace.panels.get(root.panelId)?.selectedChildId).toBeUndefined();

    await managerA.syncSnapshot();
    await managerB.syncSnapshot();

    expect(registryA.getPanel(root.panelId)?.selectedChildId).toBe(first.panelId);
    expect(registryB.getPanel(root.panelId)?.selectedChildId).toBe(second.panelId);
  });

  it("restores persisted panel navigation history after a fresh manager sync", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    for (const name of ["first", "second"]) {
      const panelDir = path.join(workspacePath, "panels", name);
      fs.mkdirSync(panelDir, { recursive: true });
      fs.writeFileSync(path.join(panelDir, "package.json"), JSON.stringify({
        name,
        natstack: { title: `${name} Panel` },
      }));
    }

    const workspace = createWorkspaceSyncMemory();
    const makeManager = (registry: PanelRegistry) => new PanelManager({
      workspaceSync: workspace.sync,
      registry,
      workspacePath,
      tokenClient: {
        ensurePanelToken: vi.fn(async (panelId: string) => ({ token: `rpc-${panelId}` })),
        revokePanelToken: vi.fn(async () => {}),
        updatePanelContext: vi.fn(async () => {}),
        updatePanelParent: vi.fn(async () => {}),
      },
      serverInfo: {
        gatewayConfig: { serverUrl: "http://127.0.0.1:42773" },
      },
    });

    const managerA = makeManager(new PanelRegistry({}));
    const created = await managerA.create("panels/first", { isRoot: true, addAsRoot: true });
    await managerA.navigate(created.panelId, "panels/second");

    const registryAfterRestart = new PanelRegistry({});
    const managerAfterRestart = makeManager(registryAfterRestart);
    await managerAfterRestart.syncSnapshot();

    expect(getCurrentSnapshot(registryAfterRestart.getPanel(created.panelId)!).source).toBe("panels/second");
    await managerAfterRestart.navigateHistory(created.panelId, -1);
    expect(getCurrentSnapshot(registryAfterRestart.getPanel(created.panelId)!).source).toBe("panels/first");
  });

  it("closes parent subtrees with one workspace archive op and cleans every token", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    for (const name of ["root", "child"]) {
      const panelDir = path.join(workspacePath, "panels", name);
      fs.mkdirSync(panelDir, { recursive: true });
      fs.writeFileSync(path.join(panelDir, "package.json"), JSON.stringify({
        name,
        natstack: { title: `${name} Panel` },
      }));
    }

    const workspace = createWorkspaceSyncMemory();
    const registry = new PanelRegistry({});
    const tokenClient = {
      ensurePanelToken: vi.fn(async (panelId: string) => ({ token: `rpc-${panelId}` })),
      revokePanelToken: vi.fn(async () => {}),
      updatePanelContext: vi.fn(async () => {}),
      updatePanelParent: vi.fn(async () => {}),
    };
    const manager = new PanelManager({
      workspaceSync: workspace.sync,
      registry,
      workspacePath,
      tokenClient,
      serverInfo: {
        gatewayConfig: { serverUrl: "http://127.0.0.1:42773" },
      },
    });

    const root = await manager.create("panels/root", { isRoot: true, addAsRoot: true });
    const child = await manager.create("panels/child", { parentId: root.panelId });

    await expect(manager.close(root.panelId)).resolves.toEqual({
      closedIds: [root.panelId, child.panelId],
    });
    expect(workspace.panels.get(root.panelId)?.archived).toBe(true);
    expect(workspace.panels.get(child.panelId)?.archived).toBe(true);
    expect(registry.getPanel(root.panelId)).toBeUndefined();
    expect(registry.getPanel(child.panelId)).toBeUndefined();
    expect(tokenClient.revokePanelToken).toHaveBeenCalledWith(root.panelId);
    expect(tokenClient.revokePanelToken).toHaveBeenCalledWith(child.panelId);
  });
});
