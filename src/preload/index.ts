/**
 * Shell preload script.
 * Creates a WS transport for the shell renderer to communicate with main process.
 * The shell client (src/renderer/shell/client.ts) reads __natstackTransport directly.
 */

import { createWsTransport, type TransportBridge } from "./wsTransport.js";
import { parseWsPort, parseShellToken } from "./preloadUtils.js";

// =============================================================================
// Shell WS Transport
// =============================================================================

const wsPort = parseWsPort();
const shellToken = parseShellToken();
if (!wsPort || !shellToken) {
  throw new Error("Shell WS config not provided (--natstack-ws-port and --natstack-shell-token required)");
}

const shellTransport: TransportBridge = createWsTransport({
  viewId: "shell",
  wsPort,
  authToken: shellToken,
  callerKind: "shell",
});

// Expose the transport global for the shell client's direct @natstack/rpc bridge
declare global {
  var __natstackTransport: TransportBridge | undefined;
}

// Set global directly (shell uses contextIsolation: false)
globalThis.__natstackTransport = shellTransport;
