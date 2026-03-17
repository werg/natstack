/** Usage metrics returned after a completed turn */
export interface TurnUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}
/** Events emitted by a harness process back to the server */
export type HarnessOutput = {
    type: 'thinking-start';
} | {
    type: 'thinking-delta';
    content: string;
} | {
    type: 'thinking-end';
} | {
    type: 'text-start';
    metadata?: Record<string, unknown>;
} | {
    type: 'text-delta';
    content: string;
} | {
    type: 'text-end';
} | {
    type: 'action-start';
    tool: string;
    description: string;
    toolUseId: string;
} | {
    type: 'action-end';
    toolUseId: string;
} | {
    type: 'inline-ui';
    data: unknown;
} | {
    type: 'approval-needed';
    toolUseId: string;
    toolName: string;
    input: unknown;
} | {
    type: 'message-complete';
} | {
    type: 'turn-complete';
    sessionId: string;
    usage?: TurnUsage;
} | {
    type: 'error';
    error: string;
    code?: string;
} | {
    type: 'interleave-point';
} | {
    type: 'metadata-update';
    metadata: Record<string, unknown>;
} | {
    type: 'ready';
} | {
    type: 'tool-call';
    callId: string;
    participantId: string;
    method: string;
    args: unknown;
} | {
    type: 'discover-methods';
};
/** Per-turn settings the panel can pass to influence harness behavior */
export interface HarnessSettings {
    model?: string;
    systemPrompt?: string;
    maxTokens?: number;
    maxThinkingTokens?: number;
    temperature?: number;
}
/** Configuration for a harness — passed via spawn-harness action */
export interface HarnessConfig {
    systemPrompt?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    /** Maximum tokens for extended thinking. Defaults to 10240 in the adapter. */
    maxThinkingTokens?: number;
    mcpServers?: Array<{
        name: string;
        tools: Array<{
            name: string;
            description: string;
            inputSchema: unknown;
        }>;
    }>;
    extraEnv?: Record<string, string>;
    adapterConfig?: Record<string, unknown>;
    /**
     * Allowlist of discovered method names to expose as MCP tools.
     * When set, only methods whose name is in this list are created as tools.
     * When unset, all discovered methods are exposed (filtered only by
     * `internal` flags and self-exclusion on the server side).
     *
     * Defense-in-depth: prevents accidental exposure even if a method
     * forgets `internal: true` or an unexpected participant joins.
     */
    toolAllowlist?: string[];
}
/** Attachment on a user message */
export interface Attachment {
    type: string;
    data: string;
    mimeType?: string;
    filename?: string;
}
/** Channel event as delivered to a worker DO */
export interface ChannelEvent {
    id: number;
    messageId: string;
    type: string;
    payload: unknown;
    senderId: string;
    senderType?: string;
    /** Content type from the payload (e.g., "typing" for typing indicators) */
    contentType?: string;
    ts: number;
    persist: boolean;
    attachments?: Attachment[];
}
/**
 * Raw broadcast event shape from PubSub server (wire format).
 * Used as input to `toChannelEvent()`.
 */
export interface ChannelBroadcastEventRaw {
    id: number;
    type: string;
    payload: unknown;
    senderId: string;
    ts: number;
    persist: boolean;
    senderMetadata?: string | Record<string, unknown>;
    attachments?: Array<{
        mimeType?: string;
        data: unknown;
        name?: string;
    }>;
}
/**
 * Convert a raw PubSub ChannelBroadcastEvent into the ChannelEvent shape
 * that worker DOs consume. Extracts senderType from senderMetadata,
 * contentType and messageId from payload, maps attachments.
 */
export declare function toChannelEvent(raw: ChannelBroadcastEventRaw): ChannelEvent;
/** Options for sending a channel message (used by DO clients and PubSub server) */
export interface SendMessageOptions {
    contentType?: string;
    persist?: boolean;
    senderMetadata?: Record<string, unknown>;
    replyTo?: string;
}
/** Input for starting a new AI turn */
export interface TurnInput {
    content: string;
    senderId: string;
    context?: string;
    attachments?: Attachment[];
    settings?: HarnessSettings;
}
/** Commands sent from server to harness process */
export type HarnessCommand = {
    type: 'start-turn';
    input: TurnInput;
} | {
    type: 'approve-tool';
    toolUseId: string;
    allow: boolean;
    alwaysAllow?: boolean;
    updatedInput?: Record<string, unknown>;
} | {
    type: 'interrupt';
} | {
    type: 'fork';
    forkPointMessageId: number;
    turnSessionId: string;
} | {
    type: 'dispose';
} | {
    type: 'tool-result';
    callId: string;
    result: unknown;
    isError?: boolean;
} | {
    type: 'discover-methods-result';
    methods: Array<{
        participantId: string;
        name: string;
        description: string;
        parameters?: unknown;
    }>;
};
/** PubSub participant identity — returned by subscribeChannel() */
export interface ParticipantDescriptor {
    handle: string;
    name: string;
    type: string;
    metadata?: Record<string, unknown>;
    methods?: MethodAdvertisement[];
}
/** Method callable by other participants */
export interface MethodAdvertisement {
    name: string;
    description: string;
    parameters?: unknown;
}
/** Result from unsubscribing a channel */
export interface UnsubscribeResult {
    harnessIds: string[];
}
//# sourceMappingURL=types.d.ts.map