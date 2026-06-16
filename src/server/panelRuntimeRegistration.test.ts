import { describe, expect, it, vi } from "vitest";
import {
  cdpDefaultHostAssignmentError,
  createServerPanelTreeBridge,
  panelHostCommandAssignmentError,
  resolveImplicitCreateParentId,
  snapshotBrowserPanelFromCdpBridge,
} from "./panelRuntimeRegistration.js";

describe("resolveImplicitCreateParentId", () => {
  it("uses an explicit parent id when provided", () => {
    const parentId = resolveImplicitCreateParentId({
      explicitParentId: "slot-explicit",
      callerId: "panel:entity-caller",
      callerKind: "panel",
      getCallerLeaseSlotId: () => "slot-caller",
      hasPanel: (panelId) => panelId === "slot-explicit",
    });

    expect(parentId).toBe("slot-explicit");
  });

  it("maps panel caller runtime entity ids to their leased slot for implicit parents", () => {
    const parentId = resolveImplicitCreateParentId({
      callerId: "panel:entity-caller",
      callerKind: "panel",
      getCallerLeaseSlotId: () => "slot-caller",
      hasPanel: (panelId) => panelId === "slot-caller",
    });

    expect(parentId).toBe("slot-caller");
  });

  it("does not invent an implicit parent for non-panel callers", () => {
    const parentId = resolveImplicitCreateParentId({
      callerId: "worker-1",
      callerKind: "worker",
      getCallerLeaseSlotId: () => "slot-caller",
      hasPanel: (panelId) => panelId === "slot-caller",
    });

    expect(parentId).toBeUndefined();
  });
});

describe("cdpDefaultHostAssignmentError", () => {
  it("classifies non-CDP mobile holders distinctly", () => {
    const error = cdpDefaultHostAssignmentError("slot-mobile", "mobile_held") as Error & {
      code?: string;
    };

    expect(error.message).toBe(
      "CDP is unavailable while panel slot-mobile is held by a non-CDP host"
    );
    expect(error.code).toBe("cdp_unavailable_mobile_held");
  });

  it("classifies missing default CDP hosts without waiting for provider readiness", () => {
    const error = cdpDefaultHostAssignmentError("slot-a", "no_default_cdp_host") as Error & {
      code?: string;
    };

    expect(error.message).toBe("No CDP-capable host is available for panel: slot-a");
    expect(error.code).toBe("cdp_no_default_host");
  });

  it("does not fail when the slot is already held by a CDP-capable host", () => {
    expect(cdpDefaultHostAssignmentError("slot-a", "already_held")).toBeNull();
  });
});

describe("panelHostCommandAssignmentError", () => {
  it("classifies mobile-held structural host commands distinctly", () => {
    const error = panelHostCommandAssignmentError("slot-mobile", "mobile_held") as Error & {
      code?: string;
    };

    expect(error.message).toBe("Panel slot-mobile is held by a non-CDP host");
    expect(error.code).toBe("panel_host_command_unavailable_mobile_held");
  });

  it("classifies missing default CDP hosts without waiting for provider readiness", () => {
    const error = panelHostCommandAssignmentError("slot-a", "no_default_cdp_host") as Error & {
      code?: string;
    };

    expect(error.message).toBe("No CDP-capable host is available for panel: slot-a");
    expect(error.code).toBe("panel_host_command_no_default_cdp_host");
  });

  it("does not fail when the slot is already held by a CDP-capable host", () => {
    expect(panelHostCommandAssignmentError("slot-a", "already_held")).toBeNull();
  });
});

describe("snapshotBrowserPanelFromCdpBridge", () => {
  it("serves browser panel snapshots through the host accessibility command", async () => {
    const nodes = [
      { role: { value: "RootWebArea" }, name: { value: "Example" } },
      { role: { value: "button" }, name: { value: "Submit" } },
    ];
    const cdpBridge = {
      isTargetRegistered: () => true,
      sendHostCommand: vi.fn(async () => nodes),
    };

    const snapshot = await snapshotBrowserPanelFromCdpBridge(cdpBridge, "browser-slot");

    expect(snapshot).toEqual({
      kind: "ax",
      text: "RootWebArea: Example\nbutton: Submit",
      structure: nodes,
    });
    expect(cdpBridge.sendHostCommand).toHaveBeenCalledWith("browser-slot", "accessibilityTree", []);
  });

  it("does not auto-load browser targets for snapshots", async () => {
    const cdpBridge = {
      isTargetRegistered: () => false,
      sendHostCommand: vi.fn(),
    };

    await expect(snapshotBrowserPanelFromCdpBridge(cdpBridge, "browser-slot")).rejects.toThrow(
      "target-not-loaded: browser-slot"
    );
    expect(cdpBridge.sendHostCommand).not.toHaveBeenCalled();
  });
});

describe("createServerPanelTreeBridge reload", () => {
  it("reloads the target view without unloading the panel runtime lease", async () => {
    const now = Date.now();
    const slot = {
      slot_id: "slot-a",
      parent_slot_id: null,
      current_entity_id: "panel:entry-a",
      current_entity_title: "Target",
      current_entry_key: "entry-a",
      position_id: "root",
      created_at: now,
      closed_at: null,
    };
    const history = {
      slot_id: "slot-a",
      cursor: 0,
      entry_key: "entry-a",
      entity_id: "panel:entry-a",
      source: "panels/target",
      context_id: "ctx-target",
      state_args: null,
      recorded_at: now,
    };
    const entity = {
      id: "panel:entry-a",
      kind: "panel",
      source: { repoPath: "panels/target", effectiveVersion: "ev-target" },
      contextId: "ctx-target",
      key: "entry-a",
      createdAt: now,
      status: "active",
      cleanupComplete: false,
    };
    const dispatch = vi.fn(async (_ctx, service: string, method: string, args: unknown[]) => {
      if (service === "workspace-state" && method === "slot.list") return [slot];
      if (service === "workspace-state" && method === "slot.get")
        return args[0] === "slot-a" ? slot : null;
      if (service === "workspace-state" && method === "slot.history") return [history];
      if (service === "workspace-state" && method === "entity.resolveActive") return entity;
      if (service === "workspace-state" && method === "panel.search") return [];
      if (service === "build" && method === "getPanelMetadata") return { title: "Target" };
      if (service === "presence" && method === "markPanelActive") return undefined;
      throw new Error(`Unexpected dispatch: ${service}.${method}`);
    });
    const cdpBridge = {
      isProviderConnected: vi.fn(() => true),
      isTargetRegisteredForHost: vi.fn(() => true),
      sendHostCommand: vi.fn(async () => ({
        panelId: "slot-a",
        operation: "reload",
        status: "reloaded",
        loaded: true,
        rebuilt: false,
        reloaded: true,
      })),
    };
    const unloadSlot = vi.fn();
    const bridge = await createServerPanelTreeBridge({
      container: { get: vi.fn(() => cdpBridge) },
      dispatcher: { dispatch },
      workspace: {},
      workspacePath: "/tmp/workspace",
      workspaceConfig: {},
      adminToken: "admin-token",
      centralData: null,
      hostConfig: { gatewayPort: 0, externalHost: "localhost", protocol: "http" },
      isIpcMode: false,
      panelRuntimeCoordinator: {
        resolveHostForSlot: vi.fn(() => ({ hostConnectionId: "desktop-host", supportsCdp: true })),
        unloadSlot,
      },
      eventService: { emit: vi.fn() },
    } as never);

    await expect(
      bridge({
        callerId: "panel:requester",
        callerKind: "panel",
        method: "reload",
        args: ["slot-a"],
      })
    ).resolves.toEqual({
      panelId: "slot-a",
      operation: "reload",
      status: "reloaded",
      loaded: true,
      rebuilt: false,
      reloaded: true,
    });

    expect(unloadSlot).not.toHaveBeenCalled();
    expect(cdpBridge.sendHostCommand).toHaveBeenCalledWith("slot-a", "reloadPanel", []);
  });

  it("delegates rebuild-and-reload to the active host without unloading leases", async () => {
    const now = Date.now();
    const slot = {
      slot_id: "slot-a",
      parent_slot_id: null,
      current_entity_id: "panel:entry-a",
      current_entity_title: "Target",
      current_entry_key: "entry-a",
      position_id: "root",
      created_at: now,
      closed_at: null,
    };
    const history = {
      slot_id: "slot-a",
      cursor: 0,
      entry_key: "entry-a",
      entity_id: "panel:entry-a",
      source: "panels/target",
      context_id: "ctx-target",
      state_args: null,
      recorded_at: now,
    };
    const entity = {
      id: "panel:entry-a",
      kind: "panel",
      source: { repoPath: "panels/target", effectiveVersion: "ev-target" },
      contextId: "ctx-target",
      key: "entry-a",
      createdAt: now,
      status: "active",
      cleanupComplete: false,
    };
    const dispatch = vi.fn(async (_ctx, service: string, method: string, args: unknown[]) => {
      if (service === "workspace-state" && method === "slot.list") return [slot];
      if (service === "workspace-state" && method === "slot.get")
        return args[0] === "slot-a" ? slot : null;
      if (service === "workspace-state" && method === "slot.history") return [history];
      if (service === "workspace-state" && method === "entity.resolveActive") return entity;
      if (service === "workspace-state" && method === "panel.search") return [];
      if (service === "build" && method === "getPanelMetadata") return { title: "Target" };
      if (service === "presence" && method === "markPanelActive") return undefined;
      throw new Error(`Unexpected dispatch: ${service}.${method}`);
    });
    const hostResult = {
      panelId: "slot-a",
      operation: "rebuildAndReload",
      status: "rebuilt_and_reloaded",
      loaded: true,
      rebuilt: true,
      reloaded: true,
    };
    const cdpBridge = {
      isProviderConnected: vi.fn(() => true),
      isTargetRegisteredForHost: vi.fn(() => true),
      sendHostCommand: vi.fn(async () => hostResult),
    };
    const unloadSlot = vi.fn();
    const bridge = await createServerPanelTreeBridge({
      container: { get: vi.fn(() => cdpBridge) },
      dispatcher: { dispatch },
      workspace: {},
      workspacePath: "/tmp/workspace",
      workspaceConfig: {},
      adminToken: "admin-token",
      centralData: null,
      hostConfig: { gatewayPort: 0, externalHost: "localhost", protocol: "http" },
      isIpcMode: false,
      panelRuntimeCoordinator: {
        resolveHostForSlot: vi.fn(() => ({ hostConnectionId: "desktop-host", supportsCdp: true })),
        unloadSlot,
      },
      eventService: { emit: vi.fn() },
    } as never);

    await expect(
      bridge({
        callerId: "panel:requester",
        callerKind: "panel",
        method: "rebuildAndReload",
        args: ["slot-a"],
      })
    ).resolves.toEqual(hostResult);

    expect(unloadSlot).not.toHaveBeenCalled();
    expect(cdpBridge.sendHostCommand).toHaveBeenCalledWith("slot-a", "rebuildAndReload", []);
  });

  it("delegates hosted panel navigation to the active CDP host", async () => {
    const now = Date.now();
    const slot = {
      slot_id: "slot-a",
      parent_slot_id: null,
      current_entity_id: "panel:entry-a",
      current_entity_title: "Target",
      current_entry_key: "entry-a",
      position_id: "root",
      created_at: now,
      closed_at: null,
    };
    const history = {
      slot_id: "slot-a",
      cursor: 0,
      entry_key: "entry-a",
      entity_id: "panel:entry-a",
      source: "panels/target",
      context_id: "ctx-target",
      state_args: null,
      recorded_at: now,
    };
    const entity = {
      id: "panel:entry-a",
      kind: "panel",
      source: { repoPath: "panels/target", effectiveVersion: "ev-target" },
      contextId: "ctx-target",
      key: "entry-a",
      createdAt: now,
      status: "active",
      cleanupComplete: false,
    };
    const dispatch = vi.fn(async (_ctx, service: string, method: string, args: unknown[]) => {
      if (service === "workspace-state" && method === "slot.list") return [slot];
      if (service === "workspace-state" && method === "slot.get")
        return args[0] === "slot-a" ? slot : null;
      if (service === "workspace-state" && method === "slot.history") return [history];
      if (service === "workspace-state" && method === "entity.resolveActive") return entity;
      if (service === "workspace-state" && method === "panel.search") return [];
      if (service === "build" && method === "getPanelMetadata") return { title: "Target" };
      if (service === "presence" && method === "markPanelActive") return undefined;
      throw new Error(`Unexpected dispatch: ${service}.${method}`);
    });
    const hostResult = { id: "slot-a", title: "Next" };
    const cdpBridge = {
      isProviderConnected: vi.fn(() => true),
      isTargetRegisteredForHost: vi.fn(() => true),
      sendHostCommand: vi.fn(async () => hostResult),
    };
    const eventService = { emit: vi.fn() };
    const bridge = await createServerPanelTreeBridge({
      container: { get: vi.fn(() => cdpBridge) },
      dispatcher: { dispatch },
      workspace: {},
      workspacePath: "/tmp/workspace",
      workspaceConfig: {},
      adminToken: "admin-token",
      centralData: null,
      hostConfig: { gatewayPort: 0, externalHost: "localhost", protocol: "http" },
      isIpcMode: false,
      panelRuntimeCoordinator: {
        resolveHostForSlot: vi.fn(() => ({ hostConnectionId: "desktop-host", supportsCdp: true })),
      },
      eventService,
    } as never);

    await expect(
      bridge({
        callerId: "panel:requester",
        callerKind: "panel",
        method: "navigate",
        args: ["slot-a", "panels/next", { contextId: "ctx-next" }],
      })
    ).resolves.toEqual(hostResult);

    expect(cdpBridge.sendHostCommand).toHaveBeenCalledWith("slot-a", "navigatePanel", [
      "panels/next",
      { contextId: "ctx-next" },
    ]);
    expect(eventService.emit).toHaveBeenCalledWith("panel-tree-updated", expect.any(Object));
  });

  it("treats a null hosted navigation result as handled", async () => {
    const now = Date.now();
    const slot = {
      slot_id: "slot-a",
      parent_slot_id: null,
      current_entity_id: "panel:entry-a",
      current_entity_title: "Target",
      current_entry_key: "entry-a",
      position_id: "root",
      created_at: now,
      closed_at: null,
    };
    const history = {
      slot_id: "slot-a",
      cursor: 0,
      entry_key: "entry-a",
      entity_id: "panel:entry-a",
      source: "panels/target",
      context_id: "ctx-target",
      state_args: null,
      recorded_at: now,
    };
    const entity = {
      id: "panel:entry-a",
      kind: "panel",
      source: { repoPath: "panels/target", effectiveVersion: "ev-target" },
      contextId: "ctx-target",
      key: "entry-a",
      createdAt: now,
      status: "active",
      cleanupComplete: false,
    };
    const dispatch = vi.fn(async (_ctx, service: string, method: string, args: unknown[]) => {
      if (service === "workspace-state" && method === "slot.list") return [slot];
      if (service === "workspace-state" && method === "slot.get")
        return args[0] === "slot-a" ? slot : null;
      if (service === "workspace-state" && method === "slot.history") return [history];
      if (service === "workspace-state" && method === "entity.resolveActive") return entity;
      if (service === "workspace-state" && method === "panel.search") return [];
      if (service === "build" && method === "getPanelMetadata") return { title: "Target" };
      if (service === "presence" && method === "markPanelActive") return undefined;
      throw new Error(`Unexpected dispatch: ${service}.${method}`);
    });
    const cdpBridge = {
      isProviderConnected: vi.fn(() => true),
      isTargetRegisteredForHost: vi.fn(() => true),
      sendHostCommand: vi.fn(async () => null),
    };
    const eventService = { emit: vi.fn() };
    const bridge = await createServerPanelTreeBridge({
      container: { get: vi.fn(() => cdpBridge) },
      dispatcher: { dispatch },
      workspace: {},
      workspacePath: "/tmp/workspace",
      workspaceConfig: {},
      adminToken: "admin-token",
      centralData: null,
      hostConfig: { gatewayPort: 0, externalHost: "localhost", protocol: "http" },
      isIpcMode: false,
      panelRuntimeCoordinator: {
        resolveHostForSlot: vi.fn(() => ({ hostConnectionId: "desktop-host", supportsCdp: true })),
      },
      eventService,
    } as never);

    await expect(
      bridge({
        callerId: "panel:requester",
        callerKind: "panel",
        method: "navigate",
        args: ["slot-a", "panels/next", { contextId: "ctx-next" }],
      })
    ).resolves.toBeNull();

    expect(cdpBridge.sendHostCommand).toHaveBeenCalledWith("slot-a", "navigatePanel", [
      "panels/next",
      { contextId: "ctx-next" },
    ]);
    expect(eventService.emit).toHaveBeenCalledWith("panel-tree-updated", expect.any(Object));
  });
});
