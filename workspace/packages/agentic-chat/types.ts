import type { MethodAdvertisement, ContextWindowUsage, AgentBuildError, AgentDebugPayload, MethodDefinition } from "@workspace/agentic-messaging";
import type { Attachment, Participant, AttachmentInput } from "@workspace/pubsub";
import type { ActiveFeedback, ToolApprovalProps } from "@workspace/tool-ui";
import type { MethodHistoryEntry } from "./components/MethodHistoryItem";
import type { PendingImage } from "./utils/imageUtils";
import type { DirtyRepoDetails } from "./hooks/useAgentEvents";
import type { UseToolRoleResult } from "./hooks/useToolRole";
import type { ComponentType } from "react";

// ===========================================================================
// Core Chat Types (moved from panels/chat/types.ts)
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
  type: "panel" | "ai-responder" | "claude-code" | "codex" | "subagent";
  handle: string;
  /** Methods this participant provides (for menu display) */
  methods?: MethodAdvertisement[];
  /** Runtime panel/worker ID - allows linking participant to child panel for focus/reload */
  panelId?: string;
  /** Agent type ID for identification (e.g., "claude-code-responder") */
  agentTypeId?: string;
  /** Context window usage tracking (updated by AI responders) */
  contextUsage?: ContextWindowUsage;
  /** Execution mode - "plan" for planning only, "edit" for full execution */
  executionMode?: "plan" | "edit";
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
// New Injection Interfaces
// ===========================================================================

/** Inject connection config instead of importing from runtime */
export interface ConnectionConfig {
  serverUrl: string;
  token: string;
  clientId: string;
}

/** Inject platform-specific navigation */
export interface AgenticChatActions {
  onNewConversation?: () => void;
  onAddAgent?: (channelName: string, contextId?: string) => Promise<void>;
  onFocusPanel?: (panelId: string) => void;
  onReloadPanel?: (panelId: string) => Promise<void>;
  onBecomeVisible?: () => void;
}

/** Dependencies provided to the tool provider factory */
export interface ToolProviderDeps {
  clientRef: { current: { publish: (eventType: string, payload: unknown) => void } | null };
  workspaceRoot?: string;
}

/** Inject tools at connect time */
export type ToolProvider = (deps: ToolProviderDeps) => Record<string, MethodDefinition>;

// ===========================================================================
// Inline UI Component Entry
// ===========================================================================

export interface InlineUiComponentEntry {
  Component?: ComponentType<{ props: Record<string, unknown> }>;
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
  onReset: () => void;

  // Optional actions (platform-specific)
  onAddAgent?: () => void;
  onFocusPanel?: (panelId: string) => void;
  onReloadPanel?: (panelId: string) => void;

  // Tool approval (optional)
  toolApproval?: ToolApprovalProps;

  // Tool role state (for components that need shouldProvideGroup or conflict info)
  toolRole?: UseToolRoleResult;
}
