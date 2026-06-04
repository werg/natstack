/**
 * Shared WS wire protocol types — used by both the PubSub channel DO
 * (server) and the PubSub client. Single source of truth to prevent drift.
 */

import type {
  BootstrapSnapshot,
  ParticipantSnapshot,
  ReplayReady,
  ServerLogEvent,
} from "./types.js";

// ── Event messages (channel events with transport metadata) ──────────────

export interface RpcLogMessage {
  kind: "log";
  phase: "replay" | "live";
  event: ServerLogEvent;
  ref?: number;
}

export interface RpcRosterSnapshotMessage {
  kind: "control";
  type: "roster-snapshot";
  participants: ParticipantSnapshot[];
  ts: number;
}

export interface RpcReadyMessage {
  kind: "control";
  type: "ready";
  ready: ReplayReady;
}

export interface RpcErrorMessage {
  kind: "control";
  type: "error";
  error: string;
  ref?: number;
}

export interface RpcSignalMessage {
  kind: "signal";
  type: string;
  payload: unknown;
  senderId?: string;
  ts: number;
  ref?: number;
}

export interface RpcWireAttachment {
  id: string;
  data: string;
  mimeType: string;
  filename?: string;
  name?: string;
  size: number;
  type?: string;
}

export interface RpcMethodResultMessage {
  kind: "method-result";
  callId: string;
  invocationId?: string;
  turnId?: string;
  content: unknown;
  isError: boolean;
  terminalOutcome?: string | null;
  terminalReasonCode?: string | null;
  contentType?: string;
  attachments?: RpcWireAttachment[];
  senderId?: string;
  ts: number;
  ref?: number;
}

export interface RpcMethodProgressMessage {
  kind: "method-progress";
  callId: string;
  invocationId?: string;
  turnId?: string;
  content: unknown;
  progress?: number;
  contentType?: string;
  attachments?: RpcWireAttachment[];
  senderId?: string;
  ts: number;
  ref?: number;
}

export interface RpcMethodCancelMessage {
  kind: "method-cancel";
  callId: string;
  invocationId?: string;
  turnId?: string;
  targetId?: string;
  reason?: string;
  senderId?: string;
  ts: number;
  ref?: number;
}

export type RpcChannelMessage =
  | RpcLogMessage
  | RpcRosterSnapshotMessage
  | RpcReadyMessage
  | RpcErrorMessage
  | RpcSignalMessage
  | RpcMethodResultMessage
  | RpcMethodProgressMessage
  | RpcMethodCancelMessage;

export function snapshotToRpcControl(snapshot: BootstrapSnapshot): RpcRosterSnapshotMessage {
  return {
    kind: "control",
    type: "roster-snapshot",
    participants: snapshot.participants,
    ts: snapshot.ts,
  };
}
