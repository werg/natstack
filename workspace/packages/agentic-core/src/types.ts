/**
 * @workspace/agentic-core — Headless-safe types
 *
 * All types here are free of React, browser, and UI dependencies.
 * The React adapter (@workspace/agentic-chat) re-exports these and adds
 * its own UI-specific types on top.
 *
 * Pi (`@workspace/pi-core`) owns the agent message shape now.
 * `AgentMessage` is re-exported from `index.ts` for downstream consumers.
 */

import type {
  ChatParticipantMetadata,
  CustomMessageDisplayMode,
  MessageTypeDefinition,
  MethodDefinition,
  Participant,
  RegisterMessageTypeInput,
} from "@workspace/pubsub";
import type { MessageTier } from "@workspace/agentic-protocol";
import type { RecoveryCoordinator } from "@natstack/shared/shell/recoveryCoordinator";
import type { ScopesApi } from "@workspace/eval";
import type { SandboxOptions, SandboxResult } from "@workspace/eval";
import type { ChatMethodResult } from "./invocation-result.js";
import type { AgentSubscriptionConfig } from "./agent-subscription-config.js";
import type { ModelCatalog } from "@workspace/model-catalog/catalog";

// The canonical participant metadata shape lives in @workspace/pubsub so that
// lower-level packages (like @workspace/agentic-do, which can't depend on
// agentic-core) and higher-level chat consumers see exactly the same type.
export type { ChatParticipantMetadata } from "@workspace/pubsub";

// ===========================================================================
// Injection Interfaces
// ===========================================================================

/** Inject connection config instead of importing from runtime */
export interface ConnectionConfig {
  /** Stable participant id. Panel callers should pass runtime `slotId`, not `rpc.selfId`. */
  clientId: string;
  rpc: {
    call<R = unknown>(targetId: string, method: string, args: unknown[]): Promise<R>;
    on(event: string, listener: (event: { payload: unknown }) => void): () => void;
    selfId: string;
  };
  protocol?: string;
  recoveryCoordinator?: Pick<RecoveryCoordinator, "registerColdRecoverHandler">;
}

/** A selectable agent type, enriched from worker manifest `agent` metadata. */
export interface AvailableAgent {
  /** Worker source path, e.g. "workers/agent-worker". */
  id: string;
  className: string;
  name: string;
  description?: string;
  /** Emoji/icon for the agent gallery. */
  icon?: string;
  /** Optional manifest-provided defaults for new subscriptions of this agent type. */
  defaultConfig?: AgentSubscriptionConfig;
  proposedHandle: string;
}

/** Result of connecting a model provider's credential. */
export interface ConnectProviderResult {
  ok: boolean;
  error?: string;
}

/** Inject platform-specific navigation */
export interface AgenticChatActions {
  onNewConversation?: () => void;
  /** Add a new agent to the channel, optionally with a full subscription config. */
  onAddAgent?: (
    channelName: string,
    contextId?: string,
    agentId?: string,
    config?: AgentSubscriptionConfig
  ) => Promise<{ agentId: string; handle: string } | void>;
  /**
   * Replace an existing agent (resolved by its participant id) with a fresh DO,
   * reusing the same handle. Used for "switch agent" and "restart with new model"
   * (model is not live-mutable). History is restored via channel replay.
   */
  onReplaceAgent?: (
    channelName: string,
    participantId: string,
    agentId?: string,
    config?: AgentSubscriptionConfig
  ) => Promise<{ agentId: string; handle: string } | void>;
  onRemoveAgent?: (channelName: string, handle: string) => Promise<void>;
  /** Connect a model provider's credential (model picker "Connect" affordance). */
  onConnectProvider?: (
    providerId: string,
    modelBaseUrl: string,
    opts?: { browser?: "internal" | "external" }
  ) => Promise<ConnectProviderResult>;
  onPersistAgentModel?: (
    channelName: string,
    participantId: string,
    model: string
  ) => Promise<void>;
  availableAgents?: AvailableAgent[];
  /** Static pi model catalog; connection status is merged panel-side. */
  modelCatalog?: ModelCatalog | null;
  /** Workspace default model ref ("provider:modelId") for new agents. */
  defaultModelRef?: string | null;
  /** Model refs ("provider:modelId") the panel has a usable credential for. */
  connectedModelRefs?: string[];
  onFocusPanel?: (panelId: string) => void;
  onReloadPanel?: (panelId: string) => Promise<void>;
  onBecomeVisible?: () => void;
}

/** Chat API exposed to sandboxed code (eval, inline_ui, action bars, feedback_custom) */
export interface ChatSandboxValue {
  publish: (eventType: string, payload: unknown, options?: { idempotencyKey?: string }) => Promise<unknown>;
  send: (content: string, options?: { idempotencyKey?: string; tier?: MessageTier }) => Promise<unknown>;
  publishCustomMessage: (
    input: { typeId: string; initialState?: unknown; displayMode?: CustomMessageDisplayMode },
    options?: { idempotencyKey?: string }
  ) => Promise<{ messageId: string; pubsubId: number | undefined }>;
  updateCustomMessage: (
    messageId: string,
    update: unknown,
    options?: { idempotencyKey?: string }
  ) => Promise<number | undefined>;
  /** Register (or refresh) a custom message renderer on the channel. */
  registerMessageType: (
    input: RegisterMessageTypeInput,
    options?: { idempotencyKey?: string }
  ) => Promise<number | undefined>;
  /** Retire a custom message renderer (tombstones the typeId at the current seq). */
  clearMessageType: (
    typeId: string,
    options?: { idempotencyKey?: string }
  ) => Promise<number | undefined>;
  /** Look up a single registered message type (null when absent/cleared). */
  getMessageType: (typeId: string) => Promise<MessageTypeDefinition | null>;
  /** List all registered message types on the channel. */
  getMessageTypes: () => Promise<MessageTypeDefinition[]>;
  /** Call a participant method and resolve to the provider's result payload. */
  callMethod: (
    participantId: string,
    method: string,
    args: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ) => Promise<unknown>;
  /** Call a participant method and resolve to the full invocation result envelope. */
  callMethodResult: (
    participantId: string,
    method: string,
    args: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ) => Promise<ChatMethodResult>;
  /** Resolve a participant by handle, accepting either "handle" or "@handle". */
  participantByHandle: (handle: string) => Participant<ChatParticipantMetadata> | null;
  /** Call a participant method by handle and resolve to the provider's result payload. */
  callMethodByHandle: (
    handle: string,
    method: string,
    args: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ) => Promise<unknown>;
  /** Call a participant method by handle and resolve to the full invocation result envelope. */
  callMethodResultByHandle: (
    handle: string,
    method: string,
    args: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ) => Promise<ChatMethodResult>;
  /**
   * Scroll the chat to a message and briefly highlight it. Resolves false
   * when the message is not currently in the rendered transcript (e.g. paged
   * out of history). Lets cards hand the user to something they created —
   * "Reply" on a digest row focuses the compose card it produced.
   */
  focusMessage: (messageId: string) => Promise<boolean>;
  contextId: string;
  channelId: string | null;
  rpc: { call: (target: string, method: string, args: unknown[]) => Promise<unknown> };
}

/** Sandbox config injected by the panel (keeps agentic-chat runtime-agnostic) */
export interface SandboxConfig {
  rpc: { call: (target: string, method: string, args: unknown[]) => Promise<unknown> };
  loadImport: (specifier: string, ref: string | undefined, externals: string[]) => Promise<string>;
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
