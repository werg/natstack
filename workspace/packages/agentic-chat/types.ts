// ===========================================================================
// Re-export headless types from agentic-core
// ===========================================================================
export type {
  ChatParticipantMetadata,
  ConnectionConfig,
  AgenticChatActions,
  ChatSandboxValue,
  ChatMethodResult,
  SandboxConfig,
  ToolProviderDeps,
  ToolProvider,
} from "@workspace/agentic-core";

// Pi message/event types — re-exported via agentic-core
export type { AgentMessage, AgentEvent } from "@workspace/agentic-core";

// ===========================================================================
// Re-export derived UI types from agentic-core (ChatMessage, pending agent state, …)
// ===========================================================================
export type {
  ChatMessage,
  MessageTypeDefinition,
  PendingAgent,
  PendingAgentStatus,
  DisconnectedAgentInfo,
  DirtyRepoDetails,
} from "@workspace/agentic-core";

// ===========================================================================
// UI-only types
// ===========================================================================
import type { AgentDebugPayload, Participant, AttachmentInput, SandboxSource, PubSubClient } from "@workspace/pubsub";
import type { ActiveFeedback, ToolApprovalProps } from "@workspace/tool-ui";
import type { PendingImage } from "./utils/imageUtils";
import type { ComponentType, RefObject } from "react";
import type { ScopeManager, ScopesApi } from "@workspace/eval";
import type {
  ChatParticipantMetadata,
  ChatSandboxValue,
  InvocationCardPayload,
} from "@workspace/agentic-core";
import type {
  ChatMessage,
  MessageTypeDefinition,
  PendingAgent,
  DirtyRepoDetails,
  AvailableAgent,
  ConnectProviderResult,
  ModelCatalog,
  AgentSubscriptionConfig,
} from "@workspace/agentic-core";

// ===========================================================================
// Inline UI Component Entry
// ===========================================================================

export interface InlineUiComponentEntry {
  Component?: ComponentType<{
    props: Record<string, unknown>;
    chat: Record<string, unknown>;
    scope: Record<string, unknown>;
    scopes: Record<string, unknown>;
  }>;
  cacheKey: string;
  error?: string;
}

// ===========================================================================
// Action Bar
// ===========================================================================

export interface ActionBarData {
  /** Unique ID for this action bar revision. New revisions replace old ones. */
  id: string;
  /** Component source to compile and render. */
  source: SandboxSource;
  /** Optional explicit imports for the current compiled revision. */
  imports?: Record<string, string>;
  /** Optional props to pass to the component */
  props?: Record<string, unknown>;
  /** Optional preferred maximum height in pixels. Clamped by the renderer. */
  maxHeight?: number;
}

export interface ActionBarState {
  data: ActionBarData;
  component?: InlineUiComponentEntry;
}

// ===========================================================================
// Typing Indicators
// ===========================================================================

/** Typing indicator data derived from roster participant metadata. */
export interface TypingIndicatorData {
  senderId: string;
  senderName?: string;
  senderType?: string;
}

declare const runtimeCallerIdBrand: unique symbol;
declare const channelParticipantIdBrand: unique symbol;

export type RuntimeCallerId = string & { readonly [runtimeCallerIdBrand]: true };
export type ChannelParticipantId = string & { readonly [channelParticipantIdBrand]: true };
export type BrowserHandoffCallerKind = "app" | "panel" | "shell";

export interface BrowserHandoffCaller {
  id: RuntimeCallerId;
  kind: BrowserHandoffCallerKind;
}

export function runtimeCallerId(value: string): RuntimeCallerId {
  return value as RuntimeCallerId;
}

export function channelParticipantId(value: string): ChannelParticipantId {
  return value as ChannelParticipantId;
}

// ===========================================================================
// ChatInputContext Value
// ===========================================================================

export interface ChatInputContextValue {
  input: string;
  pendingImages: PendingImage[];
  onInputChange: (value: string) => void;
  onSendMessage: (
    attachments?: AttachmentInput[],
    options?: {
      mentions?: string[];
      replyTo?: string;
      /** Written into the published message payload (e.g. deliverAfterTurn). */
      metadata?: Record<string, unknown>;
    }
  ) => Promise<void>;
  onImagesChange: (images: PendingImage[]) => void;
  replyTo: string | null;
  replyToMessage: ChatMessage | null;
  setReplyTo: (messageId: string | null) => void;
}

/**
 * What pressing Enter will do right now, given agent-busy + send-mode state.
 * - `send`  — no agent busy: a normal send.
 * - `steer` — an agent is mid-turn: the default send steers it.
 * - `queue` — after-turn mode armed: the message waits until the turn closes.
 */
export type PrimaryActionIntent = "send" | "steer" | "queue";

/** Transient outcome of the last incremental flush, for the pill + aria-live. */
export interface FlushNarration {
  text: string;
  /** Remaining queued items after this flush step (drives "· N waiting"). */
  remaining: number;
}

/** A short, reversible client-side undo window after retract/cancel. */
export interface UndoableAction {
  kind: "retract" | "cancel";
  /** Messages covered by this undo. Consecutive cancels within the window
   *  accumulate here so a single Undo restores them all (e.g. "cancel queued"). */
  messageIds: string[];
  /** Epoch ms when the undo window closes. */
  expiresAt: number;
}

// ===========================================================================
// ChatContext Value
// ===========================================================================

export interface ChatContextValue {
  // Connection
  connected: boolean;
  status: string;
  channelId: string | null;
  /** Connected runtime caller that can receive OAuth browser handoff events. */
  browserHandoffCaller: BrowserHandoffCaller;
  sessionEnabled?: boolean;
  /**
   * Last connection-layer error surfaced by `ConnectionManager.onError`
   * (subscribe failure, event-stream rejection). Cleared on successful
   * reconnect. Rendered inline at the top of the chat by `ChatLayout`
   * so silent stalls become visibly broken.
   */
  connectionError: { message: string; at: number } | null;
  /** Clear the current connectionError (e.g., after a retry). */
  dismissConnectionError?: () => void;

  /** Chat API for sandboxed code */
  chat: ChatSandboxValue;
  clientRef: RefObject<PubSubClient<ChatParticipantMetadata> | null>;
  /** Stable panel identity used to isolate panel-local UI scopes. */
  panelScopeId: string;
  /** Panel-local UI scope shared by inline UI, feedback_custom, and action bar. */
  scope: Record<string, unknown>;
  /** Scope API for the panel-local UI scope. */
  scopes: ScopesApi;
  /** Scope manager for panel-local UI scope reactivity and persistence. */
  scopeManager: ScopeManager;

  // Messages
  messages: ChatMessage[];
  inlineUiComponents: Map<string, InlineUiComponentEntry>;
  messageTypeComponents: Map<string, MessageTypeComponentEntry>;
  actionBar: ActionBarState | null;
  onActionBarMaxHeightChange?: (maxHeight: number, options?: { saveState?: boolean }) => void;
  hasMoreHistory: boolean;
  loadingMore: boolean;

  // Participants
  /** This client's participant ID */
  selfId: ChannelParticipantId | null;
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  allParticipants: Record<string, Participant<ChatParticipantMetadata>>;

  // Agent state
  debugEvents: Array<AgentDebugPayload & { ts: number }>;
  debugConsoleAgent: string | null;
  dirtyRepoWarnings: Map<string, DirtyRepoDetails>;
  pendingAgents: Map<string, PendingAgent>;

  // Feedback
  activeFeedbacks: Map<string, ActiveFeedback>;

  // Theme
  theme: "light" | "dark";

  // --- Delivery model: outbox, send intent, flush, undo ---------------------
  /**
   * Whether any agent is currently mid-turn. Derived robustly by OR-ing every
   * busy signal (durable typing message, ephemeral roster typing, open turn) so
   * interrupt/steer affordances stay enabled across the whole turn.
   */
  agentBusy: boolean;
  /** Whether the channel has an open/waiting turn that can receive after-turn messages. */
  hasOpenTurn: boolean;
  /** Edit a still-unread outbox message (rebuilds text + attachment blocks). */
  editPendingMessage: (messageId: string, newText: string) => Promise<void>;
  /** Retract a still-unread outbox message; raises an Undo snackbar. */
  cancelPendingMessage: (messageId: string) => Promise<void>;
  /** Esc / "Send now": pause busy agents with flushDeferred and narrate it. */
  flushOutboxAndInterrupt: () => Promise<void>;
  /** What pressing Enter will do right now (drives the send-button label/hint). */
  primaryActionIntent: PrimaryActionIntent;
  /** Transient outcome of the last flush, for the inline pill + aria-live. */
  flushNarration?: FlushNarration;
  /** The short client-side undo window after retract/cancel. */
  undoableAction?: UndoableAction;
  /** Undo the pending undoable action (re-send the retracted message text). */
  undoLastAction?: () => void;
  /**
   * Transient count of locally-in-flight sends ("Sending…" ghost). Local UI
   * state only; never protocol state.
   */
  pendingSendCount: number;
  /** Message ids sent with after-turn intent — drives the outbox lane cue. */
  afterTurnMessageIds: Set<string>;
  /** Message ids whose send failed — shown as "Failed — tap to retry". */
  failedSendMessageIds: Set<string>;
  /** Re-attempt a failed send by message id. */
  retrySend: (messageId: string) => void;

  // Handlers
  onLoadEarlierMessages: () => void;
  onInterrupt: (agentId: string, messageId?: string, agentHandle?: string) => void;
  onCancelInvocation: (invocation: InvocationCardPayload, senderId: string) => void;
  onCallMethod: (providerId: string, methodName: string, args: unknown) => void;
  /** Awaits and returns the provider's result payload (for settings UIs). */
  onCallMethodResult: (providerId: string, methodName: string, args: unknown) => Promise<unknown>;
  onFeedbackDismiss: (callId: string) => void;
  onFeedbackError: (callId: string, error: Error) => void;
  onDebugConsoleChange: (agentHandle: string | null) => void;
  onDismissDirtyWarning: (agentName: string) => void;

  // Optional actions (platform-specific)
  onAddAgent?: (agentId?: string, config?: AgentSubscriptionConfig) => void;
  /** Replace an existing agent (by participant id), reusing its handle. */
  onReplaceAgent?: (
    participantId: string,
    agentId?: string,
    config?: AgentSubscriptionConfig
  ) => Promise<void> | void;
  /** Connect a model provider credential; resolves to success/failure. */
  onConnectProvider?: (
    providerId: string,
    modelBaseUrl: string,
    opts?: { browser?: "internal" | "external" }
  ) => Promise<ConnectProviderResult>;
  availableAgents?: AvailableAgent[];
  /** Static pi model catalog; connection status merged in the UI. */
  modelCatalog?: ModelCatalog | null;
  /** Workspace default model ref ("provider:modelId") for new agents. */
  defaultModelRef?: string | null;
  /** Model refs ("provider:modelId") with a usable credential (panel-scoped). */
  connectedModelRefs?: string[];
  onRemoveAgent?: (handle: string) => void;
  onFocusPanel?: (panelId: string) => void;
  onReloadPanel?: (panelId: string) => void;
  /** Start a fresh conversation (surfaced for the command palette). */
  onNewConversation?: () => void;

  // Tool approval (optional)
  toolApproval?: ToolApprovalProps;
}

/** Which await a loading message type is currently parked on. */
export type MessageTypeLoadingStage =
  | "fetching-definition"
  | "loading-source"
  | "compiling";

export type MessageTypeRegistryEntry =
  | {
      status: "ready";
      definition: MessageTypeDefinition;
      module: import("@workspace/agentic-core").MessageTypeModule;
      cacheKey: string;
    }
  | {
      status: "loading";
      /** Stage the load is parked on — makes an endless spinner self-describing. */
      stage?: MessageTypeLoadingStage;
      /** Epoch ms when this stage started. */
      startedAt?: number;
      /** Definition being compiled, when known (absent while fetching it). */
      definition?: MessageTypeDefinition;
    }
  | {
      status: "error";
      message: string;
      /** Registration seq the failure corresponds to (newer seqs recompile). */
      updatedAtSeq?: number;
      /** Definition that failed, when known. */
      definition?: MessageTypeDefinition;
      /** Re-attempt the fetch/compile that produced this error. */
      retry?: () => void;
    };

export type MessageTypeComponentEntry = MessageTypeRegistryEntry;
