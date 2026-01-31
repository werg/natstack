import type { MethodAdvertisement, ContextWindowUsage } from "@natstack/agentic-messaging";
import type { Attachment } from "@natstack/pubsub";
import type { MethodHistoryEntry } from "./components/MethodHistoryItem";

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
