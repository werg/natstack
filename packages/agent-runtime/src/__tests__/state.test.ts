/**
 * State management unit tests.
 *
 * These tests verify StateStore behavior with a mock database.
 */

import { describe, it, expect } from "vitest";
import { createStateStore, type StateChangeEvent } from "../state.js";
import type { DatabaseInterface, AgentState } from "@natstack/core";

interface TestState extends AgentState {
  count: number;
  name: string;
}

// Mock database implementation
function createMockDb(): DatabaseInterface & { data: Map<string, string>; metadata: Map<string, unknown> } {
  const data = new Map<string, string>();
  const metadata = new Map<string, unknown>();

  return {
    data,
    metadata,

    async exec(_sql: string): Promise<void> {
      // Table creation / migrations - no-op for mock
    },

    async run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
      if (sql.includes("INSERT INTO agent_state")) {
        const [agentId, channel, handle, state, version, lastPubsubId, createdAt, updatedAt] = params as [
          string, string, string, string, number, number | null, number, number
        ];
        const key = `${agentId}:${channel}:${handle}`;
        data.set(key, state);
        metadata.set(`${key}:version`, version);
        metadata.set(`${key}:lastPubsubId`, lastPubsubId);
        metadata.set(`${key}:createdAt`, createdAt);
        metadata.set(`${key}:updatedAt`, updatedAt);
        return { changes: 1, lastInsertRowid: 1 };
      }
      return { changes: 0, lastInsertRowid: 0 };
    },

    async get<T = unknown>(sql: string, params?: unknown[]): Promise<T | null | undefined> {
      if (sql.includes("SELECT")) {
        const [agentId, channel, handle] = params as string[];
        const key = `${agentId}:${channel}:${handle}`;
        const state = data.get(key);
        if (state) {
          return {
            state,
            version: metadata.get(`${key}:version`) ?? 1,
            last_pubsub_id: metadata.get(`${key}:lastPubsubId`) ?? null,
            created_at: metadata.get(`${key}:createdAt`) ?? Date.now(),
            updated_at: metadata.get(`${key}:updatedAt`) ?? Date.now(),
          } as T;
        }
      }
      return null;
    },

    async query<T = unknown>(_sql: string, _params?: unknown[]): Promise<T[]> {
      return [];
    },

    async close(): Promise<void> {
      // No-op for mock
    },
  };
}

describe("createStateStore", () => {
  it("should return initial state when no persisted state exists", async () => {
    const db = createMockDb();
    const store = createStateStore<TestState>({
      db,
      key: { agentId: "test", channel: "ch", handle: "h" },
      initial: { count: 0, name: "initial" },
      autoSaveDelayMs: 0,
    });

    const state = await store.load();

    expect(state.count).toBe(0);
    expect(state.name).toBe("initial");
  });

  it("should persist state to database on set", async () => {
    const db = createMockDb();
    const store = createStateStore<TestState>({
      db,
      key: { agentId: "test", channel: "ch", handle: "h" },
      initial: { count: 0, name: "initial" },
      autoSaveDelayMs: 0,
    });

    await store.load();
    store.set({ count: 42, name: "updated" });
    await store.flush();

    const key = "test:ch:h";
    const persisted = db.data.get(key);
    expect(persisted).toBeDefined();

    const parsed = JSON.parse(persisted!) as TestState;
    expect(parsed.count).toBe(42);
  });

  it("should return persisted state on load", async () => {
    const db = createMockDb();
    db.data.set("test:ch:h", JSON.stringify({ count: 100, name: "persisted" }));
    db.metadata.set("test:ch:h:version", 1);
    db.metadata.set("test:ch:h:createdAt", Date.now());
    db.metadata.set("test:ch:h:updatedAt", Date.now());

    const store = createStateStore<TestState>({
      db,
      key: { agentId: "test", channel: "ch", handle: "h" },
      initial: { count: 0, name: "initial" },
    });

    const state = await store.load();

    expect(state.count).toBe(100);
    expect(state.name).toBe("persisted");
  });

  it("should return current state synchronously via get()", async () => {
    const db = createMockDb();
    const store = createStateStore<TestState>({
      db,
      key: { agentId: "test", channel: "ch", handle: "h" },
      initial: { count: 0, name: "initial" },
      autoSaveDelayMs: 0,
    });

    await store.load();

    const beforeUpdate = store.get();
    expect(beforeUpdate.count).toBe(0);

    store.set({ count: 5, name: "five" });
    const afterSet = store.get();
    expect(afterSet.count).toBe(5);
  });

  it("should merge partial state on update()", async () => {
    const db = createMockDb();
    const store = createStateStore<TestState>({
      db,
      key: { agentId: "test", channel: "ch", handle: "h" },
      initial: { count: 0, name: "initial" },
      autoSaveDelayMs: 0,
    });

    await store.load();
    store.update({ count: 10 });

    const state = store.get();
    expect(state.count).toBe(10);
    expect(state.name).toBe("initial");
  });

  it("should track dirty state", async () => {
    const db = createMockDb();
    const store = createStateStore<TestState>({
      db,
      key: { agentId: "test", channel: "ch", handle: "h" },
      initial: { count: 0, name: "initial" },
      autoSaveDelayMs: 1000,
    });

    await store.load();
    expect(store.isDirty()).toBe(false);

    store.update({ count: 1 });
    expect(store.isDirty()).toBe(true);

    await store.flush();
    expect(store.isDirty()).toBe(false);

    store.destroy();
  });

  it("should notify subscribers on state changes", async () => {
    const db = createMockDb();
    const store = createStateStore<TestState>({
      db,
      key: { agentId: "test", channel: "ch", handle: "h" },
      initial: { count: 0, name: "initial" },
      autoSaveDelayMs: 0,
    });

    await store.load();

    const events: StateChangeEvent<TestState>[] = [];
    const unsubscribe = store.subscribe((event) => {
      events.push(event);
    });

    store.update({ count: 1 });
    store.update({ name: "updated" });

    expect(events).toHaveLength(2);
    expect(events[0]!.changedKeys).toContain("count");
    expect(events[1]!.changedKeys).toContain("name");

    unsubscribe();
    store.destroy();
  });

  it("should persist checkpoint (pubsub ID)", async () => {
    const db = createMockDb();
    const store = createStateStore<TestState>({
      db,
      key: { agentId: "test", channel: "ch", handle: "h" },
      initial: { count: 0, name: "initial" },
      autoSaveDelayMs: 0,
    });

    await store.load();
    store.setCheckpoint(12345);
    await store.flush();

    const meta = store.getMetadata();
    expect(meta.lastPubsubId).toBe(12345);

    const persistedId = db.metadata.get("test:ch:h:lastPubsubId");
    expect(persistedId).toBe(12345);
  });

  it("should migrate old state versions", async () => {
    const db = createMockDb();

    // Pre-populate with v1 state (missing 'name' field)
    db.data.set("test:ch:h", JSON.stringify({ count: 50 }));
    db.metadata.set("test:ch:h:version", 1);
    db.metadata.set("test:ch:h:createdAt", Date.now());
    db.metadata.set("test:ch:h:updatedAt", Date.now());

    const store = createStateStore<TestState>({
      db,
      key: { agentId: "test", channel: "ch", handle: "h" },
      initial: { count: 0, name: "default" },
      version: 2,
      migrate: (old, oldVersion) => {
        if (oldVersion < 2) {
          return { ...old, name: "migrated" } as TestState;
        }
        return old as TestState;
      },
      autoSaveDelayMs: 0,
    });

    const state = await store.load();

    expect(state.count).toBe(50);
    expect(state.name).toBe("migrated");
  });
});
