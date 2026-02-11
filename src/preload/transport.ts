/**
 * Transport bridge for panel/worker preloads.
 * Re-exports from WS transport (IPC transport removed).
 */
export { createWsTransport as createTransportBridge, type TransportBridge } from "./wsTransport.js";
