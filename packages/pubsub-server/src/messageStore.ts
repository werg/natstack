/**
 * Message persistence layer for the PubSub server.
 *
 * Provides MessageStore interface and implementations:
 * - SqliteMessageStore: Production store backed by DatabaseManager
 * - InMemoryMessageStore: Testing store
 * - TestTokenValidator: Simple token validator for tests
 */

import type { DbRunResult } from "@natstack/types";

// =============================================================================
// Injectable dependency interfaces
// =============================================================================

/**
 * Minimal database manager interface — the subset that SqliteMessageStore needs.
 * Implemented by DatabaseManager in the main app.
 */
export interface DatabaseManagerLike {
  open(ownerId: string, dbName: string, readOnly?: boolean): string;
  exec(handle: string, sql: string): void;
  run(handle: string, sql: string, params?: unknown[]): DbRunResult;
  query<T>(handle: string, sql: string, params?: unknown[]): T[];
  close(handle: string): void;
}

// =============================================================================
// Dependency interfaces for testability
// =============================================================================

/**
 * Token validation interface.
 */
export interface TokenValidator {
  validateToken(token: string): { callerId: string; callerKind: string } | null;
}

/**
 * Channel configuration persisted with the channel.
 * Set when the channel is created, readable by all participants.
 */
export interface ChannelConfig {
  title?: string;
  approvalLevel?: 0 | 1 | 2;  // 0=Ask All, 1=Auto-Safe, 2=Full Auto (default)
}

/**
 * Channel metadata stored in the database.
 */
export interface ChannelInfo {
  contextId: string;
  createdAt: number;
  createdBy: string;
  config?: ChannelConfig;
}

/**
 * Fork metadata for a channel — links to the parent channel and the fork point.
 */
export interface ChannelForkInfo {
  parentChannel: string;
  forkPointId: number;
}

/**
 * A segment in a resolved fork chain — channel name + upper bound message ID.
 * The chain is ordered root-first: [{ channel: "root", upToId: 50 }, { channel: "fork", upToId: Infinity }]
 */
export interface ForkSegment {
  channel: string;
  upToId: number;
}

/**
 * A registered agent for a channel (persisted for auto-wake).
 */
export interface ChannelAgentRow {
  id: number;
  channel: string;
  agentId: string;
  handle: string;
  config: string; // JSON spawn config
  registeredAt: number;
  registeredBy: string | null;
}

/**
 * A binary attachment with metadata.
 */
export interface ServerAttachment {
  /** Unique attachment ID for easy tokenization (e.g., "img_1", "img_2") */
  id: string;
  data: Buffer;
  mimeType: string;
  name?: string;
}

export interface MessageRow {
  id: number;
  channel: string;
  type: string;
  payload: string;
  sender_id: string;
  ts: number;
  /** JSON-serialized attachments with base64-encoded data */
  attachment: Buffer | null;
  /** JSON-serialized sender metadata for replay participant reconstruction */
  sender_metadata: string | null;
}

/**
 * Message persistence interface.
 */
export interface MessageStore {
  init(): void;
  insert(channel: string, type: string, payload: string, senderId: string, ts: number, senderMetadata?: Record<string, unknown>, attachments?: ServerAttachment[]): number;
  query(channel: string, sinceId: number): MessageRow[];
  queryByType(channel: string, types: string[], sinceId?: number): MessageRow[];
  /** Query messages before a given ID (for pagination). Returns messages in chronological order. */
  queryBefore(channel: string, beforeId: number, limit?: number): MessageRow[];
  /** Get total count of messages in a channel, optionally filtered by event type. */
  getMessageCount(channel: string, type?: string): number;
  /** Get the ID of the Nth-from-last message of a given type (for anchored replay). OFFSET 0 = last row. */
  getAnchorId(channel: string, type: string, offset: number): number | null;
  /** Fetch update-message and error events for specific message UUIDs at or after a given ID */
  queryTrailingUpdates(channel: string, messageUuids: string[], atOrAfterId: number): MessageRow[];
  createChannel(channel: string, contextId: string, createdBy: string, config?: ChannelConfig): void;
  getChannel(channel: string): ChannelInfo | null;
  /** Update channel config (merges with existing config) */
  updateChannelConfig(channel: string, config: Partial<ChannelConfig>): ChannelConfig | null;
  /** Get the maximum attachment ID number for a channel (for counter initialization after restart) */
  getMaxAttachmentIdNumber(channel: string): number;
  /** Get the minimum message ID for a channel, optionally filtered by type. Returns undefined if no matching messages. */
  getMinMessageId(channel: string, type?: string): number | undefined;
  /** Set fork metadata on a channel (parent channel and fork point message ID). */
  setChannelFork(channel: string, parentChannel: string, forkPointId: number): void;
  /** Get fork metadata for a channel, or null if this is a root channel. */
  getChannelFork(channel: string): ChannelForkInfo | null;
  /**
   * Walk the parent_channel chain and collect segments. Max depth: 10.
   * Returns root-first order, e.g. [{ channel: "root", upToId: 50 }, { channel: "fork-1", upToId: Infinity }]
   */
  resolveForkedSegments(channel: string): ForkSegment[];
  /** Query messages in a specific channel within a range (sinceId, upToId]. */
  queryRange(channel: string, sinceId: number, upToId: number): MessageRow[];
  /** Register an agent for a channel (UPSERT - updates config if already exists) */
  registerChannelAgent(channel: string, agentId: string, handle: string, config: string, registeredBy?: string): void;
  /** Unregister an agent from a channel */
  unregisterChannelAgent(channel: string, agentId: string, handle: string): boolean;
  /** Get all registered agents for a channel */
  getChannelAgents(channel: string): ChannelAgentRow[];
  close(): void;
}

// =============================================================================
// Shared utilities for message stores
// =============================================================================

/**
 * Serialized attachment format for storage (data is base64).
 */
interface StoredAttachment {
  id: string;
  data: string; // base64
  mimeType: string;
  name?: string;
}

/**
 * Serialize sender metadata to JSON string for storage.
 */
export function serializeMetadata(metadata?: Record<string, unknown>): string | null {
  return metadata ? JSON.stringify(metadata) : null;
}

/**
 * Serialize attachments to JSON Buffer for storage.
 * Each attachment's data is base64-encoded for JSON compatibility.
 */
export function serializeAttachments(attachments?: ServerAttachment[]): Buffer | null {
  if (!attachments || attachments.length === 0) return null;
  const stored: StoredAttachment[] = attachments.map((a) => ({
    id: a.id,
    data: a.data.toString("base64"),
    mimeType: a.mimeType,
    name: a.name,
  }));
  return Buffer.from(JSON.stringify(stored), "utf-8");
}

/**
 * Deserialize attachments from JSON Buffer.
 * Attachments without IDs are skipped (corrupted data).
 */
export function deserializeAttachments(buf: Buffer | null): ServerAttachment[] | undefined {
  if (!buf) return undefined;
  try {
    const stored: StoredAttachment[] = JSON.parse(buf.toString("utf-8"));
    return stored
      .filter((a) => a.id)
      .map((a) => ({
        id: a.id,
        data: Buffer.from(a.data, "base64"),
        mimeType: a.mimeType,
        name: a.name,
      }));
  } catch {
    return undefined;
  }
}

export function metadataEquals(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Create a MessageRow object from components.
 */
function createMessageRow(
  id: number,
  channel: string,
  type: string,
  payload: string,
  senderId: string,
  ts: number,
  senderMetadata?: Record<string, unknown>,
  attachments?: ServerAttachment[]
): MessageRow {
  return {
    id,
    channel,
    type,
    payload,
    sender_id: senderId,
    ts,
    sender_metadata: serializeMetadata(senderMetadata),
    attachment: serializeAttachments(attachments),
  };
}

/**
 * Create a ChannelInfo object.
 */
function createChannelInfo(contextId: string, createdAt: number, createdBy: string, config?: ChannelConfig): ChannelInfo {
  return { contextId, createdAt, createdBy, config };
}

// =============================================================================
// Abstract base class for message stores
// =============================================================================

abstract class BaseMessageStore implements MessageStore {
  abstract init(): void;
  abstract close(): void;
  abstract createChannel(channel: string, contextId: string, createdBy: string, config?: ChannelConfig): void;
  abstract getChannel(channel: string): ChannelInfo | null;
  abstract updateChannelConfig(channel: string, config: Partial<ChannelConfig>): ChannelConfig | null;
  abstract insert(
    channel: string,
    type: string,
    payload: string,
    senderId: string,
    ts: number,
    senderMetadata?: Record<string, unknown>,
    attachments?: ServerAttachment[]
  ): number;
  abstract query(channel: string, sinceId: number): MessageRow[];

  queryByType(channel: string, types: string[], sinceId = 0): MessageRow[] {
    if (types.length === 0) return [];
    return this.doQueryByType(channel, types, sinceId);
  }

  protected abstract doQueryByType(channel: string, types: string[], sinceId: number): MessageRow[];
  abstract getMaxAttachmentIdNumber(channel: string): number;

  // --- Fork-aware methods (delegate to per-segment queries) ---

  abstract setChannelFork(channel: string, parentChannel: string, forkPointId: number): void;
  abstract getChannelFork(channel: string): ChannelForkInfo | null;
  abstract resolveForkedSegments(channel: string): ForkSegment[];
  abstract queryRange(channel: string, sinceId: number, upToId: number): MessageRow[];

  /** Fork-aware: sum counts across all segments. */
  getMessageCount(channel: string, type?: string): number {
    const segments = this.resolveForkedSegments(channel);
    let total = 0;
    for (const seg of segments) {
      total += this.getMessageCountSingle(seg.channel, type);
      // For non-leaf segments, we need to filter by upToId
      if (seg.upToId !== Infinity) {
        // Subtract messages beyond the fork point
        total -= this.getMessageCountBeyond(seg.channel, seg.upToId, type);
      }
    }
    return total;
  }

  /** Fork-aware: get min message ID across all segments. */
  getMinMessageId(channel: string, type?: string): number | undefined {
    const segments = this.resolveForkedSegments(channel);
    let minId: number | undefined;
    for (const seg of segments) {
      const segMin = this.getMinMessageIdSingle(seg.channel, type);
      if (segMin !== undefined && (minId === undefined || segMin < minId)) {
        // Validate it's within the segment's range
        if (seg.upToId === Infinity || segMin <= seg.upToId) {
          minId = segMin;
        }
      }
    }
    return minId;
  }

  /** Fork-aware: paginate across segments (query current channel first, walk up chain if limit not satisfied). */
  queryBefore(channel: string, beforeId: number, limit = 100): MessageRow[] {
    const segments = this.resolveForkedSegments(channel);
    const results: MessageRow[] = [];
    let remaining = limit;

    // Walk segments from leaf (last) to root (first)
    for (let i = segments.length - 1; i >= 0 && remaining > 0; i--) {
      const seg = segments[i]!;
      // Effective beforeId: the lower of the requested beforeId and the segment's upper bound + 1
      const effectiveBefore = seg.upToId === Infinity ? beforeId : Math.min(beforeId, seg.upToId + 1);
      const rows = this.queryBeforeSingle(seg.channel, effectiveBefore, remaining);
      if (rows.length > 0) {
        results.unshift(...rows);
        remaining -= rows.length;
        // For the next (parent) segment, use the lowest ID we found as the new beforeId
        beforeId = rows[0]!.id;
      }
    }

    // If we fetched more than the limit (from multiple segments), take the last `limit` rows
    if (results.length > limit) {
      return results.slice(results.length - limit);
    }
    return results;
  }

  /** Fork-aware: query trailing updates across all segments. */
  queryTrailingUpdates(channel: string, messageUuids: string[], atOrAfterId: number): MessageRow[] {
    if (messageUuids.length === 0) return [];
    const segments = this.resolveForkedSegments(channel);
    const results: MessageRow[] = [];
    for (const seg of segments) {
      const effectiveUpTo = seg.upToId === Infinity ? Infinity : seg.upToId;
      const rows = this.queryTrailingUpdatesSingle(seg.channel, messageUuids, atOrAfterId);
      for (const row of rows) {
        if (effectiveUpTo === Infinity || row.id <= effectiveUpTo) {
          results.push(row);
        }
      }
    }
    // Sort by id ascending
    results.sort((a, b) => a.id - b.id);
    return results;
  }

  /** Fork-aware: walk segments to find Nth-from-last message of a given type. */
  getAnchorId(channel: string, type: string, offset: number): number | null {
    const segments = this.resolveForkedSegments(channel);
    // Walk from leaf to root, counting matches
    let remaining = offset;
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i]!;
      // Count how many matching messages are in this segment
      let segCount: number;
      if (seg.upToId === Infinity) {
        segCount = this.getMessageCountSingle(seg.channel, type);
      } else {
        segCount = this.getMessageCountSingle(seg.channel, type) - this.getMessageCountBeyond(seg.channel, seg.upToId, type);
      }

      if (remaining < segCount) {
        // The answer is in this segment
        if (seg.upToId === Infinity) {
          return this.getAnchorIdSingle(seg.channel, type, remaining);
        }
        // Need to find within bounded segment — get all matching IDs desc, skip `remaining`
        return this.getAnchorIdBounded(seg.channel, type, seg.upToId, remaining);
      }
      remaining -= segCount;
    }
    return null;
  }

  // --- Single-channel (non-fork-aware) primitives that subclasses implement ---

  protected abstract getMessageCountSingle(channel: string, type?: string): number;
  /** Count messages in a channel with id > upToId, optionally filtered by type. */
  protected abstract getMessageCountBeyond(channel: string, upToId: number, type?: string): number;
  protected abstract getMinMessageIdSingle(channel: string, type?: string): number | undefined;
  protected abstract queryBeforeSingle(channel: string, beforeId: number, limit: number): MessageRow[];
  protected abstract queryTrailingUpdatesSingle(channel: string, messageUuids: string[], atOrAfterId: number): MessageRow[];
  protected abstract getAnchorIdSingle(channel: string, type: string, offset: number): number | null;
  /** Get the Nth-from-last message of type within id <= upToId. */
  protected abstract getAnchorIdBounded(channel: string, type: string, upToId: number, offset: number): number | null;

  abstract registerChannelAgent(channel: string, agentId: string, handle: string, config: string, registeredBy?: string): void;
  abstract unregisterChannelAgent(channel: string, agentId: string, handle: string): boolean;
  abstract getChannelAgents(channel: string): ChannelAgentRow[];
}

// =============================================================================
// Concrete implementations
// =============================================================================

const DB_NAME = "pubsub-messages";

/**
 * SQLite-backed message store using DatabaseManager.
 */
export class SqliteMessageStore extends BaseMessageStore {
  private dbHandle: string | null = null;
  private dbManager: DatabaseManagerLike;

  constructor(dbManager: DatabaseManagerLike) {
    super();
    this.dbManager = dbManager;
  }

  init(): void {
    const dbManager = this.dbManager;
    this.dbHandle = dbManager.open("pubsub-server", DB_NAME);

    dbManager.exec(
      this.dbHandle,
      `
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        sender_metadata TEXT,
        attachment BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel, id);

      CREATE TABLE IF NOT EXISTS channels (
        channel TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        config TEXT
      );

      CREATE TABLE IF NOT EXISTS channel_agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        handle TEXT NOT NULL,
        config TEXT NOT NULL,
        registered_at INTEGER NOT NULL,
        registered_by TEXT,
        UNIQUE (channel, agent_id, handle)
      );
      CREATE INDEX IF NOT EXISTS idx_channel_agents_channel ON channel_agents(channel);
    `
    );

    // Migration: add fork columns to channels table if they don't exist
    try {
      dbManager.exec(this.dbHandle, `ALTER TABLE channels ADD COLUMN parent_channel TEXT`);
    } catch {
      // Column already exists — ignore
    }
    try {
      dbManager.exec(this.dbHandle, `ALTER TABLE channels ADD COLUMN fork_point_id INTEGER`);
    } catch {
      // Column already exists — ignore
    }
    try {
      dbManager.exec(this.dbHandle, `CREATE INDEX IF NOT EXISTS idx_channels_parent ON channels(parent_channel)`);
    } catch {
      // Index already exists — ignore
    }

  }

  createChannel(channel: string, contextId: string, createdBy: string, config?: ChannelConfig): void {
    if (!this.dbHandle) throw new Error("Store not initialized");
    const db = this.dbManager;
    const now = Date.now();
    const configJson = config ? JSON.stringify(config) : null;
    db.run(
      this.dbHandle,
      "INSERT OR IGNORE INTO channels (channel, context_id, created_at, created_by, config) VALUES (?, ?, ?, ?, ?)",
      [channel, contextId, now, createdBy, configJson]
    );
  }

  getChannel(channel: string): ChannelInfo | null {
    if (!this.dbHandle) return null;
    const db = this.dbManager;
    const row = db.query<{ context_id: string; created_at: number; created_by: string; config: string | null }>(
      this.dbHandle,
      "SELECT context_id, created_at, created_by, config FROM channels WHERE channel = ?",
      [channel]
    )[0];
    if (!row) return null;
    const config = row.config ? JSON.parse(row.config) as ChannelConfig : undefined;
    return createChannelInfo(row.context_id, row.created_at, row.created_by, config);
  }

  updateChannelConfig(channel: string, config: Partial<ChannelConfig>): ChannelConfig | null {
    if (!this.dbHandle) return null;
    const db = this.dbManager;

    const row = db.query<{ config: string | null }>(
      this.dbHandle,
      "SELECT config FROM channels WHERE channel = ?",
      [channel]
    )[0];
    if (!row) return null;

    const existingConfig = row.config ? JSON.parse(row.config) as ChannelConfig : {};
    const newConfig: ChannelConfig = { ...existingConfig, ...config };
    const configJson = JSON.stringify(newConfig);

    db.run(
      this.dbHandle,
      "UPDATE channels SET config = ? WHERE channel = ?",
      [configJson, channel]
    );

    return newConfig;
  }

  insert(
    channel: string,
    type: string,
    payload: string,
    senderId: string,
    ts: number,
    senderMetadata?: Record<string, unknown>,
    attachments?: ServerAttachment[]
  ): number {
    if (!this.dbHandle) throw new Error("Store not initialized");
    const db = this.dbManager;
    const result = db.run(
      this.dbHandle,
      "INSERT INTO messages (channel, type, payload, sender_id, ts, sender_metadata, attachment) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [channel, type, payload, senderId, ts, serializeMetadata(senderMetadata), serializeAttachments(attachments)]
    );
    return Number(result.lastInsertRowid);
  }

  query(channel: string, sinceId: number): MessageRow[] {
    if (!this.dbHandle) return [];
    const db = this.dbManager;
    return db.query<MessageRow>(
      this.dbHandle,
      "SELECT * FROM messages WHERE channel = ? AND id > ? ORDER BY id ASC",
      [channel, sinceId]
    );
  }

  protected doQueryByType(channel: string, types: string[], sinceId: number): MessageRow[] {
    if (!this.dbHandle) return [];
    const db = this.dbManager;
    const placeholders = types.map(() => "?").join(", ");
    return db.query<MessageRow>(
      this.dbHandle,
      `SELECT * FROM messages WHERE channel = ? AND id > ? AND type IN (${placeholders}) ORDER BY id ASC`,
      [channel, sinceId, ...types]
    );
  }

  getMaxAttachmentIdNumber(channel: string): number {
    if (!this.dbHandle) return 0;
    const db = this.dbManager;

    const rows = db.query<{ attachment: Buffer }>(
      this.dbHandle,
      "SELECT attachment FROM messages WHERE channel = ? AND attachment IS NOT NULL",
      [channel]
    );

    let maxId = 0;
    for (const row of rows) {
      try {
        const stored: StoredAttachment[] = JSON.parse(row.attachment.toString("utf-8"));
        for (const a of stored) {
          if (a.id) {
            const match = a.id.match(/^img_(\d+)$/);
            if (match && match[1]) {
              maxId = Math.max(maxId, parseInt(match[1], 10));
            }
          }
        }
      } catch {
        // Skip malformed attachments
      }
    }
    return maxId;
  }

  // --- Fork methods ---

  setChannelFork(channel: string, parentChannel: string, forkPointId: number): void {
    if (!this.dbHandle) throw new Error("Store not initialized");
    const db = this.dbManager;
    db.run(
      this.dbHandle,
      "UPDATE channels SET parent_channel = ?, fork_point_id = ? WHERE channel = ?",
      [parentChannel, forkPointId, channel]
    );
  }

  getChannelFork(channel: string): ChannelForkInfo | null {
    if (!this.dbHandle) return null;
    const db = this.dbManager;
    const row = db.query<{ parent_channel: string | null; fork_point_id: number | null }>(
      this.dbHandle,
      "SELECT parent_channel, fork_point_id FROM channels WHERE channel = ?",
      [channel]
    )[0];
    if (!row || row.parent_channel === null || row.fork_point_id === null) return null;
    return { parentChannel: row.parent_channel, forkPointId: row.fork_point_id };
  }

  resolveForkedSegments(channel: string): ForkSegment[] {
    // Walk from channel up to root, collecting (channel, forkPointId) pairs
    const chain: Array<{ channel: string; forkPointId: number }> = [];
    let current: string | null = channel;
    let depth = 0;
    while (current && depth < 10) {
      const fork = this.getChannelFork(current);
      if (!fork) break;
      chain.push({ channel: current, forkPointId: fork.forkPointId });
      current = fork.parentChannel;
      depth++;
    }
    // `current` is now the root channel (no fork metadata)
    if (chain.length === 0) {
      return [{ channel, upToId: Infinity }];
    }
    // Build segments root-first
    const result: ForkSegment[] = [];
    // Root segment: from root channel up to the first fork point
    const rootFork = chain[chain.length - 1]!;
    result.push({ channel: current!, upToId: rootFork.forkPointId });
    // Intermediate segments
    for (let i = chain.length - 1; i > 0; i--) {
      const seg = chain[i]!;
      const parentFork = chain[i - 1]!;
      result.push({ channel: seg.channel, upToId: parentFork.forkPointId });
    }
    // Leaf segment
    result.push({ channel: chain[0]!.channel, upToId: Infinity });
    return result;
  }

  queryRange(channel: string, sinceId: number, upToId: number): MessageRow[] {
    if (!this.dbHandle) return [];
    const db = this.dbManager;
    if (upToId === Infinity) {
      return db.query<MessageRow>(
        this.dbHandle,
        "SELECT * FROM messages WHERE channel = ? AND id > ? ORDER BY id ASC",
        [channel, sinceId]
      );
    }
    return db.query<MessageRow>(
      this.dbHandle,
      "SELECT * FROM messages WHERE channel = ? AND id > ? AND id <= ? ORDER BY id ASC",
      [channel, sinceId, upToId]
    );
  }

  // --- Single-channel primitives for fork-aware base methods ---

  protected queryBeforeSingle(channel: string, beforeId: number, limit: number): MessageRow[] {
    if (!this.dbHandle) return [];
    const db = this.dbManager;
    const rows = db.query<MessageRow>(
      this.dbHandle,
      "SELECT * FROM messages WHERE channel = ? AND id < ? ORDER BY id DESC LIMIT ?",
      [channel, beforeId, limit]
    );
    return rows.reverse();
  }

  protected queryTrailingUpdatesSingle(channel: string, messageUuids: string[], atOrAfterId: number): MessageRow[] {
    if (!this.dbHandle || messageUuids.length === 0) return [];
    const db = this.dbManager;
    const placeholders = messageUuids.map(() => "?").join(", ");
    return db.query<MessageRow>(
      this.dbHandle,
      `SELECT * FROM messages
       WHERE channel = ?
         AND id >= ?
         AND type IN ('update-message', 'error')
         AND json_extract(payload, '$.id') IN (${placeholders})
       ORDER BY id ASC`,
      [channel, atOrAfterId, ...messageUuids]
    );
  }

  protected getMessageCountSingle(channel: string, type?: string): number {
    if (!this.dbHandle) return 0;
    const db = this.dbManager;
    if (type) {
      const result = db.query<{ count: number }>(
        this.dbHandle,
        "SELECT COUNT(*) as count FROM messages WHERE channel = ? AND type = ?",
        [channel, type]
      );
      return result[0]?.count ?? 0;
    }
    const result = db.query<{ count: number }>(
      this.dbHandle,
      "SELECT COUNT(*) as count FROM messages WHERE channel = ?",
      [channel]
    );
    return result[0]?.count ?? 0;
  }

  protected getMessageCountBeyond(channel: string, upToId: number, type?: string): number {
    if (!this.dbHandle) return 0;
    const db = this.dbManager;
    if (type) {
      const result = db.query<{ count: number }>(
        this.dbHandle,
        "SELECT COUNT(*) as count FROM messages WHERE channel = ? AND type = ? AND id > ?",
        [channel, type, upToId]
      );
      return result[0]?.count ?? 0;
    }
    const result = db.query<{ count: number }>(
      this.dbHandle,
      "SELECT COUNT(*) as count FROM messages WHERE channel = ? AND id > ?",
      [channel, upToId]
    );
    return result[0]?.count ?? 0;
  }

  protected getAnchorIdSingle(channel: string, type: string, offset: number): number | null {
    if (!this.dbHandle) return null;
    const db = this.dbManager;
    const result = db.query<{ id: number }>(
      this.dbHandle,
      "SELECT id FROM messages WHERE channel = ? AND type = ? ORDER BY id DESC LIMIT 1 OFFSET ?",
      [channel, type, offset]
    );
    return result[0]?.id ?? null;
  }

  protected getAnchorIdBounded(channel: string, type: string, upToId: number, offset: number): number | null {
    if (!this.dbHandle) return null;
    const db = this.dbManager;
    const result = db.query<{ id: number }>(
      this.dbHandle,
      "SELECT id FROM messages WHERE channel = ? AND type = ? AND id <= ? ORDER BY id DESC LIMIT 1 OFFSET ?",
      [channel, type, upToId, offset]
    );
    return result[0]?.id ?? null;
  }

  protected getMinMessageIdSingle(channel: string, type?: string): number | undefined {
    if (!this.dbHandle) return undefined;
    const db = this.dbManager;
    if (type) {
      const result = db.query<{ minId: number | null }>(
        this.dbHandle,
        "SELECT MIN(id) as minId FROM messages WHERE channel = ? AND type = ?",
        [channel, type]
      );
      return result[0]?.minId ?? undefined;
    }
    const result = db.query<{ minId: number | null }>(
      this.dbHandle,
      "SELECT MIN(id) as minId FROM messages WHERE channel = ?",
      [channel]
    );
    return result[0]?.minId ?? undefined;
  }

  registerChannelAgent(channel: string, agentId: string, handle: string, config: string, registeredBy?: string): void {
    if (!this.dbHandle) throw new Error("Store not initialized");
    const db = this.dbManager;
    const now = Date.now();
    db.run(
      this.dbHandle,
      `INSERT INTO channel_agents (channel, agent_id, handle, config, registered_at, registered_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (channel, agent_id, handle) DO UPDATE SET
         config = excluded.config,
         registered_at = excluded.registered_at,
         registered_by = excluded.registered_by`,
      [channel, agentId, handle, config, now, registeredBy ?? null]
    );
  }

  unregisterChannelAgent(channel: string, agentId: string, handle: string): boolean {
    if (!this.dbHandle) return false;
    const db = this.dbManager;
    const result = db.run(
      this.dbHandle,
      "DELETE FROM channel_agents WHERE channel = ? AND agent_id = ? AND handle = ?",
      [channel, agentId, handle]
    );
    return result.changes > 0;
  }

  getChannelAgents(channel: string): ChannelAgentRow[] {
    if (!this.dbHandle) return [];
    const db = this.dbManager;
    const rows = db.query<{
      id: number;
      channel: string;
      agent_id: string;
      handle: string;
      config: string;
      registered_at: number;
      registered_by: string | null;
    }>(
      this.dbHandle,
      "SELECT id, channel, agent_id, handle, config, registered_at, registered_by FROM channel_agents WHERE channel = ?",
      [channel]
    );
    return rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      agentId: row.agent_id,
      handle: row.handle,
      config: row.config,
      registeredAt: row.registered_at,
      registeredBy: row.registered_by,
    }));
  }

  close(): void {
    if (this.dbHandle) {
      const dbManager = this.dbManager;

      try {
        dbManager.exec(this.dbHandle, "PRAGMA synchronous = FULL");
        dbManager.query(this.dbHandle, "PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        console.warn('WAL checkpoint failed');
      }

      dbManager.close(this.dbHandle);
      this.dbHandle = null;
    }
  }
}

/**
 * In-memory message store for testing.
 */
export class InMemoryMessageStore extends BaseMessageStore {
  private messages: MessageRow[] = [];
  private channels = new Map<string, ChannelInfo>();
  private channelForks = new Map<string, ChannelForkInfo>();
  private channelAgents: ChannelAgentRow[] = [];
  private nextId = 1;
  private nextAgentId = 1;

  init(): void {
    // No-op for in-memory store
  }

  createChannel(channel: string, contextId: string, createdBy: string, config?: ChannelConfig): void {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, createChannelInfo(contextId, Date.now(), createdBy, config));
    }
  }

  getChannel(channel: string): ChannelInfo | null {
    return this.channels.get(channel) ?? null;
  }

  updateChannelConfig(channel: string, config: Partial<ChannelConfig>): ChannelConfig | null {
    const channelInfo = this.channels.get(channel);
    if (!channelInfo) return null;

    const newConfig: ChannelConfig = { ...channelInfo.config, ...config };
    channelInfo.config = newConfig;
    return newConfig;
  }

  insert(
    channel: string,
    type: string,
    payload: string,
    senderId: string,
    ts: number,
    senderMetadata?: Record<string, unknown>,
    attachments?: ServerAttachment[]
  ): number {
    const id = this.nextId++;
    this.messages.push(createMessageRow(id, channel, type, payload, senderId, ts, senderMetadata, attachments));
    return id;
  }

  query(channel: string, sinceId: number): MessageRow[] {
    return this.messages.filter((m) => m.channel === channel && m.id > sinceId);
  }

  protected doQueryByType(channel: string, types: string[], sinceId: number): MessageRow[] {
    const typeSet = new Set(types);
    return this.messages.filter(
      (m) => m.channel === channel && m.id > sinceId && typeSet.has(m.type)
    );
  }

  getMaxAttachmentIdNumber(channel: string): number {
    let maxId = 0;
    for (const msg of this.messages) {
      if (msg.channel !== channel || !msg.attachment) continue;
      try {
        const stored: StoredAttachment[] = JSON.parse(msg.attachment.toString("utf-8"));
        for (const a of stored) {
          if (a.id) {
            const match = a.id.match(/^img_(\d+)$/);
            if (match && match[1]) {
              maxId = Math.max(maxId, parseInt(match[1], 10));
            }
          }
        }
      } catch {
        // Skip malformed attachments
      }
    }
    return maxId;
  }

  // --- Fork methods ---

  setChannelFork(channel: string, parentChannel: string, forkPointId: number): void {
    this.channelForks.set(channel, { parentChannel, forkPointId });
  }

  getChannelFork(channel: string): ChannelForkInfo | null {
    return this.channelForks.get(channel) ?? null;
  }

  resolveForkedSegments(channel: string): ForkSegment[] {
    const chain: Array<{ channel: string; forkPointId: number }> = [];
    let current: string | null = channel;
    let depth = 0;

    while (current && depth < 10) {
      const fork = this.channelForks.get(current);
      if (!fork) break;
      chain.push({ channel: current, forkPointId: fork.forkPointId });
      current = fork.parentChannel;
      depth++;
    }

    if (chain.length === 0) {
      return [{ channel, upToId: Infinity }];
    }

    const result: ForkSegment[] = [];
    // Root segment
    const rootFork = chain[chain.length - 1]!;
    result.push({ channel: current!, upToId: rootFork.forkPointId });
    // Intermediate segments
    for (let i = chain.length - 1; i > 0; i--) {
      const seg = chain[i]!;
      const parentFork = chain[i - 1]!;
      result.push({ channel: seg.channel, upToId: parentFork.forkPointId });
    }
    // Leaf segment
    result.push({ channel: chain[0]!.channel, upToId: Infinity });
    return result;
  }

  queryRange(channel: string, sinceId: number, upToId: number): MessageRow[] {
    return this.messages.filter((m) => {
      if (m.channel !== channel) return false;
      if (m.id <= sinceId) return false;
      if (upToId !== Infinity && m.id > upToId) return false;
      return true;
    });
  }

  // --- Single-channel primitives for fork-aware base methods ---

  protected queryBeforeSingle(channel: string, beforeId: number, limit: number): MessageRow[] {
    const channelMessages = this.messages.filter(
      (m) => m.channel === channel && m.id < beforeId
    );
    return channelMessages
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .reverse();
  }

  protected queryTrailingUpdatesSingle(channel: string, messageUuids: string[], atOrAfterId: number): MessageRow[] {
    const uuidSet = new Set(messageUuids);
    return this.messages.filter(m => {
      if (m.channel !== channel || m.id < atOrAfterId) return false;
      if (m.type !== "update-message" && m.type !== "error") return false;
      try {
        const payload = JSON.parse(m.payload);
        return uuidSet.has(payload.id);
      } catch { return false; }
    });
  }

  protected getMessageCountSingle(channel: string, type?: string): number {
    return this.messages.filter((m) => m.channel === channel && (!type || m.type === type)).length;
  }

  protected getMessageCountBeyond(channel: string, upToId: number, type?: string): number {
    return this.messages.filter((m) => m.channel === channel && m.id > upToId && (!type || m.type === type)).length;
  }

  protected getAnchorIdSingle(channel: string, type: string, offset: number): number | null {
    const matching = this.messages
      .filter((m) => m.channel === channel && m.type === type)
      .reverse();
    return matching[offset]?.id ?? null;
  }

  protected getAnchorIdBounded(channel: string, type: string, upToId: number, offset: number): number | null {
    const matching = this.messages
      .filter((m) => m.channel === channel && m.type === type && m.id <= upToId)
      .reverse();
    return matching[offset]?.id ?? null;
  }

  protected getMinMessageIdSingle(channel: string, type?: string): number | undefined {
    let minId: number | undefined;
    for (const m of this.messages) {
      if (m.channel !== channel) continue;
      if (type && m.type !== type) continue;
      if (minId === undefined || m.id < minId) minId = m.id;
    }
    return minId;
  }

  registerChannelAgent(channel: string, agentId: string, handle: string, config: string, registeredBy?: string): void {
    const now = Date.now();
    const existing = this.channelAgents.find(
      (a) => a.channel === channel && a.agentId === agentId && a.handle === handle
    );
    if (existing) {
      existing.config = config;
      existing.registeredAt = now;
      existing.registeredBy = registeredBy ?? null;
    } else {
      this.channelAgents.push({
        id: this.nextAgentId++,
        channel,
        agentId,
        handle,
        config,
        registeredAt: now,
        registeredBy: registeredBy ?? null,
      });
    }
  }

  unregisterChannelAgent(channel: string, agentId: string, handle: string): boolean {
    const index = this.channelAgents.findIndex(
      (a) => a.channel === channel && a.agentId === agentId && a.handle === handle
    );
    if (index !== -1) {
      this.channelAgents.splice(index, 1);
      return true;
    }
    return false;
  }

  getChannelAgents(channel: string): ChannelAgentRow[] {
    return this.channelAgents.filter((a) => a.channel === channel);
  }

  close(): void {
    this.reset();
  }

  /** For testing: get all messages */
  getAll(): MessageRow[] {
    return [...this.messages];
  }

  /** For testing: clear all messages between tests */
  clear(): void {
    this.reset();
  }

  private reset(): void {
    this.messages = [];
    this.channels.clear();
    this.channelForks.clear();
    this.channelAgents = [];
    this.nextId = 1;
    this.nextAgentId = 1;
  }
}

/**
 * Simple token validator for testing.
 */
export class TestTokenValidator implements TokenValidator {
  private tokens = new Map<string, { callerId: string; callerKind: string }>();

  addToken(token: string, clientId: string, callerKind: string = "panel"): void {
    this.tokens.set(token, { callerId: clientId, callerKind });
  }

  validateToken(token: string): { callerId: string; callerKind: string } | null {
    return this.tokens.get(token) ?? null;
  }
}
