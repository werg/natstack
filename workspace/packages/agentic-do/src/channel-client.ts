/**
 * ChannelClient — Typed wrapper for channel DO operations.
 *
 * All operations go through the RPC bridge, which routes to the
 * channel service DO via the server's userland service resolver.
 */

import type { ChannelEvent, SendMessageOptions } from "@natstack/harness/types";
import type { RpcCaller } from "@natstack/rpc";

const CHANNEL_SERVICE_PROTOCOL = "natstack.channel.v1";

interface ResolvedService {
  kind: "durable-object" | "worker";
  targetId?: string;
}

export class ChannelClient {
  private targetPromise: Promise<string> | null = null;

  constructor(
    private rpc: RpcCaller,
    private channelId: string,
  ) {}

  private async target(): Promise<string> {
    this.targetPromise ??= this.rpc
      .call<ResolvedService>("main", "workers.resolveService", CHANNEL_SERVICE_PROTOCOL, this.channelId)
      .then((service) => {
        if (service.kind !== "durable-object" || !service.targetId) {
          throw new Error("Channel service must resolve to a Durable Object service");
        }
        return service.targetId;
      });
    return this.targetPromise;
  }

  private async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return this.rpc.call<T>(await this.target(), method, ...args);
  }

  async send(participantId: string, messageId: string, content: string, opts?: SendMessageOptions): Promise<void> {
    await this.call("send", participantId, messageId, content, opts);
  }

  async update(
    participantId: string,
    messageId: string,
    content: string,
    idempotencyKey?: string,
    opts?: { append?: boolean },
  ): Promise<void> {
    await this.call("update", participantId, messageId, content, idempotencyKey, opts);
  }

  async complete(participantId: string, messageId: string, idempotencyKey?: string): Promise<void> {
    await this.call("complete", participantId, messageId, idempotencyKey);
  }

  async error(participantId: string, messageId: string, error: string, code?: string): Promise<void> {
    await this.call("error", participantId, messageId, error, code);
  }

  async sendEphemeral(participantId: string, content: string, contentType?: string): Promise<void> {
    await this.call("sendEphemeral", participantId, content, contentType);
  }

  /**
   * Typed wrapper for ephemeral messages with structured (JSON) payloads.
   * The payload is JSON-serialized and routed through the same string-based
   * sendEphemeral path. Receivers decode via
   * `parseEphemeralEvent` from `@workspace/agentic-core`.
   */
  async sendEphemeralEvent<T>(participantId: string, contentType: string, payload: T): Promise<void> {
    await this.sendEphemeral(participantId, JSON.stringify(payload), contentType);
  }

  async updateMetadata(participantId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.call("updateMetadata", participantId, metadata);
  }

  async setTypingState(participantId: string, typing: boolean): Promise<void> {
    await this.call("setTypingState", participantId, typing);
  }

  async subscribe(participantId: string, metadata: Record<string, unknown>): Promise<{ ok: boolean; channelConfig?: Record<string, unknown>; replay?: ChannelEvent[]; replayTruncated?: boolean }> {
    return this.call("subscribe", participantId, metadata) as Promise<{ ok: boolean; channelConfig?: Record<string, unknown>; replay?: ChannelEvent[]; replayTruncated?: boolean }>;
  }

  async unsubscribe(participantId: string): Promise<void> {
    await this.call("unsubscribe", participantId);
  }

  async getParticipants(): Promise<Array<{ participantId: string; metadata: Record<string, unknown> }>> {
    return this.call("getParticipants") as Promise<Array<{ participantId: string; metadata: Record<string, unknown> }>>;
  }

  async callMethod(callerPid: string, targetPid: string, callId: string, method: string, args: unknown): Promise<void> {
    await this.call("callMethod", callerPid, targetPid, callId, method, args);
  }

  async cancelCall(callId: string): Promise<void> {
    await this.call("cancelMethodCall", callId);
  }

  /** Phase 2A: Fetch persisted events in a sequence range (for gap repair). */
  async getEventRange(fromSeq: number, toSeq: number): Promise<ChannelEvent[]> {
    return this.call("getEventRange", fromSeq, toSeq) as Promise<ChannelEvent[]>;
  }

  async updateConfig(config: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call("updateConfig", config) as Promise<Record<string, unknown>>;
  }
}
