/**
 * State Management
 *
 * Comprehensive state persistence for agents with:
 * - Synchronous read access
 * - Debounced auto-save (batches writes)
 * - Dirty tracking
 * - Partial updates
 * - Change subscriptions
 * - Version tracking for migrations
 * - Checkpoint tracking for pubsub replay
 */

import type { AgentState } from "@natstack/types";
import type { StorageApi } from "./abstractions/storage.js";

/**
 * State metadata stored alongside the state.
 */
export interface StateMetadata {
  /** Schema version for migrations */
  version: number;
  /** Last pubsub message ID processed (for replay checkpoint) */
  lastPubsubId?: number;
  /** Timestamp when state was created */
  createdAt: number;
  /** Timestamp when state was last modified */
  updatedAt: number;
}

/**
 * State change event passed to subscribers.
 */
export interface StateChangeEvent<S extends AgentState> {
  /** Previous state */
  prev: S;
  /** New state */
  next: S;
  /** Keys that changed */
  changedKeys: string[];
}

/**
 * State change listener function.
 */
export type StateChangeListener<S extends AgentState> = (event: StateChangeEvent<S>) => void;

/**
 * Migration function for upgrading state between versions.
 */
export type StateMigration<S extends AgentState> = (oldState: AgentState, oldVersion: number) => S;

/**
 * Full state store interface with all features.
 */
export interface StateStore<S extends AgentState> {
  /** Get the current state (synchronous, from memory) */
  get(): S;

  /** Get state metadata */
  getMetadata(): StateMetadata;

  /** Replace the entire state and schedule save */
  set(state: S): void;

  /** Partially update state (merge) and schedule save */
  update(partial: Partial<S>): void;

  /** Update the last processed pubsub ID (for replay checkpoint) */
  setCheckpoint(pubsubId: number): void;

  /** Load state from persistence (returns persisted or initial state) */
  load(): Promise<S>;

  /** Force immediate save (use before shutdown) */
  flush(): Promise<void>;

  /** Check if state has unsaved changes */
  isDirty(): boolean;

  /** Subscribe to state changes */
  subscribe(listener: StateChangeListener<S>): () => void;

  /** Reset state to initial values */
  reset(): void;

  /** Destroy the store (cancels pending saves) */
  destroy(): void;
}

/**
 * Options for creating a state store.
 */
export interface StateStoreOptions<S extends AgentState> {
  /** Storage API for persistence */
  storage: StorageApi;

  /** Key identifying this agent's state */
  key: {
    agentId: string;
    channel: string;
    handle: string;
  };

  /** Initial state (used if no persisted state exists) */
  initial: S;

  /**
   * Schema version for migrations.
   * Increment when state shape changes.
   * @default 1
   */
  version?: number;

  /**
   * Migration function to upgrade old state.
   * Called when loaded state has older version.
   */
  migrate?: StateMigration<S>;

  /**
   * Debounce delay for auto-save in milliseconds.
   * Set to 0 to disable debouncing (immediate save).
   * @default 1000
   */
  autoSaveDelayMs?: number;

  /**
   * Maximum delay before forced save in milliseconds.
   * Ensures state is saved even with continuous updates.
   * @default 5000
   */
  maxAutoSaveDelayMs?: number;
}

// SQL for the state table (includes metadata columns)
const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS agent_state (
    agent_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    handle TEXT NOT NULL,
    state TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    last_pubsub_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, channel, handle)
  )
`;

// Migration to add new columns if they don't exist
const MIGRATE_TABLE_SQL = `
  ALTER TABLE agent_state ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE agent_state ADD COLUMN last_pubsub_id INTEGER;
  ALTER TABLE agent_state ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
`;

/**
 * Compute which keys changed between two states.
 */
function computeChangedKeys<S extends AgentState>(prev: S, next: S): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const changed: string[] = [];

  for (const key of keys) {
    const prevVal = prev[key];
    const nextVal = next[key];

    // Simple comparison (doesn't deep-compare objects)
    if (prevVal !== nextVal) {
      changed.push(key);
    }
  }

  return changed;
}

/**
 * Create a state store for an agent.
 *
 * Features:
 * - **Synchronous reads**: `get()` returns immediately from memory
 * - **Debounced writes**: Changes are batched to reduce DB writes
 * - **Dirty tracking**: `isDirty()` tells you if there are unsaved changes
 * - **Partial updates**: `update({ key: value })` merges into state
 * - **Subscriptions**: Listen for state changes
 * - **Versioning**: Automatic migrations when state schema changes
 * - **Checkpointing**: Track last processed pubsub ID for replay
 *
 * @example
 * ```typescript
 * const store = createStateStore({
 *   db,
 *   key: { agentId: 'my-agent', channel: 'chat:1', handle: 'assistant' },
 *   initial: { messageCount: 0, lastMessage: null },
 *   version: 2,
 *   migrate: (old, oldVersion) => {
 *     if (oldVersion < 2) {
 *       return { ...old, lastMessage: null }; // Add new field
 *     }
 *     return old as MyState;
 *   },
 * });
 *
 * // Load persisted state
 * await store.load();
 *
 * // Subscribe to changes
 * store.subscribe(({ next, changedKeys }) => {
 *   console.log('State changed:', changedKeys, next);
 * });
 *
 * // Update state (debounced save)
 * store.update({ messageCount: store.get().messageCount + 1 });
 *
 * // Track pubsub checkpoint
 * store.setCheckpoint(event.pubsubId);
 *
 * // Force save before shutdown
 * await store.flush();
 * ```
 */
export function createStateStore<S extends AgentState>(
  options: StateStoreOptions<S>
): StateStore<S> {
  const {
    storage,
    key,
    initial,
    version = 1,
    migrate,
    autoSaveDelayMs = 1000,
    maxAutoSaveDelayMs = 5000,
  } = options;

  // Current state in memory
  let currentState: S = { ...initial };
  let metadata: StateMetadata = {
    version,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Tracking
  let dirty = false;
  let initialized = false;
  let destroyed = false;

  // Debounce timers
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;
  let maxSaveTimeout: ReturnType<typeof setTimeout> | null = null;
  let savePromise: Promise<void> | null = null;

  // Subscribers
  const listeners = new Set<StateChangeListener<S>>();

  /**
   * Ensure table exists with all columns.
   */
  const ensureTable = async () => {
    if (initialized) return;

    await storage.exec(CREATE_TABLE_SQL);

    // Try to add new columns (will fail silently if they exist)
    try {
      await storage.exec("ALTER TABLE agent_state ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
    } catch { /* Column exists */ }

    try {
      await storage.exec("ALTER TABLE agent_state ADD COLUMN last_pubsub_id INTEGER");
    } catch { /* Column exists */ }

    try {
      await storage.exec("ALTER TABLE agent_state ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
    } catch { /* Column exists */ }

    try {
      await storage.exec("ALTER TABLE agent_state ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
    } catch { /* Column exists */ }

    initialized = true;
  };

  /**
   * Notify all subscribers of state change.
   */
  const notifyListeners = (prev: S, next: S, changedKeys: string[]) => {
    if (changedKeys.length === 0) return;

    const event: StateChangeEvent<S> = { prev, next, changedKeys };
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[StateStore] Listener error:", err);
      }
    }
  };

  /**
   * Actually persist state to database.
   */
  const persistState = async (): Promise<void> => {
    if (destroyed || !dirty) return;

    await ensureTable();

    const stateJson = JSON.stringify(currentState);
    const now = Date.now();

    await storage.run(
      `INSERT INTO agent_state (agent_id, channel, handle, state, version, last_pubsub_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id, channel, handle)
       DO UPDATE SET
         state = excluded.state,
         version = excluded.version,
         last_pubsub_id = excluded.last_pubsub_id,
         updated_at = excluded.updated_at`,
      [
        key.agentId,
        key.channel,
        key.handle,
        stateJson,
        metadata.version,
        metadata.lastPubsubId ?? null,
        metadata.createdAt,
        now,
      ]
    );

    metadata.updatedAt = now;
    dirty = false;
  };

  /**
   * Schedule a debounced save.
   */
  const scheduleSave = () => {
    if (destroyed || autoSaveDelayMs === 0) {
      // Immediate save
      savePromise = persistState();
      return;
    }

    // Clear existing debounce timer
    if (saveTimeout) {
      clearTimeout(saveTimeout);
    }

    // Set debounce timer
    saveTimeout = setTimeout(() => {
      saveTimeout = null;
      if (maxSaveTimeout) {
        clearTimeout(maxSaveTimeout);
        maxSaveTimeout = null;
      }
      savePromise = persistState();
    }, autoSaveDelayMs);

    // Set max delay timer if not already set
    if (!maxSaveTimeout && maxAutoSaveDelayMs > 0) {
      maxSaveTimeout = setTimeout(() => {
        maxSaveTimeout = null;
        if (saveTimeout) {
          clearTimeout(saveTimeout);
          saveTimeout = null;
        }
        savePromise = persistState();
      }, maxAutoSaveDelayMs);
    }
  };

  /**
   * Update state and schedule save.
   */
  const setState = (newState: S, notify = true) => {
    const prev = currentState;
    currentState = newState;
    dirty = true;

    if (notify) {
      const changedKeys = computeChangedKeys(prev, newState);
      notifyListeners(prev, newState, changedKeys);
    }

    scheduleSave();
  };

  return {
    get(): S {
      return currentState;
    },

    getMetadata(): StateMetadata {
      return { ...metadata };
    },

    set(state: S): void {
      setState(state);
    },

    update(partial: Partial<S>): void {
      setState({ ...currentState, ...partial });
    },

    setCheckpoint(pubsubId: number): void {
      if (metadata.lastPubsubId !== pubsubId) {
        metadata.lastPubsubId = pubsubId;
        dirty = true;
        scheduleSave();
      }
    },

    async load(): Promise<S> {
      await ensureTable();

      const row = await storage.get<{
        state: string;
        version: number | null;
        last_pubsub_id: number | null;
        created_at: number | null;
        updated_at: number | null;
      }>(
        `SELECT state, version, last_pubsub_id, created_at, updated_at
         FROM agent_state
         WHERE agent_id = ? AND channel = ? AND handle = ?`,
        [key.agentId, key.channel, key.handle]
      );

      if (row?.state) {
        try {
          let loadedState = JSON.parse(row.state) as AgentState;
          const loadedVersion = row.version ?? 1;

          // Run migration if needed
          if (loadedVersion < version && migrate) {
            loadedState = migrate(loadedState, loadedVersion);
            dirty = true; // Save migrated state
          }

          currentState = loadedState as S;
          metadata = {
            version,
            lastPubsubId: row.last_pubsub_id ?? undefined,
            createdAt: row.created_at ?? Date.now(),
            updatedAt: row.updated_at ?? Date.now(),
          };

          // Save if migration occurred
          if (dirty) {
            await persistState();
          }
        } catch {
          // Invalid JSON, use initial state
          currentState = { ...initial };
          metadata = {
            version,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
        }
      } else {
        // No persisted state, use initial
        currentState = { ...initial };
        metadata = {
          version,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }

      return currentState;
    },

    async flush(): Promise<void> {
      // Cancel pending timers
      if (saveTimeout) {
        clearTimeout(saveTimeout);
        saveTimeout = null;
      }
      if (maxSaveTimeout) {
        clearTimeout(maxSaveTimeout);
        maxSaveTimeout = null;
      }

      // Wait for any in-flight save
      if (savePromise) {
        await savePromise;
      }

      // Persist current state
      await persistState();
    },

    isDirty(): boolean {
      return dirty;
    },

    subscribe(listener: StateChangeListener<S>): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    reset(): void {
      setState({ ...initial });
      metadata.lastPubsubId = undefined;
    },

    destroy(): void {
      destroyed = true;

      if (saveTimeout) {
        clearTimeout(saveTimeout);
        saveTimeout = null;
      }
      if (maxSaveTimeout) {
        clearTimeout(maxSaveTimeout);
        maxSaveTimeout = null;
      }

      listeners.clear();
    },
  };
}
