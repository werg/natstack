/**
 * Derived UI types for the chat panel.
 *
 * These shapes are computed from channel messages for component rendering.
 * They live in agentic-core rather than agentic-chat so both the React
 * layer and HeadlessSession can consume them.
 *
 * The agent worker publishes Pi events as persisted channel messages.
 * `useChatCore` builds `ChatMessage[]` from the channel message stream.
 */

import type { Attachment } from "@natstack/pubsub";

// ===========================================================================
// Method history (still tracked from channel method-call/result events)
// ===========================================================================

export type MethodCallStatus = "pending" | "success" | "error";

export interface MethodHistoryEntry {
  callId: string;
  methodName: string;
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
// Pending agents (UI state for spawn-in-progress)
// ===========================================================================

export type PendingAgentStatus = "starting" | "error";

export interface PendingAgent {
  agentId: string;
  status: PendingAgentStatus;
  error?: { message: string; details?: string };
}

// ===========================================================================
// Disconnected agent notification
// ===========================================================================

export interface DisconnectedAgentInfo {
  name: string;
  handle: string;
  panelId?: string;
  agentTypeId?: string;
  type: string;
}

// ===========================================================================
// Dirty repo warning (from agent debug events)
// ===========================================================================

export interface DirtyRepoDetails {
  modified: string[];
  untracked: string[];
  staged: string[];
}

// ===========================================================================
// ChatMessage (derived from Pi AgentMessage for component rendering)
// ===========================================================================

/**
 * Derived shape consumed by chat UI components. Computed by `useChatCore`
 * from a Pi `AgentMessage[]` snapshot. Each Pi message becomes one or more
 * ChatMessages depending on its content array (one for text, one for each
 * tool call/result, etc.).
 */
export interface ChatMessage {
  id: string;
  pubsubId?: number;
  senderId: string;
  content: string;
  /**
   * Optional structured content blocks from the underlying pi-agent-core
   * `AgentMessage.content` array, preserved when a message includes
   * content types the flat `content` string can't represent (e.g. image
   * blocks). When present, the chat UI's `MessageContent` component
   * renders these instead of the `content` fallback.
   */
  contentBlocks?: ReadonlyArray<unknown>;
  contentType?: string;
  kind?: "message" | "method" | "system";
  complete?: boolean;
  replyTo?: string;
  error?: string;
  pending?: boolean;
  method?: MethodHistoryEntry;
  attachments?: Attachment[];
  senderMetadata?: { name?: string; type?: string; handle?: string };
  disconnectedAgent?: DisconnectedAgentInfo;
}
