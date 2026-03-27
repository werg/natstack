/**
 * IPC transport bridge for the shell renderer.
 *
 * Replaces the WebSocket transport with Electron IPC (ipcRenderer ↔ ipcMain).
 * The shell no longer needs a WebSocket connection to the RPC server.
 */

import { ipcRenderer } from "electron";
import type { TransportBridge } from "./wsTransport.js";

type AnyMessageHandler = (fromId: string, message: unknown) => void;

/**
 * Create an IPC-based transport bridge for the shell.
 *
 * Messages are sent via ipcRenderer.send("natstack:rpc:send", targetId, message)
 * and received via ipcRenderer.on("natstack:rpc:message", (event, fromId, message)).
 */
export function createIpcTransport(): TransportBridge {
  const listeners = new Set<AnyMessageHandler>();

  // Receive messages from main process
  ipcRenderer.on("natstack:rpc:message", (_event, fromId: string, message: unknown) => {
    for (const listener of listeners) {
      try {
        listener(fromId, message);
      } catch (error) {
        console.error("Error in IPC transport message handler:", error);
      }
    }
  });

  return {
    async send(targetId: string, message: unknown): Promise<void> {
      ipcRenderer.send("natstack:rpc:send", targetId, message);
    },

    onMessage(handler: AnyMessageHandler): () => void {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
}
