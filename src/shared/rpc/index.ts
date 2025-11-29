/**
 * Shared RPC module for panel-to-panel and panel-to-worker communication.
 */

export type {
  RpcRequest,
  RpcResponse,
  RpcResponseSuccess,
  RpcResponseError,
  RpcEvent,
  RpcMessage,
  RpcBridgeConfig,
} from "./types.js";
export { parseEndpointId, panelId, workerId } from "./types.js";
