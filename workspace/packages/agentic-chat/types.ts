// ===========================================================================
// Re-export headless types from agentic-core
// ===========================================================================
export type {
  ChatParticipantMetadata,
  ConnectionConfig,
  AgenticChatActions,
  ChatSandboxValue,
  SandboxConfig,
  ToolProviderDeps,
  ToolProvider,
} from "@workspace/agentic-core";

// Pi message/event types — re-exported via agentic-core
export type { AgentMessage, AgentEvent } from "@workspace/agentic-core";

// ===========================================================================
// Re-export derived UI types from agentic-core (ChatMessage, MethodHistoryEntry, …)
// ===========================================================================
export type {
  ChatMessage,
  MethodHistoryEntry,
  MethodCallStatus,
  PendingAgent,
  PendingAgentStatus,
  DisconnectedAgentInfo,
  DirtyRepoDetails,
} from "@workspace/agentic-core";

// ===========================================================================
// UI-only types
// ===========================================================================
import type { AgentDebugPayload, Participant, AttachmentInput } from "@natstack/pubsub";
import type { ActiveFeedback, ToolApprovalProps } from "@workspace/tool-ui";
import type { PendingImage } from "./utils/imageUtils";
import type { ComponentType } from "react";
import type { ScopeManager, ScopesApi } from "@workspace/eval";
import type {
  ChatParticipantMetadata,
  ChatSandboxValue,
} from "@workspace/agentic-core";
import type {
  ChatMessage,
  PendingAgent,
  MethodHistoryEntry,
  DirtyRepoDetails,
} from "@workspace/agentic-core";

// ===========================================================================
// Inline UI Component Entry
// ===========================================================================

export interface InlineUiComponentEntry {
  Component?: ComponentType<{ props: Record<string, unknown>; chat: Record<string, unknown>; scope: Record<string, unknown>; scopes: Record<string, unknown> }>;
  cacheKey: string;
  error?: string;
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

// ===========================================================================
// ChatInputContext Value
// ===========================================================================

export interface ChatInputContextValue {
  input: string;
  pendingImages: PendingImage[];
  onInputChange: (value: string) => void;
  onSendMessage: (attachments?: AttachmentInput[]) => Promise<void>;
  onImagesChange: (images: PendingImage[]) => void;
}

// ===========================================================================
// ChatContext Value
// ===========================================================================

export interface ChatContextValue {
  // Connection
  connected: boolean;
  status: string;
  channelId: string | null;
  sessionEnabled?: boolean;

  /** Chat API for sandboxed code */
  chat: ChatSandboxValue;

  /** Current REPL scope (Proxy) */
  scope: Record<string, unknown>;

  /** Scopes API — history + persistence */
  scopes: ScopesApi;

  /** Scope manager for reactivity subscriptions */
  scopeManager: ScopeManager | null;

  // Messages
  messages: ChatMessage[];
  methodEntries: Map<string, MethodHistoryEntry>;
  inlineUiComponents: Map<string, InlineUiComponentEntry>;
  hasMoreHistory: boolean;
  loadingMore: boolean;

  // Participants
  /** This client's participant ID */
  selfId: string | null;
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

  // Handlers
  onLoadEarlierMessages: () => void;
  onInterrupt: (agentId: string, messageId?: string, agentHandle?: string) => void;
  onCallMethod: (providerId: string, methodName: string, args: unknown) => void;
  onFeedbackDismiss: (callId: string) => void;
  onFeedbackError: (callId: string, error: Error) => void;
  onDebugConsoleChange: (agentHandle: string | null) => void;
  onDismissDirtyWarning: (agentName: string) => void;

  // Optional actions (platform-specific)
  onAddAgent?: (agentId?: string) => void;
  availableAgents?: Array<{ id: string; name: string; proposedHandle: string }>;
  onRemoveAgent?: (handle: string) => void;
  onFocusPanel?: (panelId: string) => void;
  onReloadPanel?: (panelId: string) => void;

  // Tool approval (optional)
  toolApproval?: ToolApprovalProps;
}
