/**
 * Bootstrap launch-gate preload.
 *
 * This is deliberately smaller than the workspace app preload. The shipped
 * launch gate can only call the closed set of host RPC methods needed to
 * launch the selected host target and resolve the startup app approvals that
 * launch returns.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { TransportBridge } from "./wsTransport.js";
import { assertBootstrapRpcMessageAllowed } from "./bootstrapTransportPolicy.js";

type AnyMessageHandler = (fromId: string, message: unknown) => void;

type BootstrapBridge = {
  getState: () => Promise<unknown>;
  launchLocalWorkspace: (workspaceName?: string) => Promise<unknown>;
  launchEphemeralWorkspace: () => Promise<unknown>;
  connectSelectedRemoteWorkspace: () => Promise<unknown>;
  listRemoteWorkspaces: () => Promise<unknown>;
  connectRemoteWorkspace: (workspaceName: string) => Promise<unknown>;
  pairRemote: (payload: {
    url: string;
    code: string;
    caPath?: string;
    fingerprint?: string;
    label?: string;
  }) => Promise<unknown>;
};

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

const bootstrapBridge: BootstrapBridge = {
  getState: () => ipcRenderer.invoke("natstack:bootstrap:get-state"),
  launchLocalWorkspace: (workspaceName) =>
    ipcRenderer.invoke("natstack:bootstrap:launch-local-workspace", workspaceName),
  launchEphemeralWorkspace: () =>
    ipcRenderer.invoke("natstack:bootstrap:launch-ephemeral-workspace"),
  connectSelectedRemoteWorkspace: () =>
    ipcRenderer.invoke("natstack:bootstrap:connect-selected-remote-workspace"),
  listRemoteWorkspaces: () => ipcRenderer.invoke("natstack:bootstrap:list-remote-workspaces"),
  connectRemoteWorkspace: (workspaceName) =>
    ipcRenderer.invoke("natstack:bootstrap:connect-remote-workspace", workspaceName),
  pairRemote: (payload) => ipcRenderer.invoke("natstack:bootstrap:pair-remote", payload),
};

contextBridge.exposeInMainWorld("__natstackTransport", bootstrapTransport);
contextBridge.exposeInMainWorld("__natstackBootstrap", bootstrapBridge);
