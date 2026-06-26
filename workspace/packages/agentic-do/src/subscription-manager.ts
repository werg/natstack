/**
 * SubscriptionManager — Channel subscriptions, participant identity.
 *
 * Uses ChannelClient (callDoTarget) for subscribe/unsubscribe — no PubSubDOClient.
 * Owns the `subscriptions` table.
 */

import type { SqlStorage } from "@workspace/runtime/worker";
import type { ChannelSubscriptionConfig } from "@workspace/agentic-core";
import type { ParticipantDescriptor } from "@workspace/harness";
import type { ChannelReplayEnvelope } from "@workspace/pubsub";
import { PARTICIPANT_SESSION_METADATA_KEY } from "@workspace/pubsub/internal-constants";
import type { DOIdentity } from "./identity.js";
import type { ChannelClient } from "./channel-client.js";

export class SubscriptionManager {
  constructor(
    private sql: SqlStorage,
    private channelFactory: (channelId: string) => ChannelClient,
    private identity: DOIdentity,
    private participantIdFallback?: () => string
  ) {}

  createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        channel_id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        subscribed_at INTEGER NOT NULL,
        config TEXT,
        participant_id TEXT
      )
    `);
  }

  /** Build the participant ID from the DO's identity. */
  private buildParticipantId(): string {
    const ref = this.identity.refOrNull;
    if (ref) return `do:${ref.source}:${ref.className}:${ref.objectKey}`;
    if (this.participantIdFallback) return this.participantIdFallback();
    return `do:unknown:unknown:unbootstrapped`;
  }

  async subscribe(opts: {
    channelId: string;
    contextId: string;
    config?: unknown;
    descriptor: ParticipantDescriptor;
    /** Request replay of persisted messages sent before this subscriber joined. */
    replay?: boolean;
  }): Promise<{
    ok: boolean;
    participantId: string;
    channelConfig?: Record<string, unknown>;
    envelope?: ChannelReplayEnvelope;
  }> {
    const participantId = this.buildParticipantId();
    const metadata: Record<string, unknown> = {
      name: opts.descriptor.name,
      type: opts.descriptor.type,
      handle: opts.descriptor.handle,
      contextId: opts.contextId,
      ...opts.descriptor.metadata,
    };
    // This DO participant (an agent vessel) consumes the channel's STRUCTURED
    // `onChannelEnvelope` delivery. RPC-style clients (connectViaRpc — e.g. the
    // eval running system tests) do NOT set this and receive only the
    // `channel:message` event stream, so the channel won't push onChannelEnvelope
    // to them (they have no handler for it).
    metadata["receivesChannelEnvelopes"] = true;
    if (this.identity.sessionId) {
      metadata[PARTICIPANT_SESSION_METADATA_KEY] = this.identity.sessionId;
    }
    if (opts.config && typeof opts.config === "object") {
      metadata["channelConfig"] = opts.config;
    }
    if (opts.descriptor.methods && opts.descriptor.methods.length > 0) {
      metadata["methods"] = opts.descriptor.methods;
    }
    if (opts.replay !== undefined) {
      metadata["replay"] = opts.replay;
    }

    const channel = this.channelFactory(opts.channelId);
    const subResult = await channel.subscribe(participantId, metadata);

    this.sql.exec(
      `INSERT OR REPLACE INTO subscriptions
         (channel_id, context_id, subscribed_at, config, participant_id)
       VALUES (?, ?, ?, ?, ?)`,
      opts.channelId,
      opts.contextId,
      Date.now(),
      opts.config ? JSON.stringify(opts.config) : null,
      participantId
    );

    return {
      ok: true,
      participantId,
      channelConfig: subResult?.channelConfig,
      envelope: subResult?.envelope,
    };
  }

  /** Unsubscribe from channel DO. Does NOT clean up other tables — caller handles that. */
  async unsubscribeFromChannel(channelId: string): Promise<void> {
    const participantId = this.getParticipantId(channelId);
    if (participantId) {
      const channel = this.channelFactory(channelId);
      await channel.unsubscribe(participantId);
    }
  }

  getParticipantId(channelId: string): string | null {
    const row = this.sql
      .exec(`SELECT participant_id FROM subscriptions WHERE channel_id = ?`, channelId)
      .toArray();
    return row.length > 0 ? (row[0]!["participant_id"] as string | null) : null;
  }

  getContextId(channelId: string): string {
    const row = this.sql
      .exec(`SELECT context_id FROM subscriptions WHERE channel_id = ?`, channelId)
      .toArray();
    if (row.length === 0) throw new Error(`No subscription for channel ${channelId}`);
    return row[0]!["context_id"] as string;
  }

  getConfig(channelId: string): ChannelSubscriptionConfig | null {
    const row = this.sql
      .exec(`SELECT config FROM subscriptions WHERE channel_id = ?`, channelId)
      .toArray();
    if (row.length === 0 || !row[0]!["config"]) return null;
    const parsed = JSON.parse(row[0]!["config"] as string);
    return parsed && typeof parsed === "object" ? (parsed as ChannelSubscriptionConfig) : null;
  }

  patchConfig(channelId: string, patch: Record<string, unknown>): ChannelSubscriptionConfig {
    const current = this.getConfig(channelId) ?? {};
    if (!this.getParticipantId(channelId)) {
      throw new Error(`No subscription for channel ${channelId}`);
    }
    const next: Record<string, unknown> = { ...current, ...patch };
    this.sql.exec(
      `UPDATE subscriptions SET config = ? WHERE channel_id = ?`,
      JSON.stringify(next),
      channelId
    );
    return next as ChannelSubscriptionConfig;
  }

  listAll(): Array<{ channelId: string; participantId: string | null }> {
    return this.sql
      .exec(`SELECT channel_id, participant_id FROM subscriptions`)
      .toArray()
      .map((row) => ({
        channelId: row["channel_id"] as string,
        participantId: row["participant_id"] as string | null,
      }));
  }

  /** Delete subscription record only (no channel call). Used during unsubscribeChannel cleanup. */
  deleteSubscription(channelId: string): void {
    this.sql.exec(`DELETE FROM subscriptions WHERE channel_id = ?`, channelId);
  }

  /** Number of live subscriptions (fork preflight). */
  count(): number {
    const row = this.sql.exec(`SELECT COUNT(*) AS cnt FROM subscriptions`).toArray()[0];
    return Number(row?.["cnt"] ?? 0);
  }

  listChannelIds(): string[] {
    return this.sql
      .exec(`SELECT channel_id FROM subscriptions ORDER BY channel_id`)
      .toArray()
      .map((row) => String(row["channel_id"]));
  }

  /**
   * Fork bookkeeping: re-key a cloned subscription onto the new channel. When the
   * clone lands in a NEW context (a true context fork — `runtime.cloneContext`),
   * pass `newContextId` to re-home the subscription's `context_id` too; omit it for
   * a same-context re-key.
   */
  rename(oldChannelId: string, newChannelId: string, newContextId?: string): void {
    if (newContextId !== undefined) {
      this.sql.exec(
        `UPDATE subscriptions SET channel_id = ?, context_id = ?, participant_id = ? WHERE channel_id = ?`,
        newChannelId,
        newContextId,
        this.buildParticipantId(),
        oldChannelId
      );
      return;
    }
    this.sql.exec(
      `UPDATE subscriptions SET channel_id = ?, participant_id = ? WHERE channel_id = ?`,
      newChannelId,
      this.buildParticipantId(),
      oldChannelId
    );
  }
}
