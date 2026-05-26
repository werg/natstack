/**
 * Bootstrap/recovery preload.
 *
 * This is deliberately smaller than the workspace app preload. The shipped
 * recovery UI can only call the closed set of host RPC methods needed to
 * approve unit batches, reseed the canonical shell, inspect shell logs, open
 * the workspace path, and switch/create workspaces.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { TransportBridge } from "./wsTransport.js";
import { assertBootstrapRpcMessageAllowed } from "./bootstrapTransportPolicy.js";

type AnyMessageHandler = (fromId: string, message: unknown) => void;

const bootstrapTransport: TransportBridge = (() => {
  const listeners = new Set<AnyMessageHandler>();

  ipcRenderer.on("natstack:rpc:message", (_event, fromId: string, message: unknown) => {
    for (const listener of listeners) {
      try {
        listener(fromId, message);
      } catch (error) {
        console.error("Error in bootstrap transport message handler:", error);
      }
    }
  });

  return {
    async send(targetId: string, message: unknown): Promise<void> {
      assertBootstrapRpcMessageAllowed(targetId, message);
      ipcRenderer.send("natstack:rpc:send", targetId, message);
    },

    onMessage(handler: AnyMessageHandler): () => void {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },

    onRecovery(): () => void {
      return () => {};
    },
  };
})();

contextBridge.exposeInMainWorld("__natstackTransport", bootstrapTransport);
