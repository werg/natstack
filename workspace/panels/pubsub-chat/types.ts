import type { MethodHistoryEntry } from "./components/MethodHistoryItem";

/** Metadata for participants in this channel */
export interface ChatParticipantMetadata {
  name: string;
  type: "panel" | "ai-responder" | "claude-code" | "codex";
  handle: string;
}

/** A chat message in the conversation */
export interface ChatMessage {
  id: string;
  senderId: string;
  content: string;
  kind?: "message" | "method";
  complete?: boolean;
  replyTo?: string;
  error?: string;
  pending?: boolean;
  method?: MethodHistoryEntry;
}
