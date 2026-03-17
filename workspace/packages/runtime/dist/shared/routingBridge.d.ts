import { type RpcBridge } from "@natstack/rpc";
/**
 * Create a routing bridge that dispatches calls by service name:
 * - Server services (SERVER_SERVICE_NAMES from @natstack/rpc) → serverBridge
 * - Everything else (bridge, browser, events, panel-to-panel) → electronBridge
 */
export declare function createRoutingBridge(electronBridge: RpcBridge, serverBridge: RpcBridge): RpcBridge;
//# sourceMappingURL=routingBridge.d.ts.map