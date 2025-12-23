import type { ToolHistoryEntry } from "./components/ToolHistoryItem";

/** Metadata for participants in this channel */
export interface ChatParticipantMetadata {
  name: string;
  type: "panel" | "ai-responder" | "claude-code" | "codex";
}

/** A chat message in the conversation */
export interface ChatMessage {
  id: string;
  senderId: string;
  content: string;
  kind?: "message" | "tool";
  complete?: boolean;
  replyTo?: string;
  error?: string;
  pending?: boolean;
  tool?: ToolHistoryEntry;
}
