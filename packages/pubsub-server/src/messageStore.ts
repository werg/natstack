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
  abstract queryBefore(channel: string, beforeId: number, limit?: number): MessageRow[];
  abstract getMessageCount(channel: string, type?: string): number;
  abstract getAnchorId(channel: string, type: string, offset: number): number | null;
  abstract getMinMessageId(channel: string, type?: string): number | undefined;
  abstract queryTrailingUpdates(channel: string, messageUuids: string[], atOrAfterId: number): MessageRow[];
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

  queryBefore(channel: string, beforeId: number, limit = 100): MessageRow[] {
    if (!this.dbHandle) return [];
    const db = this.dbManager;
    const rows = db.query<MessageRow>(
      this.dbHandle,
      "SELECT * FROM messages WHERE channel = ? AND id < ? ORDER BY id DESC LIMIT ?",
      [channel, beforeId, limit]
    );
    return rows.reverse();
  }

  queryTrailingUpdates(channel: string, messageUuids: string[], atOrAfterId: number): MessageRow[] {
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

  getMessageCount(channel: string, type?: string): number {
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

  getAnchorId(channel: string, type: string, offset: number): number | null {
    if (!this.dbHandle) return null;
    const db = this.dbManager;
    const result = db.query<{ id: number }>(
      this.dbHandle,
      "SELECT id FROM messages WHERE channel = ? AND type = ? ORDER BY id DESC LIMIT 1 OFFSET ?",
      [channel, type, offset]
    );
    return result[0]?.id ?? null;
  }

  getMinMessageId(channel: string, type?: string): number | undefined {
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

  queryBefore(channel: string, beforeId: number, limit = 100): MessageRow[] {
    const channelMessages = this.messages.filter(
      (m) => m.channel === channel && m.id < beforeId
    );
    return channelMessages
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .reverse();
  }

  queryTrailingUpdates(channel: string, messageUuids: string[], atOrAfterId: number): MessageRow[] {
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

  getMessageCount(channel: string, type?: string): number {
    return this.messages.filter((m) => m.channel === channel && (!type || m.type === type)).length;
  }

  getAnchorId(channel: string, type: string, offset: number): number | null {
    const matching = this.messages
      .filter((m) => m.channel === channel && m.type === type)
      .reverse();
    return matching[offset]?.id ?? null;
  }

  getMinMessageId(channel: string, type?: string): number | undefined {
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
