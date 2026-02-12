/**
 * Shell preload script.
 * Creates a WS transport for the shell renderer to communicate with main process.
 */

import { createWsTransport, type TransportBridge } from "./wsTransport.js";
import { parseWsPort, parseShellToken, parseServerPort, parseServerToken } from "./preloadUtils.js";

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

// Set up NatStack globals for @natstack/runtime packages
// The shell is identified as "shell" and has a fixed session
declare global {
  var __natstackTransport: TransportBridge | undefined;
}

// Set globals directly (shell uses contextIsolation: false)
globalThis.__natstackTransport = shellTransport;
globalThis.__natstackId = "shell";
globalThis.__natstackContextId = "shell-context";
globalThis.__natstackKind = "shell";

// Create server transport if server params are available
const serverPort = parseServerPort();
const serverToken = parseServerToken();
if (serverPort && serverToken) {
  globalThis.__natstackServerTransport = createWsTransport({
    viewId: "shell",
    wsPort: serverPort,
    authToken: serverToken,
    callerKind: "shell",
  });
}
