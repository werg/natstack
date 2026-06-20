/**
 * `@natstack/rpc` — stateless point-to-point RPC with fetch-shaped
 * streaming. Stateful userland services can layer their own protocols
 * on top of the same runtime service-resolution path.
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
  RpcCallOptions,
  AuthenticatedCaller,
  ExposedMethods,
  RpcEventListener,
  RpcCaller,
  CallerKind,
  RpcEnvelope,
  EnvelopeRpcTransport,
  RpcClient,
  RpcClientConfig,
  RpcRequestContext,
  RpcEventContext,
  RpcContextHandler,
  RpcContextMethods,
  RpcContextStreamingHandler,
  RpcPeer,
  RpcContract,
  MethodMap,
  EventMap,
  TypedCallProxy,
  RpcConnectionStatus,
  DeferredCallAck,
  DeferrableRpcClient,
  StreamingMethodHandler,
  StreamingMethodFrame,
  ParentPortEnvelope,
  ElectronLocalServiceName,
} from "./types.js";

export { isParentPortEnvelope, ELECTRON_LOCAL_SERVICE_NAMES } from "./types.js";
export { createRpcClient, defineContract } from "./client.js";
export {
  createConnectionlessRpcClient,
  collectExposableMethods,
  rpc,
  rpcExposedMethodNames,
  rpcMethodPolicy,
  type RpcCallerPolicy,
  type ConnectionlessRpcClient,
  type ConnectionlessRpcConfig,
} from "./connectionless.js";
export { httpClientTransport, type HttpClientTransportConfig } from "./transports/httpClient.js";
export {
  authenticatedCaller,
  envelopeFromMessage,
  originOfEnvelope,
  responseEnvelopeFor,
  retargetEnvelope,
} from "./envelope.js";
export { createHandlerRegistry } from "./transport-helpers.js";
