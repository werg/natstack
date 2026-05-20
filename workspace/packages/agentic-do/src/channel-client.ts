/**
 * ChannelClient — Typed wrapper for channel DO operations.
 *
 * All operations go through the RPC bridge, which routes to the
 * channel service DO via the server's userland service resolver.
 */
import type { RpcCaller } from "@natstack/rpc";
import type { ReplayEnvelope } from "@workspace/pubsub";
interface ChannelSendOptions {
    contentType?: string;
    senderMetadata?: Record<string, unknown>;
    replyTo?: string;
    idempotencyKey?: string;
    attachments?: Array<{ id?: string; data: string; mimeType: string; name?: string; size?: number }>;
}
const DEFAULT_CHANNEL_SERVICE_PROTOCOL = "natstack.channel.v1";
interface ResolvedService {
    kind: "durable-object" | "worker";
    targetId?: string;
}
export class ChannelClient {
    private targetPromise: Promise<string> | null = null;
    constructor(private rpc: RpcCaller, private channelId: string, private protocol: string = DEFAULT_CHANNEL_SERVICE_PROTOCOL) { }
    private async target(): Promise<string> {
        this.targetPromise ??= this.rpc
            .call<ResolvedService>("main", "workers.resolveService", [this.protocol, this.channelId])
            .then((service) => {
            if (service.kind !== "durable-object" || !service.targetId) {
                throw new Error("Channel service must resolve to a Durable Object service");
            }
            return service.targetId;
        });
        return this.targetPromise;
    }
    private async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        return this.rpc.call<T>(await this.target(), method, [...args]);
    }
    async send(participantId: string, messageId: string, content: string, opts?: ChannelSendOptions): Promise<void> {
        await this.call("send", participantId, messageId, content, opts);
    }
    async update(participantId: string, messageId: string, content: string, idempotencyKey?: string, opts?: {
        append?: boolean;
    }): Promise<void> {
        await this.call("update", participantId, messageId, content, idempotencyKey, opts);
    }
    async complete(participantId: string, messageId: string, idempotencyKey?: string): Promise<void> {
        await this.call("complete", participantId, messageId, idempotencyKey);
    }
    async error(participantId: string, messageId: string, error: string, code?: string): Promise<void> {
        await this.call("error", participantId, messageId, error, code);
    }
    async sendSignal(participantId: string, content: string, contentType?: string): Promise<void> {
        await this.call("sendSignal", participantId, content, contentType);
    }
    /**
     * Typed wrapper for signal messages with structured (JSON) payloads.
     * The payload is JSON-serialized and routed through the same string-based
     * sendSignal path. Receivers decode via
     * `parseSignalEvent` from `@workspace/agentic-core`.
     */
    async sendSignalEvent<T>(participantId: string, contentType: string, payload: T): Promise<void> {
        await this.sendSignal(participantId, JSON.stringify(payload), contentType);
    }
    async updateMetadata(participantId: string, metadata: Record<string, unknown>): Promise<void> {
        await this.call("updateMetadata", participantId, metadata);
    }
    async setTypingState(participantId: string, typing: boolean): Promise<void> {
        await this.call("setTypingState", participantId, typing);
    }
    async subscribe(participantId: string, metadata: Record<string, unknown>): Promise<{
        ok: boolean;
        channelConfig?: Record<string, unknown>;
        envelope: ReplayEnvelope;
    }> {
        return this.call("subscribe", participantId, metadata) as Promise<{
            ok: boolean;
            channelConfig?: Record<string, unknown>;
            envelope: ReplayEnvelope;
        }>;
    }
    async unsubscribe(participantId: string): Promise<void> {
        await this.call("unsubscribe", participantId);
    }
    async getParticipants(): Promise<Array<{
        participantId: string;
        metadata: Record<string, unknown>;
    }>> {
        return this.call("getParticipants") as Promise<Array<{
            participantId: string;
            metadata: Record<string, unknown>;
        }>>;
    }
    async callMethod(callerPid: string, targetPid: string, callId: string, method: string, args: unknown): Promise<void> {
        await this.call("callMethod", callerPid, targetPid, callId, method, args);
    }
    async cancelCall(callId: string): Promise<void> {
        await this.call("cancelMethodCall", callId);
    }
    async getReplayAfter(sinceId: number): Promise<ReplayEnvelope> {
        return this.call("getReplayAfter", sinceId) as Promise<ReplayEnvelope>;
    }
    async updateConfig(config: Record<string, unknown>): Promise<Record<string, unknown>> {
        return this.call("updateConfig", config) as Promise<Record<string, unknown>>;
    }
}
