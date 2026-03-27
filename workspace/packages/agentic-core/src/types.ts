/**
 * @workspace/agentic-core — Headless-safe types
 *
 * All types here are free of React, browser, and UI dependencies.
 * The React adapter (@workspace/agentic-chat) re-exports these and adds
 * its own UI-specific types on top.
 */

import type {
  MethodAdvertisement,
  ContextWindowUsage,
  AgentBuildError,
  Attachment,
  MethodDefinition,
} from "@natstack/pubsub";
import type { ScopesApi, DbHandle } from "@workspace/eval";
import type { SandboxOptions, SandboxResult } from "@workspace/eval";

// ===========================================================================
// Method History Types (moved from MethodHistoryItem.tsx)
// ===========================================================================

export type MethodCallStatus = "pending" | "success" | "error";

export interface MethodHistoryEntry {
  callId: string;
  methodName: string;
  /** Human-readable description of the method (from MethodAdvertisement) */
  description?: string;
  args: unknown;
  status: MethodCallStatus;
  consoleOutput?: string;
  result?: unknown;
  error?: string;
  startedAt: number;
  completedAt?: number;
  providerId?: string;
  callerId?: string;
  handledLocally?: boolean;
  progress?: number;
}

// ===========================================================================
// Core Chat Types
// ===========================================================================

/** Status of a pending agent */
export type PendingAgentStatus = "starting" | "error";

/** A pending agent that is starting or failed to start */
export interface PendingAgent {
  agentId: string;
  status: PendingAgentStatus;
  error?: AgentBuildError;
}

/** Metadata for participants in this channel */
export interface ChatParticipantMetadata {
  name: string;
  type: "panel" | "ai-responder" | "claude-agent" | "pi" | "subagent";
  handle: string;
  /** Methods this participant provides (for menu display) */
  methods?: MethodAdvertisement[];
  /** Runtime panel/worker ID - allows linking participant to child panel for focus/reload */
  panelId?: string;
  /** Agent type ID for identification (e.g., "claude-agent-responder") */
  agentTypeId?: string;
  /** Context window usage tracking (updated by AI responders) */
  contextUsage?: ContextWindowUsage;
  /** Execution mode - "plan" for planning only, "edit" for full execution */
  executionMode?: "plan" | "edit";
  /** Display name of the model currently in use (e.g., "Claude Opus 4.6") */
  activeModel?: string;
  /** Index signature to satisfy ParticipantMetadata constraint */
  [key: string]: unknown;
}

/** Info about a disconnected agent for notification display */
export interface DisconnectedAgentInfo {
  name: string;
  handle: string;
  panelId?: string;
  agentTypeId?: string;
  type: string;
}

/** A chat message in the conversation */
export interface ChatMessage {
  id: string;
  /** PubSub message ID (numeric, for pagination) */
  pubsubId?: number;
  senderId: string;
  content: string;
  contentType?: string;  // e.g., "thinking", "text/plain", etc.
  kind?: "message" | "method" | "system";
  complete?: boolean;
  replyTo?: string;
  error?: string;
  pending?: boolean;
  method?: MethodHistoryEntry;
  /** Image attachments on this message */
  attachments?: Attachment[];
  /** Sender metadata snapshot for historical messages */
  senderMetadata?: { name?: string; type?: string; handle?: string };
  /** For system messages: disconnected agent info */
  disconnectedAgent?: DisconnectedAgentInfo;
}

// ===========================================================================
// Injection Interfaces
// ===========================================================================

/** Inject connection config instead of importing from runtime */
export interface ConnectionConfig {
  serverUrl: string;
  token: string;
  clientId: string;
  rpc?: {
    call<R = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<R>;
    onEvent(event: string, listener: (fromId: string, payload: unknown) => void): () => void;
    selfId: string;
  };
}

/** Inject platform-specific navigation */
export interface AgenticChatActions {
  onNewConversation?: () => void;
  onAddAgent?: (channelName: string, contextId?: string, agentId?: string) => Promise<{ agentId: string; handle: string } | void>;
  onRemoveAgent?: (channelName: string, handle: string) => Promise<void>;
  availableAgents?: Array<{ id: string; name: string; proposedHandle: string }>;
  onFocusPanel?: (panelId: string) => void;
  onReloadPanel?: (panelId: string) => Promise<void>;
  onBecomeVisible?: () => void;
}

/** Chat API exposed to sandboxed code (eval, inline_ui, feedback_custom) */
export interface ChatSandboxValue {
  publish: (eventType: string, payload: unknown, options?: { persist?: boolean }) => Promise<unknown>;
  callMethod: (participantId: string, method: string, args: unknown) => Promise<unknown>;
  contextId: string;
  channelId: string | null;
  rpc: { call: (target: string, method: string, ...args: unknown[]) => Promise<unknown> };
}

/** Sandbox config injected by the panel (keeps agentic-chat runtime-agnostic) */
export interface SandboxConfig {
  rpc: { call: (target: string, method: string, ...args: unknown[]) => Promise<unknown> };
  loadImport: (specifier: string, ref: string | undefined, externals: string[]) => Promise<string>;
  db: { open: (name: string) => Promise<DbHandle> };
}

/** Dependencies provided to the tool provider factory */
export interface ToolProviderDeps {
  clientRef: { current: { publish: (eventType: string, payload: unknown) => void } | null };
  contextId: string;
  executeSandbox: (code: string, options: SandboxOptions) => Promise<SandboxResult>;
  chat: ChatSandboxValue;
  scope: Record<string, unknown>;
  scopes: ScopesApi;
}

/** Inject tools at connect time */
export type ToolProvider = (deps: ToolProviderDeps) => Record<string, MethodDefinition>;
