/**
 * ChannelClient — Typed wrapper for channel DO operations.
 *
 * All operations are HTTP POST through the workerd router.
 * The router dispatches to the PubSubChannel DO via namespace binding.
 */

import type { ChannelEvent, SendMessageOptions } from "@natstack/harness/types";

const CHANNEL_SOURCE = "workers/pubsub-channel";
const CHANNEL_CLASS = "PubSubChannel";

export class ChannelClient {
  constructor(
    private postToDO: (source: string, cls: string, key: string, method: string, ...args: unknown[]) => Promise<unknown>,
    private channelId: string,
  ) {}

  async send(participantId: string, messageId: string, content: string, opts?: SendMessageOptions): Promise<void> {
    await this.postToDO(CHANNEL_SOURCE, CHANNEL_CLASS, this.channelId, "send", participantId, messageId, content, opts);
  }

  async update(participantId: string, messageId: string, content: string): Promise<void> {
    await this.postToDO(CHANNEL_SOURCE, CHANNEL_CLASS, this.channelId, "update", participantId, messageId, content);
  }

  async complete(participantId: string, messageId: string): Promise<void> {
    await this.postToDO(CHANNEL_SOURCE, CHANNEL_CLASS, this.channelId, "complete", participantId, messageId);
  }

  async sendEphemeral(participantId: string, content: string, contentType?: string): Promise<void> {
    await this.postToDO(CHANNEL_SOURCE, CHANNEL_CLASS, this.channelId, "sendEphemeral", participantId, content, contentType);
  }

  async updateMetadata(participantId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.postToDO(CHANNEL_SOURCE, CHANNEL_CLASS, this.channelId, "updateMetadata", participantId, metadata);
  }

  async subscribe(participantId: string, metadata: Record<string, unknown>): Promise<{ ok: boolean; channelConfig?: Record<string, unknown>; replay?: ChannelEvent[] }> {
    return this.postToDO(CHANNEL_SOURCE, CHANNEL_CLASS, this.channelId, "subscribe", participantId, metadata) as Promise<{ ok: boolean; channelConfig?: Record<string, unknown>; replay?: ChannelEvent[] }>;
  }

  async unsubscribe(participantId: string): Promise<void> {
    await this.postToDO(CHANNEL_SOURCE, CHANNEL_CLASS, this.channelId, "unsubscribe", participantId);
  }

  async getParticipants(): Promise<Array<{ participantId: string; metadata: Record<string, unknown> }>> {
    return this.postToDO(CHANNEL_SOURCE, CHANNEL_CLASS, this.channelId, "getParticipants") as Promise<Array<{ participantId: string; metadata: Record<string, unknown> }>>;
  }

  async callMethod(callerPid: string, targetPid: string, callId: string, method: string, args: unknown): Promise<void> {
    await this.postToDO(CHANNEL_SOURCE, CHANNEL_CLASS, this.channelId, "callMethod", callerPid, targetPid, callId, method, args);
  }

  async cancelCall(callId: string): Promise<void> {
    await this.postToDO(CHANNEL_SOURCE, CHANNEL_CLASS, this.channelId, "cancelMethodCall", callId);
  }

  async updateConfig(config: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.postToDO(CHANNEL_SOURCE, CHANNEL_CLASS, this.channelId, "updateConfig", config) as Promise<Record<string, unknown>>;
  }
}
