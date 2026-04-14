/**
 * Shared wire-event → ChatMessage merge logic.
 *
 * Consumed by both `useChannelMessages` (React) and `HeadlessSession`. Before
 * this module, each consumer re-implemented the same merge with the same
 * latent bugs (append-vs-replace, toolCall payload parsing, etc). Centralizing
 * here keeps the two paths in lockstep.
 *
 * Wire-level shapes are minimally typed — consumers may pass their richer raw
 * event objects; extra fields are ignored.
 */

import type { Attachment } from "@natstack/pubsub";
import type { ChatMessage } from "./derived-types.js";
import { parseToolCallPayload } from "./tool-call-payload.js";

export interface WireNewMessage {
  type: "message";
  kind?: string;
  id: string;
  senderId?: string;
  content?: string;
  contentType?: string;
  replyTo?: string;
  pubsubId?: number;
  attachments?: Attachment[];
  senderMetadata?: { name?: string; type?: string; handle?: string };
}

export interface WireUpdateMessage {
  type: "update-message";
  id: string;
  content?: string;
  /** When true, concatenate onto existing content regardless of contentType.
   *  When absent/false, replace for typed messages, append for untyped. */
  append?: boolean;
  complete?: boolean;
  attachments?: Attachment[];
}

export interface WireErrorMessage {
  type: "error";
  id: string;
  error?: string;
}

export interface CreateChatMessageOptions {
  /** Whether this message arrived as part of a replay batch (implies complete). */
  isReplay?: boolean;
  /** Whether this message originated from a client-type participant (implies complete). */
  isFromClient?: boolean;
}

export function createChatMessageFromWire(
  wire: WireNewMessage,
  opts?: CreateChatMessageOptions,
): ChatMessage {
  const content = wire.content ?? "";
  const msg: ChatMessage = {
    id: wire.id,
    pubsubId: wire.pubsubId,
    senderId: wire.senderId ?? "unknown",
    content,
    contentType: wire.contentType,
    replyTo: wire.replyTo,
    kind: "message",
    complete: !!(opts?.isReplay || opts?.isFromClient),
    attachments: wire.attachments,
    senderMetadata: wire.senderMetadata,
  };
  if (wire.contentType === "toolCall") {
    const parsed = parseToolCallPayload(content);
    if (parsed) msg.toolCall = parsed;
  }
  return msg;
}

export function applyChatMessageUpdate(
  existing: ChatMessage,
  wire: WireUpdateMessage,
): ChatMessage {
  const updated: ChatMessage = { ...existing };
  if (wire.content !== undefined) {
    const append = wire.append || !existing.contentType;
    updated.content = append
      ? (existing.content ?? "") + wire.content
      : wire.content;
  }
  if (wire.complete !== undefined) updated.complete = wire.complete;
  if (wire.attachments) updated.attachments = wire.attachments;
  if (updated.contentType === "toolCall") {
    const parsed = parseToolCallPayload(updated.content);
    if (parsed) updated.toolCall = parsed;
  }
  return updated;
}

export function applyChatMessageError(
  existing: ChatMessage,
  wire: WireErrorMessage,
): ChatMessage {
  return { ...existing, complete: true, error: wire.error ?? "Unknown error" };
}
