/** Usage metrics returned after a completed turn */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Events emitted by a harness process back to the server */
export type HarnessOutput =
  | { type: 'thinking-start' }
  | { type: 'thinking-delta'; content: string }
  | { type: 'thinking-end' }
  | { type: 'text-start'; metadata?: Record<string, unknown> }
  | { type: 'text-delta'; content: string }
  | { type: 'text-end' }
  | { type: 'action-start'; tool: string; description: string; toolUseId: string }
  | { type: 'action-update'; toolUseId: string; content: string }
  | { type: 'action-end'; toolUseId: string }
  | { type: 'inline-ui'; data: unknown }
  | { type: 'approval-needed'; toolUseId: string; toolName: string; input: unknown }
  | { type: 'message-complete' }
  | { type: 'turn-complete'; sessionId: string; usage?: TurnUsage }
  | { type: 'error'; error: string; code?: string }
  | { type: 'metadata-update'; metadata: Record<string, unknown> }
  | { type: 'ready' }
  | { type: 'tool-call'; callId: string; participantId: string; method: string; args: unknown }
  | { type: 'discover-methods' };

/** Per-turn settings the panel can pass to influence harness behavior */
export interface HarnessSettings {
  model?: string;
  maxTokens?: number;
  maxThinkingTokens?: number;
  temperature?: number;
}

/** Configuration for a harness — passed via spawn-harness action */
export interface HarnessConfig {
  systemPrompt?: string;
  /**
   * How the systemPrompt interacts with the SDK's built-in system prompt.
   * - `"append"` (default): Appends to the SDK's default prompt AND the
   *   base NatStack prompt (tool inventory, skill routing, interaction style).
   * - `"replace-natstack"`: Replaces the NatStack prompt but still appends
   *   to the SDK's built-in prompt (tool instructions, coding guidelines).
   * - `"replace"`: Replaces everything — SDK defaults and NatStack prompt.
   */
  systemPromptMode?: "append" | "replace-natstack" | "replace";
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Maximum tokens for extended thinking. Defaults to 10240 in the adapter. */
  maxThinkingTokens?: number;
  mcpServers?: Array<{
    name: string;
    tools: Array<{ name: string; description: string; inputSchema: unknown }>;
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

/** Attachment on a channel message — canonical format for all transports */
export interface Attachment {
  /** Stable ID for binary frame correlation */
  id: string;
  /** Derived convenience: "image" | "file" */
  type?: string;
  /** Base64-encoded content */
  data: string;
  mimeType: string;
  filename?: string;
  /** Byte size for binary frame slicing */
  size: number;
}

/** Channel event — canonical format for all transports (WS + DO) */
export interface ChannelEvent {
  id: number;
  messageId: string;
  type: string;
  payload: unknown;
  senderId: string;
  senderMetadata?: Record<string, unknown>;
  /** Content type from the payload (e.g., "typing" for typing indicators) */
  contentType?: string;
  ts: number;
  persist: boolean;
  attachments?: Attachment[];
}

/** Options for sending a channel message (used by DO clients and PubSub server) */
export interface SendMessageOptions {
  contentType?: string;
  persist?: boolean;
  senderMetadata?: Record<string, unknown>;
  replyTo?: string;
  idempotencyKey?: string;
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
export type HarnessCommand =
  | { type: 'start-turn'; input: TurnInput }
  | { type: 'approve-tool'; toolUseId: string; allow: boolean; alwaysAllow?: boolean; updatedInput?: Record<string, unknown> }
  | { type: 'interrupt' }
  | { type: 'fork'; forkPointMessageId: number; turnSessionId: string }
  | { type: 'dispose' }
  | { type: 'tool-result'; callId: string; result: unknown; isError?: boolean }
  | { type: 'discover-methods-result'; methods: Array<{ participantId: string; name: string; description: string; parameters?: unknown }> };

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

