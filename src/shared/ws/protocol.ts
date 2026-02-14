/**
 * WebSocket RPC wire protocol types.
 *
 * Defines the message envelopes exchanged between WS clients (panels, workers,
 * shell, admin) and the RPC server. All types are pure data — no server state.
 *
 * Reuses RpcMessage from @natstack/rpc for the inner request/response payloads.
 */

import type { RpcMessage } from "@natstack/rpc";
import type { StreamTextEvent, ToolExecutionResult } from "../types.js";

// =============================================================================
// Client → Server messages
// =============================================================================

export interface WsAuthMessage {
  type: "ws:auth";
  token: string;
}

export interface WsRpcMessage {
  type: "ws:rpc";
  message: RpcMessage;
}

export interface WsToolResultMessage {
  type: "ws:tool-result";
  callId: string;
  result: ToolExecutionResult;
}

export interface WsPanelRpcMessage {
  type: "ws:panel-rpc";
  targetId: string;
  message: RpcMessage;
}

export type WsClientMessage =
  | WsAuthMessage
  | WsRpcMessage
  | WsToolResultMessage
  | WsPanelRpcMessage;

// =============================================================================
// Server → Client messages
// =============================================================================

export interface WsAuthResultMessage {
  type: "ws:auth-result";
  success: boolean;
  callerId?: string;
  callerKind?: string;
  error?: string;
}

export interface WsRpcResponseMessage {
  type: "ws:rpc";
  message: RpcMessage;
}

export interface WsStreamChunkMessage {
  type: "ws:stream-chunk";
  streamId: string;
  chunk: StreamTextEvent;
}

export interface WsStreamEndMessage {
  type: "ws:stream-end";
  streamId: string;
}

export interface WsToolExecMessage {
  type: "ws:tool-exec";
  callId: string;
  streamId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface WsEventMessage {
  type: "ws:event";
  event: string;
  payload: unknown;
}

export interface WsPanelRpcDeliveryMessage {
  type: "ws:panel-rpc-delivery";
  fromId: string;
  message: RpcMessage;
}

export type WsServerMessage =
  | WsAuthResultMessage
  | WsRpcResponseMessage
  | WsStreamChunkMessage
  | WsStreamEndMessage
  | WsToolExecMessage
  | WsEventMessage
  | WsPanelRpcDeliveryMessage;
