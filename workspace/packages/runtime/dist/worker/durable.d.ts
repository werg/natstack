import type { ChannelEvent, HarnessConfig, HarnessOutput, TurnInput, ParticipantDescriptor, UnsubscribeResult } from "@natstack/harness/types";
import { PubSubDOClient } from "./pubsub-client.js";
import { ServerDOClient } from "./server-client.js";
import { StreamWriter, type PersistedStreamState } from "./stream-writer.js";
interface DurableObjectContext {
    storage: {
        sql: SqlStorage;
    };
}
interface SqlStorage {
    exec(query: string, ...bindings: unknown[]): SqlResult;
}
interface SqlResult {
    toArray(): Record<string, unknown>[];
    one(): Record<string, unknown>;
}
interface AlignmentState {
    lastAlignedMessageId: number | null;
}
interface WebSocketMessage {
    data: string | ArrayBuffer;
}
export interface DORef {
    source: string;
    className: string;
    objectKey: string;
}
export type { DurableObjectContext, SqlStorage, SqlResult, AlignmentState };
export declare abstract class AgentWorkerBase {
    protected ctx: DurableObjectContext;
    protected sql: SqlStorage;
    protected pubsub: PubSubDOClient;
    protected server: ServerDOClient;
    /** DO identity — set by bootstrap(), stored in SQLite */
    protected doRef: DORef;
    /** Session ID from last bootstrap — used for restart detection */
    protected workerdSessionId: string | null;
    constructor(ctx: DurableObjectContext, env: unknown);
    static schemaVersion: number;
    protected ensureSchema(): void;
    private createTables;
    bootstrap(doRef: DORef, sessionId: string): Promise<void>;
    private restoreIdentity;
    /** Which harness type to spawn. Override for different AI providers. */
    protected getHarnessType(): string;
    /** Configuration for the harness. Override to customize AI behavior. */
    protected getHarnessConfig(): HarnessConfig;
    /** Filter: should this channel event trigger a turn?
     *  Protocol messages (typing indicators, method results, etc.) have a
     *  contentType. Only plain user chat messages trigger AI turns. */
    protected shouldProcess(event: ChannelEvent): boolean;
    /** Build TurnInput from a channel event. */
    protected buildTurnInput(event: ChannelEvent): TurnInput;
    /** Declare PubSub identity for a channel. */
    protected getParticipantInfo(_channelId: string, _config?: unknown): ParticipantDescriptor;
    protected createWriter(channelId: string, turn: {
        replyToId: string;
        typingContent: string;
        streamState: PersistedStreamState;
    }): StreamWriter;
    subscribeChannel(opts: {
        channelId: string;
        contextId: string;
        config?: unknown;
    }): Promise<{
        ok: boolean;
        participantId: string;
    }>;
    unsubscribeChannel(channelId: string): Promise<UnsubscribeResult>;
    protected getContextId(channelId: string): string;
    protected getSubscriptionConfig(channelId: string): Record<string, unknown> | null;
    protected getHarnessForChannel(channelId: string): string | null;
    protected getChannelForHarness(harnessId: string): string | null;
    registerHarness(harnessId: string, channelId: string, type: string): void;
    reactivateHarness(harnessId: string): void;
    recordTurnStart(harnessId: string, channelId: string, input: TurnInput, triggerMessageId: string, triggerPubsubId: number, senderParticipantId?: string): void;
    protected setActiveTurn(harnessId: string, channelId: string, replyToId: string, turnMessageId?: string, senderParticipantId?: string, typingContent?: string): void;
    protected getActiveTurn(harnessId: string): {
        channelId: string;
        replyToId: string;
        turnMessageId: string | null;
        senderParticipantId: string | null;
        typingContent: string;
        streamState: PersistedStreamState;
    } | null;
    protected updateActiveTurnMessageId(harnessId: string, turnMessageId: string): void;
    protected clearActiveTurn(harnessId: string): void;
    protected setInFlightTurn(channelId: string, harnessId: string, messageId: string, pubsubId: number, input: TurnInput): void;
    protected getInFlightTurn(channelId: string, harnessId: string): {
        triggerMessageId: string;
        triggerPubsubId: number;
        turnInput: TurnInput;
    } | null;
    protected clearInFlightTurn(channelId: string, harnessId: string): void;
    protected advanceCheckpoint(channelId: string, harnessId: string | null, pubsubId: number): void;
    protected getCheckpoint(channelId: string, harnessId: string | null): number | null;
    protected recordTurn(harnessId: string, messageId: string, triggerPubsubId: number, sessionId: string): void;
    protected getTurnAtOrBefore(harnessId: string, pubsubId: number): {
        turnMessageId: string;
        externalSessionId: string;
    } | null;
    protected getLatestTurn(harnessId: string): {
        turnMessageId: string;
        externalSessionId: string;
    } | null;
    protected getResumeSessionId(harnessId: string): string | undefined;
    /** Find the most recent session ID across all harnesses on a channel (for restart recovery). */
    protected getResumeSessionIdForChannel(channelId: string): string | undefined;
    protected getAlignment(harnessId: string): AlignmentState;
    protected getParticipantId(channelId: string): string | null;
    protected setApprovalLevel(channelId: string, level: number): void;
    protected getApprovalLevel(channelId: string): number;
    protected shouldAutoApprove(channelId: string, toolName: string): boolean;
    /**
     * Re-evaluate all pending approval calls for a channel.
     * Called when approval level changes — the DO is the single authority,
     * so it actively resolves any in-flight approvals that the new level permits.
     */
    protected reevaluatePendingApprovals(channelId: string): Promise<void>;
    protected pendingCall(callId: string, channelId: string, type: string, context: Record<string, unknown>): void;
    protected consumePendingCall(callId: string): {
        channelId: string;
        type: string;
        context: Record<string, unknown>;
    } | null;
    /** Entry point called when an async method-call result arrives from PubSub. */
    onCallResult(callId: string, result: unknown, isError: boolean): Promise<void>;
    /** Override in subclasses to handle different continuation types. */
    protected handleCallResult(_type: string, _context: Record<string, unknown>, _channelId: string, _result: unknown, _isError: boolean): Promise<void>;
    persistStreamState(harnessId: string, writer: StreamWriter): void;
    abstract onChannelEvent(channelId: string, event: ChannelEvent): Promise<void>;
    abstract onHarnessEvent(harnessId: string, event: HarnessOutput): Promise<void>;
    /**
     * Called when a method call arrives from another participant via PubSub.
     * Returns the result directly (not WorkerActions).
     */
    onMethodCall(_channelId: string, _callId: string, _methodName: string, _args: unknown): Promise<{
        result: unknown;
        isError?: boolean;
    }>;
    /** Called when a channel fork completes. */
    onChannelForked(_sourceChannel: string, _forkedChannelId: string, _forkPointId: number): Promise<void>;
    getState(): Promise<Record<string, unknown>>;
    webSocketMessage(_ws: unknown, _message: WebSocketMessage): void;
    webSocketClose(_ws: unknown, _code: number, _reason: string, _wasClean: boolean): void;
    webSocketError(_ws: unknown, _error: unknown): void;
    /**
     * HTTP fetch handler — routes /{method} POST requests to DO methods.
     * Called by workerd when the router worker proxies to this DO.
     *
     * Uses the /_w/ URL scheme (source-scoped).
     */
    fetch(request: Request): Promise<Response>;
}
//# sourceMappingURL=durable.d.ts.map