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

import type { Attachment } from "@workspace/pubsub";
import type { InvocationCardPayload } from "./invocation-card-payload.js";

export type SandboxSource =
  | { type: "code"; code: string }
  | { type: "file"; path: string };

export interface InlineUiCardPayload {
  id: string;
  source: SandboxSource;
  imports?: Record<string, string>;
  props?: Record<string, unknown>;
}

export interface ActionBarPayload {
  id?: string;
  source?: SandboxSource;
  imports?: Record<string, string>;
  props?: Record<string, unknown>;
  maxHeight?: number;
  cleared?: boolean;
  result?: { ok: boolean; error?: string };
}

export type CustomMessageDisplayMode = "inline" | "row";

interface BaseMessageTypeDefinition {
  typeId: string;
  imports?: Record<string, string>;
  schemaSourceOrPath?: unknown;
  registeredBy?: { kind: string; id: string; displayName?: string; metadata?: Record<string, unknown> };
  updatedAtSeq: number;
}

export interface ActiveMessageTypeDefinition extends BaseMessageTypeDefinition {
  displayMode: CustomMessageDisplayMode;
  source: SandboxSource;
  clearedAtSeq?: number;
  cleared?: false;
}

export interface ClearedMessageTypeDefinition extends BaseMessageTypeDefinition {
  displayMode?: CustomMessageDisplayMode;
  source?: SandboxSource;
  clearedAtSeq: number;
  cleared: true;
}

export type MessageTypeDefinition = ActiveMessageTypeDefinition | ClearedMessageTypeDefinition;
export type ProjectedMessageTypeDefinition = MessageTypeDefinition;

export interface CustomMessageUpdatePayload {
  update: unknown;
  seq: number;
}

export interface CustomMessageCardPayload {
  messageId: string;
  typeId: string;
  displayMode: CustomMessageDisplayMode;
  initialState?: unknown;
  updates: CustomMessageUpdatePayload[];
  lastSeq: number;
}

export interface ApprovalCardPayload {
  id: string;
  invocationId?: string;
  question?: string;
  status: "requested" | "granted" | "denied";
  granted?: boolean;
  reason?: string;
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
// Lifecycle / recovery notices
// ===========================================================================

export type LifecycleNoticeStatus = "recovered" | "interrupted" | "failed";

export interface LifecycleNotice {
  status: LifecycleNoticeStatus;
  title: string;
  detail?: string;
  reason?: string;
}

// ===========================================================================
// ChatMessage (derived from Pi AgentMessage for component rendering)
// ===========================================================================

/**
 * Derived shape consumed by chat UI components. Computed by `useChatCore`
 * from channel envelopes and local UI events.
 */
export interface ChatMessage {
  id: string;
  pubsubId?: number;
  senderId: string;
  content: string;
  contentType?: string;
  kind?: "message" | "method" | "system";
  complete?: boolean;
  replyTo?: string;
  mentions?: string[];
  error?: string;
  pending?: boolean;
  attachments?: Attachment[];
  senderMetadata?: { name?: string; type?: string; handle?: string };
  disconnectedAgent?: DisconnectedAgentInfo;
  /**
   * Parsed structured payload for derived invocation-card messages.
   * Populated by the shared channel-chat-merge helper; UI components read it
   * directly instead of re-parsing `content`.
   */
  invocation?: InvocationCardPayload;
  inlineUi?: InlineUiCardPayload;
  approval?: ApprovalCardPayload;
  custom?: CustomMessageCardPayload;
  lifecycle?: LifecycleNotice;
}
