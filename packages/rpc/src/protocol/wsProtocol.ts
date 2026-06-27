import type { CallerKind, RpcEnvelope } from "../types.js";

export type ClientPlatform = "desktop" | "headless" | "mobile";

export interface ToolExecutionResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  data?: unknown;
}

export interface WsAuthMessage {
  type: "ws:auth";
  token: string;
  connectionId?: string;
  clientSessionId?: string;
  clientLabel?: string;
  clientPlatform?: ClientPlatform;
}

export interface WsRpcMessage {
  type: "ws:rpc";
  envelope: RpcEnvelope;
}

export interface WsToolResultMessage {
  type: "ws:tool-result";
  callId: string;
  result: ToolExecutionResult;
}

export interface WsRouteMessage {
  type: "ws:route";
  envelope: RpcEnvelope;
  targetConnectionId?: string;
}

export type WsClientMessage = WsAuthMessage | WsRpcMessage | WsToolResultMessage | WsRouteMessage;

export interface WsAuthResultMessage {
  type: "ws:auth-result";
  success: boolean;
  callerId?: string;
  callerKind?: CallerKind | string;
  connectionId?: string;
  serverBootId?: string;
  sessionDirty?: boolean;
  error?: string;
}

export interface WsRpcResponseMessage {
  type: "ws:rpc";
  envelope: RpcEnvelope;
}

export interface WsEventMessage {
  type: "ws:event";
  event: string;
  payload: unknown;
}

export interface WsRoutedMessage {
  type: "ws:routed";
  envelope: RpcEnvelope;
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
  | WsAuthResultMessage
  | WsRpcResponseMessage
  | WsEventMessage
  | WsRoutedMessage
  | WsRoutedEventErrorMessage
  | WsRoutedResponseErrorMessage;
