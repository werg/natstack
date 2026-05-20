/**
 * Shell preload script.
 * Creates an IPC transport for the shell renderer to communicate with main process.
 * The shell client (src/renderer/shell/client.ts) reads __natstackTransport directly.
 */

import { createIpcTransport } from "./ipcTransport.js";
import type { TransportBridge } from "./wsTransport.js";
import { ipcRenderer, type IpcRendererEvent } from "electron";

// =============================================================================
// Shell IPC Transport
// =============================================================================

const shellTransport: TransportBridge = createIpcTransport();

// Expose the transport global for the shell client's direct @workspace/rpc bridge
declare global {
  var __natstackTransport: TransportBridge | undefined;
  var __natstackShellOverlay:
    | {
        onEvent: (handler: (event: unknown) => void) => () => void;
      }
    | undefined;
  var __natstackIncomingPairLink:
    | {
        getPending: () => Promise<{ url: string; code: string } | null>;
        onLink: (handler: (link: { url: string; code: string }) => void) => () => void;
      }
    | undefined;
}

// Set global directly (shell uses contextIsolation: false)
globalThis.__natstackTransport = shellTransport;

globalThis.__natstackShellOverlay = {
  onEvent(handler) {
    const listener = (_event: IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on("natstack:shell-overlay:event", listener);
    return () => ipcRenderer.off("natstack:shell-overlay:event", listener);
  },
};

globalThis.__natstackIncomingPairLink = {
  getPending() {
    return ipcRenderer.invoke("natstack:drain-pair-link") as Promise<{
      url: string;
      code: string;
    } | null>;
  },
  onLink(handler) {
    const listener = (_event: IpcRendererEvent, payload: { url: string; code: string }) =>
      handler(payload);
    ipcRenderer.on("natstack:incoming-pair-link", listener);
    return () => ipcRenderer.off("natstack:incoming-pair-link", listener);
  },
};
