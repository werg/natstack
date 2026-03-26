/**
 * scope — Core ScopeManager for REPL-style eval.
 *
 * Proxy handles in-memory state + reactivity. Persistence is decoupled
 * via the ScopePersistence interface.
 */

import type { ScopePersistence, ScopeListEntry } from "./scopePersistence.js";
import { serializeScope, deserializeScope } from "./scopeSerialize.js";

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface ScopesApi {
  /** Current scope's durable ID */
  readonly currentId: string;

  /**
   * Archive current scope and start a new one (inherits serializable values).
   * Returns the new scope's ID. Old scope accessible via get(oldId).
   */
  push(): Promise<string>;

  /**
   * Get an archived scope by its durable ID.
   * Returns a read-only plain object (deserialized from DB).
   */
  get(id: string): Promise<Record<string, unknown> | null>;

  /** List all scope entries for this channel, sorted by creation time. */
  list(): Promise<ScopeListEntry[]>;

  /** Force-persist current scope to DB now. */
  save(): Promise<void>;
}

export interface HydrateResult {
  restored: string[];
  lost: string[];
  partial: string[];
}

// ---------------------------------------------------------------------------
// ScopeManager
// ---------------------------------------------------------------------------

export class ScopeManager {
  private backing: Map<string, unknown>;
  private proxy: Record<string, unknown>;
  private changeListeners = new Set<() => void>();
  private persistence: ScopePersistence;
  private channelId: string;
  private panelId: string;
  private currentScopeId: string;
  private currentCreatedAt: number;
  private evalInProgress = false;
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(opts: {
    channelId: string;
    panelId: string;
    persistence: ScopePersistence;
  }) {
    this.channelId = opts.channelId;
    this.panelId = opts.panelId;
    this.persistence = opts.persistence;
    this.currentScopeId = crypto.randomUUID();
    this.currentCreatedAt = Date.now();
    this.backing = new Map();
    this.proxy = this.createProxy();
  }

  // -------------------------------------------------------------------------
  // Proxy
  // -------------------------------------------------------------------------

  private createProxy(): Record<string, unknown> {
    const mgr = this;
    return new Proxy({} as Record<string, unknown>, {
      get: (_target, prop: string) => mgr.backing.get(prop),
      set: (_target, prop: string, value) => {
        mgr.backing.set(prop, value);
        mgr.dirty = true;
        if (!mgr.evalInProgress) {
          mgr.notifyChangeListeners();
        }
        return true;
      },
      deleteProperty: (_target, prop: string) => {
        mgr.backing.delete(prop);
        mgr.dirty = true;
        if (!mgr.evalInProgress) {
          mgr.notifyChangeListeners();
        }
        return true;
      },
      has: (_target, prop: string) => mgr.backing.has(prop),
      ownKeys: () => Array.from(mgr.backing.keys()),
      getOwnPropertyDescriptor: (_target, prop: string) => {
        if (!mgr.backing.has(prop)) return undefined;
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: mgr.backing.get(prop),
        };
      },
    });
  }

  // -------------------------------------------------------------------------
  // Public accessors
  // -------------------------------------------------------------------------

  /** The current scope Proxy (pre-injected as `scope` binding) */
  get current(): Record<string, unknown> {
    return this.proxy;
  }

  /** Whether scope has unsaved mutations since last persist */
  get isDirty(): boolean {
    return this.dirty;
  }

  /** The scopes API (pre-injected as `scopes` binding) */
  get api(): ScopesApi {
    const mgr = this;
    return {
      get currentId() {
        return mgr.currentScopeId;
      },
      push: () => mgr.push(),
      get: (id: string) => mgr.getScope(id),
      list: () => mgr.listScopes(),
      save: () => mgr.persist(),
    };
  }

  // -------------------------------------------------------------------------
  // Hydration
  // -------------------------------------------------------------------------

  /** Hydrate from DB on init. Async — call once on mount. */
  async hydrate(): Promise<HydrateResult> {
    const entry = await this.persistence.loadCurrent(this.channelId, this.panelId);
    if (!entry) {
      return { restored: [], lost: [], partial: [] };
    }

    // Restore scope ID and timestamp from persisted state
    this.currentScopeId = entry.id;
    this.currentCreatedAt = entry.createdAt;

    const restoredMap = deserializeScope(entry.data);
    for (const [key, value] of restoredMap) {
      this.backing.set(key, value);
    }

    // Compute what was lost (dropped entirely — not in serializedKeys or partialKeys)
    const allPersistedKeys = new Set([...entry.serializedKeys, ...entry.partialKeys]);
    const topLevelKey = (path: string) => path.split(/[.\[]/)[0]!;
    const lostTopLevel = [
      ...new Set(
        entry.droppedPaths
          .map((d) => topLevelKey(d.path))
          .filter((key) => !allPersistedKeys.has(key)),
      ),
    ];

    return {
      restored: entry.serializedKeys,
      lost: lostTopLevel,
      partial: entry.partialKeys,
    };
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /** Persist current state to DB. Called by save triggers. */
  async persist(): Promise<void> {
    if (this.disposed) return;
    // Snapshot dirty before the await — if a mutation arrives during the
    // upsert, dirty will be re-set to true and we must not clear it.
    this.dirty = false;
    const { json, serializedKeys, droppedPaths, partialKeys } = serializeScope(this.backing);
    await this.persistence.upsert({
      id: this.currentScopeId,
      channelId: this.channelId,
      panelId: this.panelId,
      data: json,
      serializedKeys,
      droppedPaths,
      partialKeys,
      createdAt: this.currentCreatedAt,
    });
  }

  /** Schedule a debounced persist (used by DOM event delegation) */
  schedulePersist(delayMs: number): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist().catch((err) => console.warn("[ScopeManager] Scheduled persist failed:", err));
    }, delayMs);
  }

  // -------------------------------------------------------------------------
  // Eval lifecycle
  // -------------------------------------------------------------------------

  /** Mark eval start — suppress component reactivity notifications */
  enterEval(): void {
    this.evalInProgress = true;
  }

  /** Mark eval end — trigger one batched reactivity notification + persist */
  async exitEval(): Promise<void> {
    this.evalInProgress = false;
    this.notifyChangeListeners();
    await this.persist();
  }

  // -------------------------------------------------------------------------
  // Scope history
  // -------------------------------------------------------------------------

  private async push(): Promise<string> {
    // Persist current scope first
    await this.persist();

    // Create new scope inheriting serializable values
    this.currentScopeId = crypto.randomUUID();
    this.currentCreatedAt = Date.now();

    // Persist the new scope immediately (inherits current backing data)
    await this.persist();

    return this.currentScopeId;
  }

  private async getScope(id: string): Promise<Record<string, unknown> | null> {
    const entry = await this.persistence.get(id);
    if (!entry) return null;
    const map = deserializeScope(entry.data);
    const obj: Record<string, unknown> = {};
    for (const [key, value] of map) {
      obj[key] = value;
    }
    return obj;
  }

  private async listScopes(): Promise<ScopeListEntry[]> {
    return this.persistence.list(this.channelId);
  }

  // -------------------------------------------------------------------------
  // Change listeners (component reactivity)
  // -------------------------------------------------------------------------

  /** Subscribe to scope changes. Notifications suppressed during eval. */
  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => {
      this.changeListeners.delete(cb);
    };
  }

  private notifyChangeListeners(): void {
    for (const cb of this.changeListeners) {
      try {
        cb();
      } catch (err) {
        console.warn("[ScopeManager] Change listener error:", err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  dispose(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.dirty) {
      this.persist().catch((err) => console.warn("[ScopeManager] Dispose persist failed:", err));
    }
    this.disposed = true;
    this.changeListeners.clear();
  }
}
