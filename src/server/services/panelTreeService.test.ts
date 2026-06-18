import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { PANEL_STRUCTURAL_CAPABILITY } from "@natstack/shared/panelAccessPolicy";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { createPanelTreeService } from "./panelTreeService.js";
import type { ApprovalQueue } from "./approvalQueue.js";

function tempStatePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-tree-"));
}

function approvalQueueMock(
  decision: Awaited<ReturnType<ApprovalQueue["request"]>> = "session"
): ApprovalQueue {
  return {
    request: vi.fn(async () => decision),
    requestClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
    requestCredentialInput: vi.fn(async () => ({ decision: "deny" as const })),
    requestUserland: vi.fn(async () => ({ kind: "dismissed" as const })),
    presentDeviceCode: vi.fn(() => ({
      approvalId: "device-code-test",
      cancelled: new AbortController().signal,
      dispose: vi.fn(),
    })),
    resolve: vi.fn(),
    resolveUserland: vi.fn(),
    submitClientConfig: vi.fn(),
    submitCredentialInput: vi.fn(),
    listPending: vi.fn(() => []),
    cancelForCaller: vi.fn(),
  };
}

function ctx() {
  return {
    caller: createVerifiedCaller("panel:requester", "panel", {
      callerId: "panel:requester",
      callerKind: "panel",
      repoPath: "panels/requester",
      effectiveVersion: "v1",
    }),
  };
}

describe("panelTreeService", () => {
  it("is exposed to userland runtimes and trusted shell/server hosts", () => {
    const service = createPanelTreeService({
      approvalQueue: approvalQueueMock("deny"),
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      bridge: vi.fn(),
    });

    // shell/shell-remote/server are trusted chrome (desktop routes via the
    // electron-main serverClient as "server"; mobile routes via its transport).
    expect(service.policy).toEqual({
      allowed: ["panel", "worker", "do", "shell", "shell-remote", "server"],
    });
  });

  it("delegates open list operations without approval", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const bridge = vi.fn(async () => [{ panelId: "panel-1" }]);
    const service = createPanelTreeService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      bridge,
    });

    await expect(service.handler(ctx(), "list", [null])).resolves.toEqual([{ panelId: "panel-1" }]);

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "list",
      args: [null],
    });
  });

  it("delegates root listing without approval", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const bridge = vi.fn(async () => [{ panelId: "root-1" }]);
    const service = createPanelTreeService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      bridge,
    });

    await expect(service.handler(ctx(), "roots", [])).resolves.toEqual([{ panelId: "root-1" }]);

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "roots",
      args: [],
    });
  });

  it("delegates ensureLoaded without rewriting it to focus", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const bridge = vi.fn(async () => ({ loaded: true }));
    const service = createPanelTreeService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      bridge,
    });

    await expect(service.handler(ctx(), "ensureLoaded", ["target"])).resolves.toEqual({
      loaded: true,
    });

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "ensureLoaded",
      args: ["target"],
    });
  });

  it("approval-gates structural operations before delegating", async () => {
    const approvalQueue = approvalQueueMock("once");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? { id: "target", title: "Target", source: "panels/target" }
        : undefined
    );
    const service = createPanelTreeService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      bridge,
    });

    await expect(service.handler(ctx(), "close", ["target"])).resolves.toBeUndefined();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: PANEL_STRUCTURAL_CAPABILITY,
        title: "Close panel",
      })
    );
    expect(bridge).toHaveBeenLastCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "close",
      args: ["target"],
    });
  });

  it("remembers structural approvals separately from automation grants", async () => {
    const approvalQueue = approvalQueueMock("version");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? { id: "target", title: "Target", source: "panels/target" }
        : undefined
    );
    const service = createPanelTreeService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      bridge,
    });

    await service.handler(ctx(), "close", ["target"]);
    await service.handler(ctx(), "close", ["target"]);

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: PANEL_STRUCTURAL_CAPABILITY,
        grantResourceKey: "panel:target:requester:panel:requester",
      })
    );
  });

  it("delegates panel creation under the requested parent without approval", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const bridge = vi.fn(async (request: { method: string; args: unknown[] }) =>
      request.method === "metadata"
        ? { id: request.args[0] as string, title: "Parent", source: "panels/parent" }
        : { id: "created", title: "Created", kind: "workspace" }
    );
    const service = createPanelTreeService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      bridge,
    });

    await expect(
      service.handler(ctx(), "create", ["panels/child", { parentId: "parent" }])
    ).resolves.toEqual({ id: "created", title: "Created", kind: "workspace" });

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(bridge).toHaveBeenCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "create",
      args: ["panels/child", { parentId: "parent" }],
    });
  });

  it("delegates implicit child panel creation without resolving parent metadata for approval", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const resolveRequesterPanel = vi.fn(async () => ({
      id: "requester-slot",
      title: "Requester Panel",
      source: "panels/requester",
    }));
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "create" ? { id: "created", title: "Created", kind: "workspace" } : null
    );
    const service = createPanelTreeService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      resolveRequesterPanel,
      bridge,
    });

    await expect(service.handler(ctx(), "create", ["panels/child", {}])).resolves.toEqual({
      id: "created",
      title: "Created",
      kind: "workspace",
    });

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(resolveRequesterPanel).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it("does not delegate structural operations when approval is denied", async () => {
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata" ? { id: "target", title: "Target" } : undefined
    );
    const service = createPanelTreeService({
      approvalQueue: approvalQueueMock("deny"),
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      bridge,
    });

    await expect(
      service.handler(ctx(), "setStateArgs", ["target", { mode: "edit" }])
    ).rejects.toThrow("stateArgs.set denied for panel target");

    expect(bridge).toHaveBeenCalledTimes(1);
    expect(bridge).toHaveBeenCalledWith(
      expect.objectContaining({ method: "metadata", args: ["target"] })
    );
  });

  it("lets a panel set its own stateArgs without approval", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? {
            id: "requester-slot",
            title: "Requester",
            source: "panels/requester",
            runtimeEntityId: "panel:requester",
          }
        : { mode: "edit" }
    );
    const service = createPanelTreeService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      resolveRequesterPanel: vi.fn(async () => ({
        id: "requester-slot",
        runtimeEntityId: "panel:requester",
      })),
      bridge,
    });

    await expect(
      service.handler(ctx(), "setStateArgs", ["requester-slot", { mode: "edit" }])
    ).resolves.toEqual({ mode: "edit" });

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenLastCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "setStateArgs",
      args: ["requester-slot", { mode: "edit" }],
    });
  });

  it("lets a panel navigate itself without approval", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? {
            id: "requester-slot",
            title: "Requester",
            source: "panels/requester",
            runtimeEntityId: "panel:requester",
          }
        : { id: "requester-slot", title: "Vault" }
    );
    const service = createPanelTreeService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      resolveRequesterPanel: vi.fn(async () => ({
        id: "requester-slot",
        runtimeEntityId: "panel:requester",
      })),
      bridge,
    });

    await expect(
      service.handler(ctx(), "navigate", [
        "requester-slot",
        "panels/spectrolite",
        { contextId: "ctx-vault", stateArgs: { repoRoot: "/repo" } },
      ])
    ).resolves.toEqual({ id: "requester-slot", title: "Vault" });

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenLastCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "navigate",
      args: [
        "requester-slot",
        "panels/spectrolite",
        { contextId: "ctx-vault", stateArgs: { repoRoot: "/repo" } },
      ],
    });
  });

  it("approval-gates navigating another panel as structural replacement", async () => {
    const approvalQueue = approvalQueueMock("once");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? { id: "target", title: "Target", source: "panels/target" }
        : { id: "target", title: "Next" }
    );
    const service = createPanelTreeService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      bridge,
    });

    await expect(
      service.handler(ctx(), "navigate", ["target", "panels/next", { contextId: "ctx-next" }])
    ).resolves.toEqual({ id: "target", title: "Next" });

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: PANEL_STRUCTURAL_CAPABILITY,
        title: "Navigate panel",
        description: "Allow this requester to navigate Target to another panel source or context.",
      })
    );
    expect(bridge).toHaveBeenLastCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "navigate",
      args: ["target", "panels/next", { contextId: "ctx-next" }],
    });
  });

  it("approval-gates object-shaped structural operations by target panel id", async () => {
    const approvalQueue = approvalQueueMock("session");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata" ? { id: "target", title: "Target" } : undefined
    );
    const service = createPanelTreeService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      bridge,
    });

    await expect(
      service.handler(ctx(), "movePanel", [
        { panelId: "target", newParentId: null, targetPosition: 0 },
      ])
    ).resolves.toBeUndefined();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: PANEL_STRUCTURAL_CAPABILITY,
        title: "Move panel",
      })
    );
    expect(bridge).toHaveBeenLastCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "movePanel",
      args: [{ panelId: "target", newParentId: null, targetPosition: 0 }],
    });
  });

  it("uses operation-specific approval copy for structural host operations", async () => {
    const approvalQueue = approvalQueueMock("once");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata" ? { id: "target", title: "Target" } : undefined
    );
    const service = createPanelTreeService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      bridge,
    });

    await expect(service.handler(ctx(), "takeOver", ["target"])).resolves.toBeUndefined();
    await expect(
      service.handler(ctx(), "openDevTools", ["target", "detach"])
    ).resolves.toBeUndefined();
    await expect(service.handler(ctx(), "rebuildPanel", ["target"])).resolves.toBeUndefined();

    expect(approvalQueue.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        title: "Take over panel",
        description: "Allow this requester to take over hosting for Target.",
      })
    );
    expect(approvalQueue.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        title: "Open panel DevTools",
        description: "Allow this requester to open DevTools for Target.",
      })
    );
    expect(approvalQueue.request).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        title: "Rebuild panel",
        description: "Allow this requester to rebuild Target.",
      })
    );
  });

  it("uses specific approval copy for rebuild-and-reload", async () => {
    const approvalQueue = approvalQueueMock("once");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata" ? { id: "target", title: "Target" } : undefined
    );
    const service = createPanelTreeService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      bridge,
    });

    await expect(service.handler(ctx(), "rebuildAndReload", ["target"])).resolves.toBeUndefined();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Rebuild and reload panel",
        description: "Allow this requester to rebuild and reload Target.",
      })
    );
  });

  it("leaves read-only built-in agent introspection open", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const bridge = vi.fn(async () => ({ ok: true }));
    const service = createPanelTreeService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      bridge,
    });

    await expect(
      service.handler(ctx(), "callAgent", ["target", "_agent.tree", []])
    ).resolves.toEqual({
      ok: true,
    });

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "callAgent",
      args: ["target", "_agent.tree", []],
    });
  });

  it("approval-gates agent mode changes as structural state changes", async () => {
    const approvalQueue = approvalQueueMock("session");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata" ? { id: "target", title: "Target" } : { mode: "fixture" }
    );
    const service = createPanelTreeService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      bridge,
    });

    await expect(
      service.handler(ctx(), "callAgent", ["target", "_agent.setMode", ["fixture"]])
    ).resolves.toEqual({
      mode: "fixture",
    });

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: PANEL_STRUCTURAL_CAPABILITY,
        title: "Change panel state",
        grantResourceKey: "panel:target:requester:panel:requester",
      })
    );
  });

  it("rejects arbitrary userland agent calls outside the built-in handle surface", async () => {
    const bridge = vi.fn(async () => ({ ok: true }));
    const service = createPanelTreeService({
      approvalQueue: approvalQueueMock("session"),
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      bridge,
    });

    await expect(
      service.handler(ctx(), "callAgent", ["target", "custom.method", []])
    ).rejects.toThrow("Unknown panel agent method: custom.method");

    expect(bridge).not.toHaveBeenCalled();
  });
});
