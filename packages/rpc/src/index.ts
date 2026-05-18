/**
 * `@natstack/rpc` — stateless point-to-point RPC with fetch-shaped
 * streaming. For stateful pub/sub channels with chat-shaped methods
 * and structured attachments, use `@natstack/pubsub` instead. See
 * `docs/architecture/rpc-vs-pubsub.md` for the boundary.
 */

export type {
  RpcRequest,
  RpcResponse,
  RpcEvent,
  RpcStreamRequest,
  RpcStreamFrameMessage,
  RpcStreamCancel,
  RpcMessage,
  RpcTransport,
  RpcBridge,
  RpcBridgeConfig,
  RpcBridgeInternal,
  RpcCallOptions,
  ExposedMethods,
  RpcEventListener,
  RpcCaller,
  CallerKind,
  StreamingMethodHandler,
  StreamingMethodFrame,
  ParentPortEnvelope,
  ElectronLocalServiceName,
} from "./types.js";

export { isParentPortEnvelope, ELECTRON_LOCAL_SERVICE_NAMES } from "./types.js";
export { createRpcBridge } from "./bridge.js";
export { createHandlerRegistry } from "./transport-helpers.js";
