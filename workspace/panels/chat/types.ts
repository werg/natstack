import type { MethodAdvertisement, Attachment } from "@natstack/agentic-messaging";
import type { MethodHistoryEntry } from "./components/MethodHistoryItem";

/** Metadata for participants in this channel */
export interface ChatParticipantMetadata {
  name: string;
  type: "panel" | "ai-responder" | "claude-code" | "codex" | "subagent";
  handle: string;
  /** Methods this participant provides (for menu display) */
  methods?: MethodAdvertisement[];
}

/** A chat message in the conversation */
export interface ChatMessage {
  id: string;
  /** PubSub message ID (numeric, for pagination) */
  pubsubId?: number;
  senderId: string;
  content: string;
  contentType?: string;  // e.g., "thinking", "text/plain", etc.
  kind?: "message" | "method";
  complete?: boolean;
  replyTo?: string;
  error?: string;
  pending?: boolean;
  method?: MethodHistoryEntry;
  /** Image attachments on this message */
  attachments?: Attachment[];
  /** Sender metadata snapshot for historical messages */
  senderMetadata?: { name?: string; type?: string; handle?: string };
}
