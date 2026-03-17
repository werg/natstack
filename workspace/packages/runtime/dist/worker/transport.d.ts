/**
 * WebSocket transport for workerd workers.
 *
 * Uses the WebSocket client API (natively supported in workerd) to connect
 * to the NatStack RPC server. Provides a full RpcTransport implementation.
 */
import type { RpcTransport } from "@natstack/rpc";
interface WsTransportConfig {
    wsUrl: string;
    authToken: string;
    workerId: string;
}
/**
 * Create an RpcTransport backed by a WebSocket connection to the NatStack RPC server.
 *
 * The transport handles:
 * - Authentication handshake (ws:auth)
 * - RPC request/response routing (ws:rpc)
 * - Streaming (ws:stream-chunk, ws:stream-end)
 * - Tool execution (ws:tool-exec / ws:tool-result)
 * - Events (ws:event)
 * - Message buffering during connection/auth
 */
export declare function createWorkerWsTransport(config: WsTransportConfig): RpcTransport;
export {};
//# sourceMappingURL=transport.d.ts.map