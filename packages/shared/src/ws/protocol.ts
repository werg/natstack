/**
 * WebSocket RPC wire protocol types.
 *
 * Defines the message envelopes exchanged between WS clients (panels, workers,
 * shell, admin) and the RPC server. All types are pure data — no server state.
 *
 * Reuses RpcMessage from @workspace/rpc for the inner request/response payloads.
 */

import type { RpcMessage } from "@natstack/rpc";
import type { ToolExecutionResult } from "../types.js";

// =============================================================================
// Client → Server messages
// =============================================================================

export interface WsRpcMessage {
  type: "ws:rpc";
  message: RpcMessage;
}

export interface WsToolResultMessage {
  type: "ws:tool-result";
  callId: string;
  result: ToolExecutionResult;
}

/** Caller-to-caller routed message (panel→panel, worker→panel, etc.) */
export interface WsRouteMessage {
  type: "ws:route";
  targetId: string;
  message: RpcMessage;
  targetConnectionId?: string;
}

export type WsClientMessage =
  | WsRpcMessage
  | WsToolResultMessage
  | WsRouteMessage;

// =============================================================================
// Server → Client messages
// =============================================================================

export interface WsReadyMessage {
  type: "ws:ready";
  callerId?: string;
  callerKind?: string;
  connectionId?: string;
  serverBootId?: string;
}

export interface WsRpcResponseMessage {
  type: "ws:rpc";
  message: RpcMessage;
}

export interface WsEventMessage {
  type: "ws:event";
  event: string;
  payload: unknown;
}

/** Delivery of a routed caller-to-caller message */
export interface WsRoutedMessage {
  type: "ws:routed";
  sourceId: string;
  message: RpcMessage;
}

export interface WsRoutedEventErrorMessage {
  type: "ws:routed-event-error";
  targetId: string;
  event: string;
  error: string;
  errorCode?: string;
}

export interface WsRoutedResponseErrorMessage {
  type: "ws:routed-response-error";
  targetId: string;
  requestId: string;
  error: string;
  errorCode?: string;
}

export type WsServerMessage =
  | WsReadyMessage
  | WsRpcResponseMessage
  | WsEventMessage
  | WsRoutedMessage
  | WsRoutedEventErrorMessage
  | WsRoutedResponseErrorMessage;
