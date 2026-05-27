/**
 * Types for the PubSub Channel DO.
 */

import type { ChannelEvent, SendMessageOptions } from "@natstack/harness/types";
import type { ChannelReplayEnvelope } from "@workspace/pubsub";

/** Result from subscribing a DO participant. */
export interface SubscribeResult {
  ok: boolean;
  channelConfig?: Record<string, unknown>;
  envelope: ChannelReplayEnvelope;
}

/** Participant info stored in the participants table. */
export interface ParticipantInfo {
  id: string;
  metadata: Record<string, unknown>;
  transport: "rpc" | "do";
  connectedAt: number;
}

/** Channel config (mirrors PubSub client ChannelConfig). */
export interface ChannelConfig {
  title?: string;
  /** True when the title came from an explicit title command. */
  titleExplicit?: boolean;
  approvalLevel?: number;
  [key: string]: unknown;
}

/** Presence event payload stored in messages table. */
export interface PresencePayload {
  action: "join" | "leave" | "update";
  metadata: Record<string, unknown>;
  leaveReason?: "graceful" | "disconnect" | "replaced";
}

/** Metadata passed alongside a ChannelEvent to broadcast(). */
export interface BroadcastEnvelope {
  kind: "log" | "signal";
  phase?: "replay" | "live";
  ref?: number;
}

/** Attachment stored in messages table (JSON). */
export interface StoredAttachment {
  id: string;
  data: string;  // base64
  mimeType: string;
  name?: string;
  size: number;
}

/** Event delivered to agent DOs via callDoTarget. Same as ChannelEvent from harness/types. */
export type { ChannelEvent, SendMessageOptions };
