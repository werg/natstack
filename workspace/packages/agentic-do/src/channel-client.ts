/**
 * ChannelClient — Typed wrapper for channel DO operations.
 *
 * All operations go through the RPC bridge, which routes to the
 * channel service DO via the server's userland service resolver.
 */
import type { RpcCaller } from "@natstack/rpc";
import type { ChannelReplayEnvelope } from "@workspace/pubsub";
import {
    AGENTIC_EVENT_PAYLOAD_KIND,
    AGENTIC_PROTOCOL_VERSION,
    type AgenticEvent,
} from "@workspace/agentic-protocol";
interface ChannelSendOptions {
    senderMetadata?: Record<string, unknown>;
    replyTo?: string;
    mentions?: string[];
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
        const senderMetadata = opts?.senderMetadata ?? {};
        const participantType = typeof senderMetadata["type"] === "string" ? senderMetadata["type"] : undefined;
        const displayName = typeof senderMetadata["name"] === "string" ? senderMetadata["name"] : participantId;
        const event: AgenticEvent = {
            kind: "message.completed",
            actor: {
                kind: participantType === "agent" ? "agent" : participantType === "headless" ? "user" : "panel",
                id: participantId,
                displayName,
                metadata: senderMetadata,
            },
            causality: { messageId: messageId as never },
            payload: {
                protocol: AGENTIC_PROTOCOL_VERSION,
                role: participantType === "agent" ? "assistant" : "user",
                content,
                blocks: [{ type: "text", content }],
                mentions: opts?.mentions,
                replyTo: opts?.replyTo as never,
            },
            createdAt: new Date().toISOString(),
        };
        await this.publishAgenticEvent(participantId, event, {
            idempotencyKey: opts?.idempotencyKey,
            senderMetadata,
        });
    }
    async publishAgenticEvent(participantId: string, event: AgenticEvent, opts?: {
        idempotencyKey?: string;
        senderMetadata?: Record<string, unknown>;
    }): Promise<{ id?: number }> {
        return this.call("publish", participantId, AGENTIC_EVENT_PAYLOAD_KIND, event, opts);
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
        envelope: ChannelReplayEnvelope;
    }> {
        return this.call("subscribe", participantId, metadata) as Promise<{
            ok: boolean;
            channelConfig?: Record<string, unknown>;
            envelope: ChannelReplayEnvelope;
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
    async callMethod(
        callerPid: string,
        targetPid: string,
        callId: string,
        method: string,
        args: unknown,
        opts?: { invocationId?: string; transportCallId?: string; turnId?: string; timeoutMs?: number }
    ): Promise<void> {
        await this.call("callMethod", callerPid, targetPid, callId, method, args, opts);
    }
    async cancelCall(callId: string): Promise<void> {
        await this.call("cancelMethodCall", callId);
    }
    /**
     * Phase 2: read the channel DO's canonical, terminal-once settled result for
     * a method call — the cross-DO recovery authority. Lets a reconnecting caller
     * or a hibernated agent re-learn a result whose ephemeral live delivery it
     * missed. Returns null if not (yet) settled.
     */
    async getSettledResult(callId: string): Promise<{
        content: unknown;
        isError: boolean;
        terminalOutcome: string | null;
        terminalReasonCode: string | null;
        contentType?: string | null;
        attachmentsReplayable?: boolean;
    } | null> {
        return this.call("getSettledResult", callId) as Promise<{
            content: unknown;
            isError: boolean;
            terminalOutcome: string | null;
            terminalReasonCode: string | null;
            contentType?: string | null;
            attachmentsReplayable?: boolean;
        } | null>;
    }
    async timeoutCall(callId: string, reason?: string): Promise<void> {
        await this.call("timeoutMethodCall", callId, reason);
    }
    async getReplayAfter(sinceId: number): Promise<ChannelReplayEnvelope> {
        return this.call("getReplayAfter", sinceId) as Promise<ChannelReplayEnvelope>;
    }
    async updateConfig(config: Record<string, unknown>): Promise<Record<string, unknown>> {
        return this.call("updateConfig", config) as Promise<Record<string, unknown>>;
    }
}
