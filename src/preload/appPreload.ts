/**
 * App preload — privileged workspace-app bridge.
 *
 * The app principal is enforced in the main process from WebContents metadata;
 * this preload is only the renderer-facing transport surface.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { createIpcTransport } from "./ipcTransport.js";

let nextListenerId = 1;
const activeListeners = new Map<
  number,
  (event: IpcRendererEvent, eventName: string, payload: unknown) => void
>();
const appTransport = createIpcTransport();

const serviceCall = (method: string, ...args: unknown[]) =>
  ipcRenderer.invoke("natstack:serviceCall", method, args);

const natstackApp = {
  getBootstrapConfig: () => ipcRenderer.invoke("natstack:getPanelInit"),
  getInfo: () => ipcRenderer.invoke("natstack:bridge.getInfo"),
  setStateArgs: (updates: Record<string, unknown>) =>
    ipcRenderer.invoke("natstack:bridge.setStateArgs", updates),
  serviceCall,
  panel: {
    create: (source: string, opts?: unknown) =>
      ipcRenderer.invoke("natstack:panel.create", source, opts),
    list: (parentId?: string | null) => ipcRenderer.invoke("natstack:panel.list", parentId),
    close: (id: string) => ipcRenderer.invoke("natstack:panel.close", id),
    reload: (id: string) => ipcRenderer.invoke("natstack:panel.reload", id),
    getStateArgs: (id: string) => ipcRenderer.invoke("natstack:panel.getStateArgs", id),
    setStateArgs: (id: string, updates: Record<string, unknown>) =>
      ipcRenderer.invoke("natstack:panel.setStateArgs", id, updates),
    snapshot: (id: string) => ipcRenderer.invoke("natstack:panel.snapshot", id),
  },
  native: {
    menu: {
      call: (method: string, ...args: unknown[]) => serviceCall(`menu.${method}`, ...args),
    },
    notifications: {
      call: (method: string, ...args: unknown[]) => serviceCall(`notification.${method}`, ...args),
    },
    tray: {
      call: async () => {
        throw new Error("Native tray capability is not implemented by this app host");
      },
    },
    globalShortcut: {
      call: async () => {
        throw new Error("Native global shortcut capability is not implemented by this app host");
      },
    },
    fs: {
      call: (method: string, ...args: unknown[]) => serviceCall(`fs.${method}`, ...args),
    },
  },
  addEventListener: (handler: (event: string, payload: unknown) => void): number => {
    const id = nextListenerId++;
    const listener = (_e: IpcRendererEvent, event: string, payload: unknown) =>
      handler(event, payload);
    activeListeners.set(id, listener);
    ipcRenderer.on("natstack:event", listener);
    return id;
  },
  removeEventListener: (id: number) => {
    const listener = activeListeners.get(id);
    if (listener) {
      ipcRenderer.off("natstack:event", listener);
      activeListeners.delete(id);
    }
  },
};

contextBridge.exposeInMainWorld("__natstackApp", natstackApp);
contextBridge.exposeInMainWorld("__natstackTransport", appTransport);
contextBridge.exposeInMainWorld("__natstackShellOverlay", {
  onEvent(handler: (event: unknown) => void) {
    const listener = (_event: IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on("natstack:shell-overlay:event", listener);
    return () => ipcRenderer.off("natstack:shell-overlay:event", listener);
  },
});
contextBridge.exposeInMainWorld("__natstackIncomingPairLink", {
  getPending() {
    return ipcRenderer.invoke("natstack:drain-pair-link") as Promise<{
      url: string;
      code: string;
    } | null>;
  },
  onLink(handler: (link: { url: string; code: string }) => void) {
    const listener = (_event: IpcRendererEvent, payload: { url: string; code: string }) =>
      handler(payload);
    ipcRenderer.on("natstack:incoming-pair-link", listener);
    return () => ipcRenderer.off("natstack:incoming-pair-link", listener);
  },
});
