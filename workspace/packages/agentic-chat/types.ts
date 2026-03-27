// ===========================================================================
// Re-export all core types for backward compatibility
// ===========================================================================
export type {
  MethodCallStatus,
  MethodHistoryEntry,
  PendingAgentStatus,
  PendingAgent,
  ChatParticipantMetadata,
  DisconnectedAgentInfo,
  ChatMessage,
  ConnectionConfig,
  AgenticChatActions,
  ChatSandboxValue,
  SandboxConfig,
  ToolProviderDeps,
  ToolProvider,
} from "@workspace/agentic-core";

// ===========================================================================
// UI-only types (depend on React, tool-ui, or browser APIs)
// ===========================================================================
import type { AgentDebugPayload, Participant, AttachmentInput } from "@natstack/pubsub";
import type { ActiveFeedback, ToolApprovalProps } from "@workspace/tool-ui";
import type { PendingImage } from "./utils/imageUtils";
import type { DirtyRepoDetails } from "@workspace/agentic-core";
import type { ComponentType } from "react";
import type { ScopeManager, ScopesApi } from "@workspace/eval";
import type {
  ChatMessage,
  ChatParticipantMetadata,
  ChatSandboxValue,
  PendingAgent,
  MethodHistoryEntry,
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
// ChatInputContext Value (keystroke-frequency updates, consumed only by ChatInput)
// ===========================================================================

/** Value provided by ChatInputContext — changes on every keystroke */
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

/** Full value provided by ChatContext — changes on messages, connection, etc. */
export interface ChatContextValue {
  // Connection
  connected: boolean;
  status: string;
  channelId: string | null;
  sessionEnabled?: boolean;

  /** Chat API for sandboxed code — publish messages, call methods, access runtime */
  chat: ChatSandboxValue;

  /** Current REPL scope (Proxy) */
  scope: Record<string, unknown>;

  /** Scopes API — history + persistence (pre-injected as `scopes` binding) */
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
