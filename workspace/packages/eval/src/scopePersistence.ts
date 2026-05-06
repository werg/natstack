/**
 * scopePersistence — Dependency-injected persistence interface for REPL scopes.
 *
 * ScopeManager never imports runtime/DB directly. All storage goes through
 * this interface so tests can swap in a no-op or in-memory implementation.
 */

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

export interface ScopeEntry {
  /** Durable UUID — stable across saves, changes only on push() */
  id: string;
  channelId: string;
  panelId: string;
  /** JSON string of serializable values only */
  data: string;
  /** Top-level keys that were fully serialized */
  serializedKeys: string[];
  /** Paths that were dropped during serialization, with reasons */
  droppedPaths: Array<{ path: string; reason: string }>;
  /** Top-level keys that were only partially serialized (some children dropped) */
  partialKeys: string[];
  /** Epoch ms — current scope = max(created_at) per panel */
  createdAt: number;
}

export interface ScopeListEntry {
  id: string;
  createdAt: number;
  keys: string[];
  partial: string[];
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ScopePersistence {
  /** Upsert a scope row — create or update by durable ID */
  upsert(entry: ScopeEntry): Promise<void>;

  /** Load the most recent scope for this panel (highest created_at) */
  loadCurrent(channelId: string, panelId: string): Promise<ScopeEntry | null>;

  /** Get any scope by its durable ID */
  get(id: string): Promise<ScopeEntry | null>;

  /** List all scopes for a channel, sorted by creation time */
  list(channelId: string): Promise<ScopeListEntry[]>;
}
