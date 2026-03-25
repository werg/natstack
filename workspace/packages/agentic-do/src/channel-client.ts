/**
 * ChannelClient — Typed wrapper for channel DO operations.
 *
 * All operations go through the RPC bridge, which routes to the
 * PubSubChannel DO via the server's DO dispatch.
 */

import type { ChannelEvent, SendMessageOptions } from "@natstack/harness/types";
import type { RpcCaller } from "@natstack/types";

const CHANNEL_SOURCE = "workers/pubsub-channel";
const CHANNEL_CLASS = "PubSubChannel";

export class ChannelClient {
  private doTarget: string;

  constructor(
    private rpc: RpcCaller,
    private channelId: string,
  ) {
    this.doTarget = `do:${CHANNEL_SOURCE}:${CHANNEL_CLASS}:${channelId}`;
  }

  async send(participantId: string, messageId: string, content: string, opts?: SendMessageOptions): Promise<void> {
    await this.rpc.call(this.doTarget, "send", participantId, messageId, content, opts);
  }

  async update(participantId: string, messageId: string, content: string): Promise<void> {
    await this.rpc.call(this.doTarget, "update", participantId, messageId, content);
  }

  async complete(participantId: string, messageId: string): Promise<void> {
    await this.rpc.call(this.doTarget, "complete", participantId, messageId);
  }

  async sendEphemeral(participantId: string, content: string, contentType?: string): Promise<void> {
    await this.rpc.call(this.doTarget, "sendEphemeral", participantId, content, contentType);
  }

  async updateMetadata(participantId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.rpc.call(this.doTarget, "updateMetadata", participantId, metadata);
  }

  async subscribe(participantId: string, metadata: Record<string, unknown>): Promise<{ ok: boolean; channelConfig?: Record<string, unknown>; replay?: ChannelEvent[] }> {
    return this.rpc.call(this.doTarget, "subscribe", participantId, metadata) as Promise<{ ok: boolean; channelConfig?: Record<string, unknown>; replay?: ChannelEvent[] }>;
  }

  async unsubscribe(participantId: string): Promise<void> {
    await this.rpc.call(this.doTarget, "unsubscribe", participantId);
  }

  async getParticipants(): Promise<Array<{ participantId: string; metadata: Record<string, unknown> }>> {
    return this.rpc.call(this.doTarget, "getParticipants") as Promise<Array<{ participantId: string; metadata: Record<string, unknown> }>>;
  }

  async callMethod(callerPid: string, targetPid: string, callId: string, method: string, args: unknown): Promise<void> {
    await this.rpc.call(this.doTarget, "callMethod", callerPid, targetPid, callId, method, args);
  }

  async cancelCall(callId: string): Promise<void> {
    await this.rpc.call(this.doTarget, "cancelMethodCall", callId);
  }

  async updateConfig(config: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.rpc.call(this.doTarget, "updateConfig", config) as Promise<Record<string, unknown>>;
  }
}
