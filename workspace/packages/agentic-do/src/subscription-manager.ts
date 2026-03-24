/**
 * SubscriptionManager — Channel subscriptions, participant identity.
 *
 * Uses ChannelClient (callDO) for subscribe/unsubscribe — no PubSubDOClient.
 * Owns the `subscriptions` table.
 */

import type { SqlStorage } from "@workspace/runtime/worker";
import type { ChannelEvent, ParticipantDescriptor } from "@natstack/harness/types";
import type { DOIdentity } from "./identity.js";
import type { ChannelClient } from "./channel-client.js";

export class SubscriptionManager {
  constructor(
    private sql: SqlStorage,
    private channelFactory: (channelId: string) => ChannelClient,
    private identity: DOIdentity,
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

  /** Build the participant ID from the DO's identity (route path). */
  private buildParticipantId(): string {
    const ref = this.identity.ref;
    return `/_w/${ref.source}/${encodeURIComponent(ref.className)}/${encodeURIComponent(ref.objectKey)}`;
  }

  async subscribe(opts: {
    channelId: string;
    contextId: string;
    config?: unknown;
    descriptor: ParticipantDescriptor;
    /** Request replay of persisted messages sent before this subscriber joined. */
    replay?: boolean;
  }): Promise<{ ok: boolean; participantId: string; channelConfig?: Record<string, unknown>; replay?: ChannelEvent[]; replayTruncated?: boolean }> {
    this.sql.exec(
      `INSERT OR REPLACE INTO subscriptions (channel_id, context_id, subscribed_at, config) VALUES (?, ?, ?, ?)`,
      opts.channelId, opts.contextId, Date.now(), opts.config ? JSON.stringify(opts.config) : null,
    );

    const participantId = this.buildParticipantId();
    const ref = this.identity.ref;

    const metadata: Record<string, unknown> = {
      name: opts.descriptor.name,
      type: opts.descriptor.type,
      handle: opts.descriptor.handle,
      transport: "do",
      doSource: ref.source,
      doClass: ref.className,
      doKey: ref.objectKey,
      contextId: opts.contextId,
      ...opts.descriptor.metadata,
    };
    if (opts.config && typeof opts.config === "object") {
      metadata["channelConfig"] = opts.config;
    }
    if (opts.descriptor.methods && opts.descriptor.methods.length > 0) {
      metadata["methods"] = opts.descriptor.methods;
    }
    if (opts.replay) {
      metadata["replay"] = true;
    }

    const channel = this.channelFactory(opts.channelId);
    const subResult = await channel.subscribe(participantId, metadata);

    this.sql.exec(
      `UPDATE subscriptions SET participant_id = ? WHERE channel_id = ?`,
      participantId, opts.channelId,
    );

    return {
      ok: true,
      participantId,
      channelConfig: subResult?.channelConfig,
      replay: subResult?.replay,
      replayTruncated: subResult?.replayTruncated,
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
    const row = this.sql.exec(
      `SELECT participant_id FROM subscriptions WHERE channel_id = ?`, channelId,
    ).toArray();
    return row.length > 0 ? (row[0]!["participant_id"] as string | null) : null;
  }

  getContextId(channelId: string): string {
    const row = this.sql.exec(
      `SELECT context_id FROM subscriptions WHERE channel_id = ?`, channelId,
    ).toArray();
    if (row.length === 0) throw new Error(`No subscription for channel ${channelId}`);
    return row[0]!["context_id"] as string;
  }

  getConfig(channelId: string): Record<string, unknown> | null {
    const row = this.sql.exec(
      `SELECT config FROM subscriptions WHERE channel_id = ?`, channelId,
    ).toArray();
    if (row.length === 0 || !row[0]!["config"]) return null;
    return JSON.parse(row[0]!["config"] as string);
  }

  /** Delete subscription record only (no channel call). Used during unsubscribeChannel cleanup. */
  deleteSubscription(channelId: string): void {
    this.sql.exec(`DELETE FROM subscriptions WHERE channel_id = ?`, channelId);
  }
}
