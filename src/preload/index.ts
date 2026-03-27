/**
 * Shell preload script.
 * Creates an IPC transport for the shell renderer to communicate with main process.
 * The shell client (src/renderer/shell/client.ts) reads __natstackTransport directly.
 */

import { createIpcTransport } from "./ipcTransport.js";
import type { TransportBridge } from "./wsTransport.js";

// =============================================================================
// Shell IPC Transport
// =============================================================================

const shellTransport: TransportBridge = createIpcTransport();

// Expose the transport global for the shell client's direct @workspace/rpc bridge
declare global {
  var __natstackTransport: TransportBridge | undefined;
}

// Set global directly (shell uses contextIsolation: false)
globalThis.__natstackTransport = shellTransport;
