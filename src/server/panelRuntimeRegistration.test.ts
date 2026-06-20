import { describe, expect, it, vi } from "vitest";
import {
  cdpDefaultHostAssignmentError,
  createServerPanelTreeBridge,
  panelHostCommandAssignmentError,
  snapshotBrowserPanelFromCdpBridge,
} from "./panelRuntimeRegistration.js";

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
    const error = cdpDefaultHostAssignmentError(
      "panel:tree/slot-a",
      "no_default_cdp_host"
    ) as Error & {
      code?: string;
    };

    expect(error.message).toBe("No CDP-capable host is available for panel: panel:tree/slot-a");
    expect(error.code).toBe("cdp_no_default_host");
  });

  it("does not fail when the slot is already held by a CDP-capable host", () => {
    expect(cdpDefaultHostAssignmentError("panel:tree/slot-a", "already_held")).toBeNull();
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
    const error = panelHostCommandAssignmentError(
      "panel:tree/slot-a",
      "no_default_cdp_host"
    ) as Error & {
      code?: string;
    };

    expect(error.message).toBe("No CDP-capable host is available for panel: panel:tree/slot-a");
    expect(error.code).toBe("panel_host_command_no_default_cdp_host");
  });

  it("does not fail when the slot is already held by a CDP-capable host", () => {
    expect(panelHostCommandAssignmentError("panel:tree/slot-a", "already_held")).toBeNull();
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
      slot_id: "panel:tree/slot-a",
      parent_slot_id: null,
      current_entity_id: "panel:entry-a",
      current_entity_title: "Target",
      current_entry_key: "entry-a",
      position_id: "root",
      created_at: now,
      closed_at: null,
    };
    const history = {
      slot_id: "panel:tree/slot-a",
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
        return args[0] === "panel:tree/slot-a" ? slot : null;
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
        panelId: "panel:tree/slot-a",
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
        args: ["panel:tree/slot-a"],
      })
    ).resolves.toEqual({
      panelId: "panel:tree/slot-a",
      operation: "reload",
      status: "reloaded",
      loaded: true,
      rebuilt: false,
      reloaded: true,
    });

    expect(unloadSlot).not.toHaveBeenCalled();
    expect(cdpBridge.sendHostCommand).toHaveBeenCalledWith("panel:tree/slot-a", "reloadPanel", []);
  });

  it("delegates rebuild-and-reload to the active host without unloading leases", async () => {
    const now = Date.now();
    const slot = {
      slot_id: "panel:tree/slot-a",
      parent_slot_id: null,
      current_entity_id: "panel:entry-a",
      current_entity_title: "Target",
      current_entry_key: "entry-a",
      position_id: "root",
      created_at: now,
      closed_at: null,
    };
    const history = {
      slot_id: "panel:tree/slot-a",
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
        return args[0] === "panel:tree/slot-a" ? slot : null;
      if (service === "workspace-state" && method === "slot.history") return [history];
      if (service === "workspace-state" && method === "entity.resolveActive") return entity;
      if (service === "workspace-state" && method === "panel.search") return [];
      if (service === "build" && method === "getPanelMetadata") return { title: "Target" };
      if (service === "presence" && method === "markPanelActive") return undefined;
      throw new Error(`Unexpected dispatch: ${service}.${method}`);
    });
    const hostResult = {
      panelId: "panel:tree/slot-a",
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
        args: ["panel:tree/slot-a"],
      })
    ).resolves.toEqual(hostResult);

    expect(unloadSlot).not.toHaveBeenCalled();
    expect(cdpBridge.sendHostCommand).toHaveBeenCalledWith(
      "panel:tree/slot-a",
      "rebuildAndReload",
      []
    );
  });
});

describe("createServerPanelTreeBridge create (root, no wipe)", () => {
  it("appends a new root panel without wiping existing roots", async () => {
    // Stateful WorkspaceDO mock: slots/history/entities.
    const slots = new Map<string, Record<string, unknown>>();
    const histories = new Map<string, unknown[]>();
    const entities = new Map<string, Record<string, unknown>>();
    let entityCounter = 0;

    // Seed an existing root panel so we can prove a new root doesn't replace it.
    slots.set("slot-existing", {
      slot_id: "slot-existing",
      parent_slot_id: null,
      current_entity_id: "panel:existing",
      current_entity_title: "Existing",
      current_entry_key: "entry-existing",
      position_id: "root",
      created_at: 1,
      closed_at: null,
    });
    histories.set("slot-existing", [
      {
        slot_id: "slot-existing",
        cursor: 0,
        entry_key: "entry-existing",
        entity_id: "panel:existing",
        source: "panels/existing",
        context_id: "ctx-existing",
        state_args: null,
        recorded_at: 1,
      },
    ]);
    entities.set("panel:existing", {
      id: "panel:existing",
      kind: "panel",
      source: { repoPath: "panels/existing", effectiveVersion: "ev" },
      contextId: "ctx-existing",
      key: "entry-existing",
      createdAt: 1,
      status: "active",
      cleanupComplete: false,
    });

    const dispatch = vi.fn(async (_ctx, service: string, method: string, args: unknown[]) => {
      if (service === "workspace-state") {
        switch (method) {
          case "slot.list":
            return [...slots.values()].filter((s) => s["closed_at"] == null);
          case "slot.get":
            return slots.get(args[0] as string) ?? null;
          case "slot.history":
            return histories.get(args[0] as string) ?? [];
          case "entity.resolveActive":
            return entities.get(args[0] as string) ?? null;
          case "slot.resolveByEntity": {
            // Durable nav→slot: the open slot whose current entity matches, or null.
            const entityId = args[0] as string;
            for (const s of slots.values()) {
              if (s["current_entity_id"] === entityId && s["closed_at"] == null)
                return s["slot_id"];
            }
            return null;
          }
          case "panel.search":
            return [];
          case "panel.index":
            return null;
          case "slot.create": {
            const input = args[0] as {
              slotId: string;
              parentSlotId: string | null;
              positionId: string;
              initialEntry: {
                entryKey: string;
                entityId: string;
                source: string;
                contextId: string;
                stateArgs?: unknown;
              };
            };
            slots.set(input.slotId, {
              slot_id: input.slotId,
              parent_slot_id: input.parentSlotId ?? null,
              current_entity_id: input.initialEntry.entityId,
              current_entity_title: null,
              current_entry_key: input.initialEntry.entryKey,
              position_id: input.positionId,
              created_at: 2,
              closed_at: null,
            });
            histories.set(input.slotId, [
              {
                slot_id: input.slotId,
                cursor: 0,
                entry_key: input.initialEntry.entryKey,
                entity_id: input.initialEntry.entityId,
                source: input.initialEntry.source,
                context_id: input.initialEntry.contextId,
                state_args: input.initialEntry.stateArgs ?? null,
                recorded_at: 2,
              },
            ]);
            return;
          }
        }
      }
      if (service === "runtime" && method === "createEntity") {
        const spec = args[0] as { source: string; contextId: string; key: string };
        const id = `panel:nav-new-${++entityCounter}`;
        const record = {
          id,
          kind: "panel",
          source: { repoPath: spec.source, effectiveVersion: "ev" },
          contextId: spec.contextId,
          key: spec.key,
          createdAt: 2,
          status: "active",
          cleanupComplete: false,
        };
        entities.set(id, record);
        return {
          id,
          kind: "panel",
          source: record.source,
          contextId: spec.contextId,
          targetId: id,
        };
      }
      if (service === "build" && method === "getPanelMetadata") return { title: "Created" };
      if (service === "presence" && method === "markPanelActive") return undefined;
      if (service === "auth" && method === "grantConnection") return { token: "t" };
      throw new Error(`Unexpected dispatch: ${service}.${method}`);
    });

    const eventService = { emit: vi.fn() };
    const bridge = await createServerPanelTreeBridge({
      container: { get: vi.fn(() => ({})) },
      dispatcher: { dispatch },
      workspace: {},
      workspacePath: "/tmp/workspace",
      workspaceConfig: {},
      adminToken: "admin-token",
      centralData: null,
      hostConfig: { gatewayPort: 0, externalHost: "localhost", protocol: "http" },
      isIpcMode: false,
      panelRuntimeCoordinator: {
        resolveHostForSlot: vi.fn(() => null),
        getLease: vi.fn(() => null),
      },
      eventService,
      getGatewayPort: () => 0,
    } as never);

    // Create a NEW root panel (server caller ⇒ no implicit parent ⇒ root).
    await bridge({
      callerId: "server",
      callerKind: "server",
      method: "create",
      args: ["panels/new", {}],
    });

    // The broadcast tree must contain BOTH roots — the new root must not have
    // wiped the pre-existing one (the addAsRoot fix).
    const treeEmits = eventService.emit.mock.calls.filter((c) => c[0] === "panel-tree-updated");
    const lastTree = treeEmits.at(-1)?.[1] as { rootPanels: Array<{ id: string }> };
    expect(lastTree.rootPanels).toHaveLength(2);
    expect(lastTree.rootPanels.map((p) => p.id)).toContain("slot-existing");
  });
});

describe("createServerPanelTreeBridge self-heal", () => {
  it("re-syncs the mirror and re-broadcasts (debounced) when the slot tree changes", async () => {
    const now = Date.now();
    const slot = {
      slot_id: "panel:tree/slot-a",
      parent_slot_id: null,
      current_entity_id: "panel:entry-a",
      current_entity_title: "Target",
      current_entry_key: "entry-a",
      position_id: "root",
      created_at: now,
      closed_at: null,
    };
    const history = {
      slot_id: "panel:tree/slot-a",
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
        return args[0] === "panel:tree/slot-a" ? slot : null;
      if (service === "workspace-state" && method === "slot.history") return [history];
      if (service === "workspace-state" && method === "entity.resolveActive") return entity;
      if (service === "workspace-state" && method === "panel.search") return [];
      if (service === "build" && method === "getPanelMetadata") return { title: "Target" };
      if (service === "presence" && method === "markPanelActive") return undefined;
      throw new Error(`Unexpected dispatch: ${service}.${method}`);
    });
    const eventService = { emit: vi.fn() };
    let slotListener: (() => void) | undefined;
    await createServerPanelTreeBridge({
      container: { get: vi.fn(() => ({})) },
      dispatcher: { dispatch },
      workspace: {},
      workspacePath: "/tmp/workspace",
      workspaceConfig: {},
      adminToken: "admin-token",
      centralData: null,
      hostConfig: { gatewayPort: 0, externalHost: "localhost", protocol: "http" },
      isIpcMode: false,
      panelRuntimeCoordinator: { resolveHostForSlot: vi.fn(() => null) },
      eventService,
      registerSlotStateListener: (listener: () => void) => {
        slotListener = listener;
        return () => {};
      },
    } as never);

    expect(slotListener).toBeDefined();

    vi.useFakeTimers();
    try {
      // Several slot writes for one logical mutation — debounce should coalesce.
      slotListener?.();
      slotListener?.();
      slotListener?.();
      await vi.advanceTimersByTimeAsync(50);
    } finally {
      vi.useRealTimers();
    }

    // Forced re-sync read the authoritative tree …
    expect(dispatch).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-state",
      "slot.list",
      expect.anything()
    );
    // … and re-broadcast exactly once (debounced).
    const treeEmits = eventService.emit.mock.calls.filter((c) => c[0] === "panel-tree-updated");
    expect(treeEmits).toHaveLength(1);
  });
});
