/**
 * State management unit tests.
 *
 * These tests verify StateStore behavior with a mock database.
 */

import { createStateStore, type StateStore, type StateChangeEvent } from "../state.js";
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

// Test: load returns initial state when no persisted state exists
export async function testLoadReturnsInitialState(): Promise<void> {
  const db = createMockDb();
  const store = createStateStore<TestState>({
    db,
    key: { agentId: "test", channel: "ch", handle: "h" },
    initial: { count: 0, name: "initial" },
    autoSaveDelayMs: 0, // Immediate save for testing
  });

  const state = await store.load();

  if (state.count !== 0) {
    throw new Error(`Expected count=0, got ${state.count}`);
  }
  if (state.name !== "initial") {
    throw new Error(`Expected name='initial', got ${state.name}`);
  }
}

// Test: set persists state to database
export async function testSetPersistsState(): Promise<void> {
  const db = createMockDb();
  const store = createStateStore<TestState>({
    db,
    key: { agentId: "test", channel: "ch", handle: "h" },
    initial: { count: 0, name: "initial" },
    autoSaveDelayMs: 0, // Immediate save
  });

  await store.load();
  store.set({ count: 42, name: "updated" });
  await store.flush(); // Ensure save completes

  const key = "test:ch:h";
  const persisted = db.data.get(key);
  if (!persisted) {
    throw new Error("State was not persisted");
  }

  const parsed = JSON.parse(persisted) as TestState;
  if (parsed.count !== 42) {
    throw new Error(`Expected persisted count=42, got ${parsed.count}`);
  }
}

// Test: load returns persisted state
export async function testLoadReturnsPersistedState(): Promise<void> {
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

  if (state.count !== 100) {
    throw new Error(`Expected count=100, got ${state.count}`);
  }
  if (state.name !== "persisted") {
    throw new Error(`Expected name='persisted', got ${state.name}`);
  }
}

// Test: get returns current state synchronously
export async function testGetReturnsSyncState(): Promise<void> {
  const db = createMockDb();
  const store = createStateStore<TestState>({
    db,
    key: { agentId: "test", channel: "ch", handle: "h" },
    initial: { count: 0, name: "initial" },
    autoSaveDelayMs: 0,
  });

  await store.load();

  // Before any updates, get returns initial
  const beforeUpdate = store.get();
  if (beforeUpdate.count !== 0) {
    throw new Error(`Expected count=0 before update, got ${beforeUpdate.count}`);
  }

  // After set, get returns updated (synchronously, before save)
  store.set({ count: 5, name: "five" });
  const afterSet = store.get();
  if (afterSet.count !== 5) {
    throw new Error(`Expected count=5 after set, got ${afterSet.count}`);
  }
}

// Test: update merges partial state
export async function testUpdateMergesState(): Promise<void> {
  const db = createMockDb();
  const store = createStateStore<TestState>({
    db,
    key: { agentId: "test", channel: "ch", handle: "h" },
    initial: { count: 0, name: "initial" },
    autoSaveDelayMs: 0,
  });

  await store.load();
  store.update({ count: 10 }); // Only update count, keep name

  const state = store.get();
  if (state.count !== 10) {
    throw new Error(`Expected count=10, got ${state.count}`);
  }
  if (state.name !== "initial") {
    throw new Error(`Expected name='initial', got ${state.name}`);
  }
}

// Test: isDirty tracks unsaved changes
export async function testIsDirtyTracksChanges(): Promise<void> {
  const db = createMockDb();
  const store = createStateStore<TestState>({
    db,
    key: { agentId: "test", channel: "ch", handle: "h" },
    initial: { count: 0, name: "initial" },
    autoSaveDelayMs: 1000, // Slow save to test dirty state
  });

  await store.load();

  if (store.isDirty()) {
    throw new Error("Expected isDirty=false after load");
  }

  store.update({ count: 1 });

  if (!store.isDirty()) {
    throw new Error("Expected isDirty=true after update");
  }

  await store.flush();

  if (store.isDirty()) {
    throw new Error("Expected isDirty=false after flush");
  }

  store.destroy();
}

// Test: subscribe notifies on state changes
export async function testSubscribeNotifiesOnChanges(): Promise<void> {
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

  if (events.length !== 2) {
    throw new Error(`Expected 2 events, got ${events.length}`);
  }

  if (!events[0]!.changedKeys.includes("count")) {
    throw new Error("Expected first event to have 'count' in changedKeys");
  }

  if (!events[1]!.changedKeys.includes("name")) {
    throw new Error("Expected second event to have 'name' in changedKeys");
  }

  unsubscribe();
  store.destroy();
}

// Test: setCheckpoint persists pubsub ID
export async function testSetCheckpointPersists(): Promise<void> {
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
  if (meta.lastPubsubId !== 12345) {
    throw new Error(`Expected lastPubsubId=12345, got ${meta.lastPubsubId}`);
  }

  // Verify it was persisted
  const persistedId = db.metadata.get("test:ch:h:lastPubsubId");
  if (persistedId !== 12345) {
    throw new Error(`Expected persisted lastPubsubId=12345, got ${persistedId}`);
  }
}

// Test: migration upgrades old state
export async function testMigrationUpgradesState(): Promise<void> {
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
    version: 2, // Current version
    migrate: (old, oldVersion) => {
      if (oldVersion < 2) {
        // Add name field
        return { ...old, name: "migrated" } as TestState;
      }
      return old as TestState;
    },
    autoSaveDelayMs: 0,
  });

  const state = await store.load();

  if (state.count !== 50) {
    throw new Error(`Expected count=50, got ${state.count}`);
  }
  if (state.name !== "migrated") {
    throw new Error(`Expected name='migrated', got ${state.name}`);
  }
}

// Run all tests
export async function runTests(): Promise<void> {
  const tests = [
    { name: "load returns initial state", fn: testLoadReturnsInitialState },
    { name: "set persists state", fn: testSetPersistsState },
    { name: "load returns persisted state", fn: testLoadReturnsPersistedState },
    { name: "get returns sync state", fn: testGetReturnsSyncState },
    { name: "update merges state", fn: testUpdateMergesState },
    { name: "isDirty tracks changes", fn: testIsDirtyTracksChanges },
    { name: "subscribe notifies on changes", fn: testSubscribeNotifiesOnChanges },
    { name: "setCheckpoint persists", fn: testSetCheckpointPersists },
    { name: "migration upgrades state", fn: testMigrationUpgradesState },
  ];

  for (const test of tests) {
    try {
      await test.fn();
      console.log(`✓ ${test.name}`);
    } catch (err) {
      console.error(`✗ ${test.name}:`, err);
    }
  }
}
