import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelRegistry } from "../panelRegistry.js";
import { getCurrentSnapshot } from "../panel/accessors.js";
import { PanelManager } from "./panelManager.js";
import { canonicalEntityId } from "../runtime/entitySpec.js";
import type { PanelEntityId, PanelSlotId } from "../panel/ids.js";
import type { RuntimeEntityCreateSpec, RuntimeEntityHandle } from "../runtime/entitySpec.js";
import type {
  RuntimeClient,
  SlotCreateInput,
  SlotHistoryEntryInput,
  SlotHistoryRow,
  SlotRow,
  WorkspaceStateClient,
} from "./workspaceStateClient.js";

/**
 * Minimal in-memory simulator for the workspace-state and runtime services.
 * Tracks slots, slot_history, and entity rows just enough for the panel
 * manager's three-concept flow to round-trip locally.
 */
function createWorkspaceMemory() {
  interface MemSlot {
    slot_id: PanelSlotId;
    parent_slot_id: PanelSlotId | null;
    position_id: string;
    created_at: number;
    closed_at: number | null;
    current_entity_id: PanelEntityId | null;
    current_entry_key: string | null;
  }
  interface MemHistoryEntry {
    entry_key: string;
    entity_id: PanelEntityId;
    source: string;
    context_id: string;
    state_args: string | null;
    recorded_at: number;
  }
  interface MemEntity {
    id: string;
    kind: "panel" | "app" | "worker" | "do" | "session";
    source: string;
    contextId: string;
    status: "active" | "retired";
    key: string;
    displayTitle?: string | null;
  }

  const slots = new Map<PanelSlotId, MemSlot>();
  const history = new Map<PanelSlotId, MemHistoryEntry[]>();
  const entities = new Map<string, MemEntity>();

  const retired: string[] = [];
  const created: string[] = [];

  const stringifyStateArgs = (value: unknown): string | null => {
    if (value === undefined) return null;
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  };

  const workspaceState: WorkspaceStateClient = {
    async listSlots(): Promise<SlotRow[]> {
      return [...slots.values()].map((s) => ({
        ...s,
        current_entity_title: s.current_entity_id
          ? (entities.get(s.current_entity_id)?.displayTitle ?? null)
          : null,
      }));
    },
    async getSlot(slotId): Promise<SlotRow | null> {
      const s = slots.get(slotId);
      return s
        ? {
            ...s,
            current_entity_title: s.current_entity_id
              ? (entities.get(s.current_entity_id)?.displayTitle ?? null)
              : null,
          }
        : null;
    },
    async getSlotHistory(slotId): Promise<SlotHistoryRow[]> {
      const rows = history.get(slotId) ?? [];
      return rows.map((row, cursor) => ({
        slot_id: slotId,
        cursor,
        entry_key: row.entry_key,
        entity_id: row.entity_id,
        source: row.source,
        context_id: row.context_id,
        state_args: row.state_args,
        recorded_at: row.recorded_at,
      }));
    },
    async resolveActiveEntity(id) {
      const e = entities.get(id);
      if (!e || e.status !== "active") return null;
      return {
        id: e.id,
        kind: e.kind,
        source: { repoPath: e.source, effectiveVersion: "test" },
        contextId: e.contextId,
        key: e.key,
        createdAt: Date.now(),
        status: e.status,
        cleanupComplete: false,
      };
    },
    async resolveSlotByEntity(entityId) {
      for (const s of slots.values()) {
        if (s.current_entity_id === entityId && s.closed_at == null) return s.slot_id;
      }
      return null;
    },
    async createSlot(input: SlotCreateInput) {
      slots.set(input.slotId, {
        slot_id: input.slotId,
        parent_slot_id: input.parentSlotId,
        position_id: input.positionId,
        created_at: Date.now(),
        closed_at: null,
        current_entity_id: input.initialEntry?.entityId ?? null,
        current_entry_key: input.initialEntry?.entryKey ?? null,
      });
      if (input.initialEntry) {
        history.set(input.slotId, [
          {
            entry_key: input.initialEntry.entryKey,
            entity_id: input.initialEntry.entityId,
            source: input.initialEntry.source,
            context_id: input.initialEntry.contextId,
            state_args: stringifyStateArgs(input.initialEntry.stateArgs),
            recorded_at: Date.now(),
          },
        ]);
      }
    },
    async appendSlotHistory(slotId, entry: SlotHistoryEntryInput) {
      const rows = history.get(slotId) ?? [];
      rows.push({
        entry_key: entry.entryKey,
        entity_id: entry.entityId,
        source: entry.source,
        context_id: entry.contextId,
        state_args: stringifyStateArgs(entry.stateArgs),
        recorded_at: Date.now(),
      });
      history.set(slotId, rows);
      return rows.length - 1;
    },
    async setSlotCurrent(slotId, entryKey) {
      const slot = slots.get(slotId);
      const rows = history.get(slotId) ?? [];
      const row = rows.find((r) => r.entry_key === entryKey);
      if (!slot || !row) throw new Error(`No such entry: ${slotId}/${entryKey}`);
      slot.current_entity_id = row.entity_id;
      slot.current_entry_key = row.entry_key;
    },
    async updateCurrentStateArgs(slotId, stateArgs) {
      const slot = slots.get(slotId);
      if (!slot?.current_entry_key) return;
      const rows = history.get(slotId) ?? [];
      const row = rows.find((r) => r.entry_key === slot.current_entry_key);
      if (row) row.state_args = stringifyStateArgs(stateArgs);
    },
    async replaceSlotHistory(slotId, entries, cursor) {
      history.set(
        slotId,
        entries.map((entry) => ({
          entry_key: entry.entryKey,
          entity_id: entry.entityId,
          source: entry.source,
          context_id: entry.contextId,
          state_args: stringifyStateArgs(entry.stateArgs),
          recorded_at: Date.now(),
        }))
      );
      const slot = slots.get(slotId);
      const row = entries[cursor];
      if (slot && row) {
        slot.current_entity_id = row.entityId;
        slot.current_entry_key = row.entryKey;
      }
    },
    async setSlotParent(slotId, parentSlotId) {
      const slot = slots.get(slotId);
      if (slot) slot.parent_slot_id = parentSlotId;
    },
    async setSlotPosition(slotId, positionId) {
      const slot = slots.get(slotId);
      if (slot) slot.position_id = positionId;
    },
    async moveSlot(slotId, parentSlotId, positionId) {
      const slot = slots.get(slotId);
      if (slot) {
        slot.parent_slot_id = parentSlotId;
        slot.position_id = positionId;
      }
    },
    async closeSlot(slotId) {
      const slot = slots.get(slotId);
      if (slot) slot.closed_at = Date.now();
    },
  };

  const runtime: RuntimeClient = {
    async createEntity(spec: RuntimeEntityCreateSpec): Promise<RuntimeEntityHandle> {
      const key = spec.key ?? "auto-key";
      const id = canonicalEntityId({
        kind: spec.kind,
        source: spec.source,
        className: spec.kind === "do" ? spec.className : undefined,
        key,
      });
      const existing = entities.get(id);
      if (existing && existing.status === "retired") {
        existing.status = "active";
      } else if (!existing) {
        entities.set(id, {
          id,
          kind: spec.kind,
          source: spec.source,
          contextId: spec.contextId ?? "ctx-default",
          status: "active",
          key,
        });
      }
      created.push(id);
      return {
        id,
        kind: spec.kind,
        source: { repoPath: spec.source, effectiveVersion: "test" },
        contextId: spec.contextId ?? "ctx-default",
        targetId: id,
      };
    },
    async retireEntity(id) {
      retired.push(id);
      const e = entities.get(id);
      if (e) e.status = "retired";
    },
  };

  return {
    workspaceState,
    runtime,
    state: { slots, history, entities, retired, created },
  };
}

function makeManagerDeps(workspacePath: string) {
  const mem = createWorkspaceMemory();
  return {
    mem,
    deps: {
      workspaceState: mem.workspaceState,
      runtime: mem.runtime,
      workspacePath,
      serverInfo: { gatewayConfig: { serverUrl: "http://127.0.0.1:42773" } },
      grantConnection: vi.fn(async (panelId: PanelEntityId) => ({ token: `rpc-${panelId}` })),
    } as const,
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
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({
        name: "example",
        natstack: {
          title: "Example Panel",
          stateArgs: {
            type: "object",
            properties: { greeting: { type: "string" } },
          },
        },
      })
    );

    const registry = new PanelRegistry({});
    const { mem, deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });

    const created = await manager.create("panels/example", {
      isRoot: true,
      addAsRoot: true,
      stateArgs: { greeting: "hello" },
    });

    expect(created.title).toBe("Example Panel");
    expect(registry.getRootPanels()).toHaveLength(1);
    expect(mem.state.slots.has(created.panelId)).toBe(true);
    expect(mem.state.entities.size).toBe(1);

    const init = (await manager.getPanelInit(created.panelId)) as {
      entityId: string;
      panelId?: string;
      slotId: string;
      contextId: string;
      sourceRepo: string;
      effectiveVersion: string;
      gatewayConfig: { serverUrl: string; token: string };
      stateArgs: Record<string, unknown>;
    };
    const createdSlot = mem.state.slots.get(created.panelId);
    const currentEntityId = createdSlot?.current_entity_id;
    expect(currentEntityId).toBeTruthy();
    expect(init.entityId).toBe(currentEntityId);
    expect(init.panelId).toBeUndefined();
    expect(init.slotId).toBe(created.panelId);
    expect(init.contextId).toBe(created.contextId);
    expect(init.sourceRepo).toBe("panels/example");
    expect(init.effectiveVersion).toBe("test");
    expect(init.gatewayConfig).toEqual({
      serverUrl: "http://127.0.0.1:42773",
      token: `rpc-${currentEntityId}`,
    });
    expect(init.stateArgs).toEqual({ greeting: "hello" });
    expect(registry.getInfo(created.panelId)).toMatchObject({
      panelId: created.panelId,
      source: "panels/example",
      contextId: init.contextId,
      runtimeEntityId: currentEntityId,
      effectiveVersion: "test",
      build: { effectiveVersion: "test" },
    });

    const onStateArgsChanged = vi.fn();
    const unsubscribe = manager.onStateArgsChanged(created.panelId, onStateArgsChanged);

    const nextStateArgs = await manager.updateStateArgs(created.panelId, { greeting: "updated" });
    expect(nextStateArgs).toEqual({ greeting: "updated" });
    expect(onStateArgsChanged).toHaveBeenCalledWith({ greeting: "updated" });
    expect(mem.state.entities.size).toBe(1);
    expect(mem.state.slots.get(created.panelId)?.current_entity_id).toBe(currentEntityId);
    expect(mem.state.history.get(created.panelId)?.[0]?.state_args).toBe(
      JSON.stringify({ greeting: "updated" })
    );
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!).stateArgs).toEqual({
      greeting: "updated",
    });

    const clearedStateArgs = await manager.updateStateArgs(created.panelId, { greeting: null });
    expect(clearedStateArgs).toEqual({});
    expect(onStateArgsChanged).toHaveBeenCalledWith({});
    expect(mem.state.entities.size).toBe(1);
    expect(mem.state.slots.get(created.panelId)?.current_entity_id).toBe(currentEntityId);
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!).stateArgs).toEqual({});

    unsubscribe();
    await manager.updateStateArgs(created.panelId, { greeting: "ignored" });
    expect(onStateArgsChanged).toHaveBeenCalledTimes(2);

    await manager.close(created.panelId);
    expect(registry.getPanel(created.panelId)).toBeUndefined();
    expect(mem.state.slots.get(created.panelId)?.closed_at).not.toBeNull();
    expect(mem.state.retired.length).toBeGreaterThan(0);
  });

  it("marks shell manifest panels as privileged in snapshots and create results", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    const panelDir = path.join(workspacePath, "about", "shell-panel");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({
        name: "shell-panel",
        natstack: {
          title: "Shell Panel",
          shell: true,
        },
      })
    );

    const registry = new PanelRegistry({});
    const { deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });

    const created = await manager.create("about/shell-panel", {
      isRoot: true,
      addAsRoot: true,
    });

    expect(created.privileged).toBe(true);
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!)).toMatchObject({
      privileged: true,
    });
  });

  it("updates live navigation state and resolved URL through the shared manager", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    const panelDir = path.join(workspacePath, "panels", "browserish");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({ name: "browserish", natstack: { title: "Initial Title" } })
    );

    const registry = new PanelRegistry({});
    const { deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });

    const created = await manager.create("panels/browserish", {
      isRoot: true,
      addAsRoot: true,
    });

    const revisionBeforeUpdate = registry.getTreeRevision();
    await manager.updatePanelState(created.panelId, {
      url: "https://example.com/docs",
      pageTitle: "Docs",
      isLoading: false,
      canGoBack: true,
      canGoForward: false,
    });

    const panel = registry.getPanel(created.panelId)!;
    expect(panel.title).toBe("Docs");
    expect(panel.navigation).toEqual({
      url: "https://example.com/docs",
      pageTitle: "Docs",
      isLoading: false,
      canGoBack: true,
      canGoForward: false,
    });
    expect(getCurrentSnapshot(panel).source).toBe("panels/browserish");
    expect(getCurrentSnapshot(panel).resolvedUrl).toBe("https://example.com/docs");
    expect(registry.getTreeRevision()).toBeGreaterThan(revisionBeforeUpdate);
  });

  it("builds remote bootstrap URLs with gateway-routed RPC", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    const panelDir = path.join(workspacePath, "panels", "remote");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({ name: "remote", natstack: { title: "Remote Panel" } })
    );

    const { mem, deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({
      registry: new PanelRegistry({}),
      ...deps,
      serverInfo: { gatewayConfig: { serverUrl: "https://natstack.example.com" } },
    });

    const created = await manager.create("panels/remote", {
      isRoot: true,
      addAsRoot: true,
    });

    const init = (await manager.getPanelInit(created.panelId)) as {
      gatewayConfig: { serverUrl: string; token: string };
    };
    const slot = mem.state.slots.get(created.panelId);
    const currentEntityId = slot?.current_entity_id;
    expect(currentEntityId).toBeTruthy();
    expect(init.gatewayConfig).toEqual({
      serverUrl: "https://natstack.example.com",
      token: `rpc-${currentEntityId}`,
    });
  });

  it("includes both parent slot and parent entity ids in child bootstrap config", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    for (const name of ["root", "child"]) {
      const panelDir = path.join(workspacePath, "panels", name);
      fs.mkdirSync(panelDir, { recursive: true });
      fs.writeFileSync(
        path.join(panelDir, "package.json"),
        JSON.stringify({ name, natstack: { title: `${name} Panel` } })
      );
    }

    const { mem, deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry: new PanelRegistry({}), ...deps });

    const root = await manager.create("panels/root", { isRoot: true, addAsRoot: true });
    const child = await manager.create("panels/child", { parentId: root.panelId });
    const init = (await manager.getPanelInit(child.panelId)) as {
      parentId: string | null;
      parentEntityId: string | null;
    };

    expect(init.parentId).toBe(root.panelId);
    expect(init.parentEntityId).toBe(mem.state.slots.get(root.panelId)?.current_entity_id);
  });

  it("persists recursive close for descendant slots", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    for (const name of ["root", "child", "grandchild"]) {
      const panelDir = path.join(workspacePath, "panels", name);
      fs.mkdirSync(panelDir, { recursive: true });
      fs.writeFileSync(
        path.join(panelDir, "package.json"),
        JSON.stringify({ name, natstack: { title: `${name} Panel` } })
      );
    }

    const registry = new PanelRegistry({});
    const { mem, deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });

    const root = await manager.create("panels/root", { isRoot: true, addAsRoot: true });
    const child = await manager.create("panels/child", { parentId: root.panelId });
    const grandchild = await manager.create("panels/grandchild", { parentId: child.panelId });

    await manager.close(root.panelId);

    expect(mem.state.slots.get(root.panelId)?.closed_at).not.toBeNull();
    expect(mem.state.slots.get(child.panelId)?.closed_at).not.toBeNull();
    expect(mem.state.slots.get(grandchild.panelId)?.closed_at).not.toBeNull();

    await manager.syncSnapshot();
    expect(registry.getRootPanels()).toEqual([]);
    expect(registry.getPanel(child.panelId)).toBeUndefined();
    expect(registry.getPanel(grandchild.panelId)).toBeUndefined();
  });

  it("pushes navigation into history and traverses it via back/forward", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    for (const name of ["first", "second"]) {
      const panelDir = path.join(workspacePath, "panels", name);
      fs.mkdirSync(panelDir, { recursive: true });
      fs.writeFileSync(
        path.join(panelDir, "package.json"),
        JSON.stringify({ name, natstack: { title: `${name} Panel` } })
      );
    }

    const registry = new PanelRegistry({});
    const { mem, deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });

    const created = await manager.create("panels/first", { isRoot: true, addAsRoot: true });

    await manager.navigate(created.panelId, "panels/second", { ref: "feature" });

    const afterNavigate = registry.getPanel(created.panelId)!;
    expect(getCurrentSnapshot(afterNavigate).source).toBe("panels/second");
    expect(getCurrentSnapshot(afterNavigate).options.ref).toBe("feature");
    expect(afterNavigate.history?.entries.map((e) => e.source)).toEqual([
      "panels/first",
      "panels/second",
    ]);
    expect(afterNavigate.history?.index).toBe(1);
    // Two distinct panel entities exist now; the first was retired.
    expect(mem.state.entities.size).toBe(2);
    expect(mem.state.retired.length).toBeGreaterThanOrEqual(1);

    await manager.navigateHistory(created.panelId, -1);
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!).source).toBe("panels/first");
    expect(registry.getPanel(created.panelId)?.history?.index).toBe(0);

    await manager.navigateHistory(created.panelId, 1);
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!).source).toBe("panels/second");
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!).options.ref).toBe("feature");
  });

  it("navigates existing slots to URL-like sources as browser snapshots", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    const panelDir = path.join(workspacePath, "panels", "chat");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({ name: "chat", natstack: { title: "Chat" } })
    );

    const registry = new PanelRegistry({});
    const { deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });
    const created = await manager.create("panels/chat", { isRoot: true, addAsRoot: true });

    const result = await manager.navigate(created.panelId, "https:/example.org");
    const panel = registry.getPanel(created.panelId)!;

    expect(result).toMatchObject({
      panelId: created.panelId,
      source: "browser:https://example.org/",
      title: "example.org",
    });
    expect(getCurrentSnapshot(panel).source).toBe("browser:https://example.org/");
    expect(panel.title).toBe("example.org");
    expect(panel.history?.entries.map((entry) => entry.source)).toEqual([
      "panels/chat",
      "browser:https://example.org/",
    ]);
  });

  it("keeps selected descendant path local while using collision-free sibling ranks", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    for (const name of ["root", "first", "second"]) {
      const panelDir = path.join(workspacePath, "panels", name);
      fs.mkdirSync(panelDir, { recursive: true });
      fs.writeFileSync(
        path.join(panelDir, "package.json"),
        JSON.stringify({ name, natstack: { title: `${name} Panel` } })
      );
    }

    const registry = new PanelRegistry({});
    const { deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });

    const root = await manager.create("panels/root", { isRoot: true, addAsRoot: true });
    const first = await manager.create("panels/first", { parentId: root.panelId });
    const second = await manager.create("panels/second", { parentId: root.panelId });

    expect(registry.getPanel(root.panelId)?.children.map((c) => c.id)).toEqual([
      first.panelId,
      second.panelId,
    ]);

    await manager.notifyFocused(first.panelId);
    expect(registry.getPanel(root.panelId)?.selectedChildId).toBe(first.panelId);

    await manager.syncSnapshot();
    expect(registry.getPanel(root.panelId)?.selectedChildId).toBe(first.panelId);
  });

  it("restores roots with duplicate persisted ranks in creation order", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    for (const name of ["first-root", "second-root"]) {
      const panelDir = path.join(workspacePath, "panels", name);
      fs.mkdirSync(panelDir, { recursive: true });
      fs.writeFileSync(
        path.join(panelDir, "package.json"),
        JSON.stringify({ name, natstack: { title: `${name} Panel` } })
      );
    }

    const seedRegistry = new PanelRegistry({});
    const { mem, deps } = makeManagerDeps(workspacePath);
    const seedManager = new PanelManager({ registry: seedRegistry, ...deps });

    const first = await seedManager.create("panels/first-root", {
      isRoot: true,
      addAsRoot: true,
    });
    const second = await seedManager.create("panels/second-root", {
      isRoot: true,
      addAsRoot: true,
    });
    const firstSlot = mem.state.slots.get(first.panelId);
    const secondSlot = mem.state.slots.get(second.panelId);
    if (firstSlot) {
      firstSlot.position_id = "000001000000";
      firstSlot.created_at = 100;
    }
    if (secondSlot) {
      secondSlot.position_id = "000001000000";
      secondSlot.created_at = 200;
    }

    const restoredRegistry = new PanelRegistry({});
    const restoredManager = new PanelManager({ registry: restoredRegistry, ...deps });
    await restoredManager.syncSnapshot();

    expect(restoredRegistry.getRootPanels().map((panel) => panel.id)).toEqual([
      first.panelId,
      second.panelId,
    ]);
  });

  it("persists append root insertion order across restart", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    for (const name of ["first-root", "second-root"]) {
      const panelDir = path.join(workspacePath, "panels", name);
      fs.mkdirSync(panelDir, { recursive: true });
      fs.writeFileSync(
        path.join(panelDir, "package.json"),
        JSON.stringify({ name, natstack: { title: `${name} Panel` } })
      );
    }

    const liveRegistry = new PanelRegistry({});
    const { deps } = makeManagerDeps(workspacePath);
    const liveManager = new PanelManager({ registry: liveRegistry, ...deps });

    const first = await liveManager.create("panels/first-root", {
      isRoot: true,
      addAsRoot: true,
    });
    const second = await liveManager.create("panels/second-root", {
      isRoot: true,
      addAsRoot: true,
    });
    expect(liveRegistry.getRootPanels().map((panel) => panel.id)).toEqual([
      first.panelId,
      second.panelId,
    ]);

    const restoredRegistry = new PanelRegistry({});
    const restoredManager = new PanelManager({ registry: restoredRegistry, ...deps });
    await restoredManager.syncSnapshot();

    expect(restoredRegistry.getRootPanels().map((panel) => panel.id)).toEqual([
      first.panelId,
      second.panelId,
    ]);
  });

  it("persists focused panel and cached titles in local view state", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    const panelDir = path.join(workspacePath, "panels", "chat");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({ name: "chat", natstack: { title: "Actual Chat Title" } })
    );

    const savedStates: unknown[] = [];
    const registry = new PanelRegistry({});
    const { deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({
      registry,
      ...deps,
      viewState: {
        load: () => null,
        save: (state) => {
          savedStates.push(state);
        },
      },
    });

    const created = await manager.create("panels/chat", { isRoot: true, addAsRoot: true });
    await manager.notifyFocused(created.panelId);

    expect(savedStates[savedStates.length - 1]).toMatchObject({
      focusedPanelId: created.panelId,
      panelTitles: {
        [created.panelId]: { source: "panels/chat", title: "Actual Chat Title" },
      },
    });
  });

  it("restores focused panel and title from local view state when manifests are unavailable", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    const seedRegistry = new PanelRegistry({});
    const { deps } = makeManagerDeps(workspacePath);
    const seedManager = new PanelManager({
      registry: seedRegistry,
      ...deps,
      allowMissingManifests: true,
    });
    const created = await seedManager.create("panels/chat", {
      isRoot: true,
      addAsRoot: true,
      name: "chat-root",
    });

    const registry = new PanelRegistry({});
    const manager = new PanelManager({
      registry,
      ...deps,
      allowMissingManifests: true,
      viewState: {
        load: () => ({
          collapsedIds: [],
          focusedPanelId: created.panelId,
          panelTitles: {
            [created.panelId]: { source: "panels/chat", title: "Actual Chat Title" },
          },
        }),
        save: () => {},
      },
    });

    await manager.syncSnapshot();

    expect(registry.getFocusedPanelId()).toBe(created.panelId);
    expect(registry.getPanel(created.panelId)?.title).toBe("Actual Chat Title");
  });

  it("restores panel titles from server metadata when local manifests are unavailable", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    const seedRegistry = new PanelRegistry({});
    const { deps } = makeManagerDeps(workspacePath);
    const seedManager = new PanelManager({
      registry: seedRegistry,
      ...deps,
      allowMissingManifests: true,
    });
    const created = await seedManager.create("panels/chat", {
      isRoot: true,
      addAsRoot: true,
      name: "chat-root",
    });

    const registry = new PanelRegistry({});
    const manager = new PanelManager({
      registry,
      ...deps,
      allowMissingManifests: true,
      metadataResolver: {
        getPanelMetadata: async (source) =>
          source === "panels/chat" ? { title: "Server Chat Title" } : null,
      },
    });

    await manager.syncSnapshot();

    expect(registry.getPanel(created.panelId)?.title).toBe("Server Chat Title");
  });

  it("restores persisted entity titles ahead of manifest titles when rebuilding the tree", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    const panelDir = path.join(workspacePath, "panels", "chat");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({ name: "chat", natstack: { title: "Manifest Chat Title" } })
    );

    const seedRegistry = new PanelRegistry({});
    const { mem, deps } = makeManagerDeps(workspacePath);
    const seedManager = new PanelManager({
      registry: seedRegistry,
      ...deps,
    });
    const created = await seedManager.create("panels/chat", {
      isRoot: true,
      addAsRoot: true,
      name: "chat-root",
    });
    const slot = mem.state.slots.get(created.panelId);
    const entityId = slot?.current_entity_id;
    if (!entityId) throw new Error("expected current entity id");
    mem.state.entities.get(entityId)!.displayTitle = "Runtime Chat Title";

    const registry = new PanelRegistry({});
    const manager = new PanelManager({
      registry,
      ...deps,
    });

    await manager.syncSnapshot();

    expect(registry.getPanel(created.panelId)?.title).toBe("Runtime Chat Title");
  });

  it("does not resolve non-panel entity titles to panels by shared context", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    const panelDir = path.join(workspacePath, "panels", "chat");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({ name: "chat", natstack: { title: "Chat Panel" } })
    );

    const registry = new PanelRegistry({});
    const { mem, deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });
    const created = await manager.create("panels/chat", {
      isRoot: true,
      addAsRoot: true,
      name: "chat-root",
      contextId: "ctx-shared",
    });
    const worker = await deps.runtime.createEntity({
      kind: "worker",
      source: "workers/agent",
      key: "agent",
      contextId: "ctx-shared",
    });
    const panelEntityId = mem.state.slots.get(created.panelId)?.current_entity_id;
    if (!panelEntityId) throw new Error("expected current panel entity id");

    await expect(manager.resolveTitleTargetSlot(worker.id)).resolves.toBeNull();
    await expect(manager.resolveTitleTargetSlot(panelEntityId)).resolves.toEqual({
      slotId: created.panelId,
      titleIsAlreadyPersistedForSlot: true,
    });
  });

  it("closes parent subtrees with one workspace close and retires every panel entity", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    for (const name of ["root", "child"]) {
      const panelDir = path.join(workspacePath, "panels", name);
      fs.mkdirSync(panelDir, { recursive: true });
      fs.writeFileSync(
        path.join(panelDir, "package.json"),
        JSON.stringify({ name, natstack: { title: `${name} Panel` } })
      );
    }

    const registry = new PanelRegistry({});
    const { mem, deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });

    const root = await manager.create("panels/root", { isRoot: true, addAsRoot: true });
    const child = await manager.create("panels/child", { parentId: root.panelId });

    await expect(manager.close(root.panelId)).resolves.toEqual({
      closedIds: [root.panelId, child.panelId],
    });
    expect(mem.state.slots.get(root.panelId)?.closed_at).not.toBeNull();
    expect(registry.getPanel(root.panelId)).toBeUndefined();
    expect(registry.getPanel(child.panelId)).toBeUndefined();
    // Both panel entities should be marked retired.
    const activeRemaining = [...mem.state.entities.values()].filter((e) => e.status === "active");
    expect(activeRemaining).toHaveLength(0);
  });

  it("restores persisted panel navigation history after a fresh manager sync", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-manager-"));
    tempDirs.push(workspacePath);

    for (const name of ["first", "second"]) {
      const panelDir = path.join(workspacePath, "panels", name);
      fs.mkdirSync(panelDir, { recursive: true });
      fs.writeFileSync(
        path.join(panelDir, "package.json"),
        JSON.stringify({ name, natstack: { title: `${name} Panel` } })
      );
    }

    const { mem, deps } = makeManagerDeps(workspacePath);
    const managerA = new PanelManager({ registry: new PanelRegistry({}), ...deps });
    const created = await managerA.create("panels/first", { isRoot: true, addAsRoot: true });
    await managerA.navigate(created.panelId, "panels/second");

    // Fresh manager that shares the same workspace state (same `mem`).
    const registryB = new PanelRegistry({});
    const managerB = new PanelManager({
      registry: registryB,
      workspaceState: mem.workspaceState,
      runtime: mem.runtime,
      workspacePath,
      serverInfo: deps.serverInfo,
      grantConnection: deps.grantConnection,
    });
    await managerB.syncSnapshot();

    expect(getCurrentSnapshot(registryB.getPanel(created.panelId)!).source).toBe("panels/second");
    await managerB.navigateHistory(created.panelId, -1);
    expect(getCurrentSnapshot(registryB.getPanel(created.panelId)!).source).toBe("panels/first");
  });
});
