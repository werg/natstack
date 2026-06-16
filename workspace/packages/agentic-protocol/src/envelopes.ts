import type { ChannelId, EnvelopeId } from "./ids.js";
import type { ParticipantRef, ParticipantSelector, StoredAgenticEvent } from "./events.js";

export interface ChannelEnvelope<Payload = unknown> {
  envelopeId: EnvelopeId;
  channelId: ChannelId;
  seq: number;
  from: ParticipantRef;
  to?: ParticipantRef[] | ParticipantSelector;
  payload: Payload;
  payloadKind?: string;
  metadata?: Record<string, unknown>;
  attachments?: unknown[];
  /** Durable envelope annotations (policy folds — e.g. agentHops). */
  annotations?: Record<string, unknown>;
  publishedAt: string;
}

export type StoredChannelEnvelope = ChannelEnvelope<StoredAgenticEvent>;

export type EphemeralSignalKind = "typing" | "presence" | "cursor" | "custom";

export interface EphemeralSignal {
  channelId: ChannelId;
  from: ParticipantRef;
  kind: EphemeralSignalKind;
  payload?: unknown;
  emittedAt: string;
}

export interface ChannelRosterEntry {
  participant: ParticipantRef;
  joinedAt: string;
  leftAt?: string;
  roles: string[];
}
