/**
 * Panel preload — exposes __natstackElectron via contextBridge.
 *
 * App panels only get this preload. Browser panels (external URLs) do NOT —
 * they get browserPreload.ts with autofill only (no __natstackElectron).
 * This is a trust boundary: app panels are workspace code we control;
 * browser panels are arbitrary websites.
 */

import { contextBridge, ipcRenderer } from "electron";

// ID-based event listener pattern (contextBridge cannot serialize closures)
let nextListenerId = 1;
const activeListeners = new Map<number, (...args: any[]) => void>();

contextBridge.exposeInMainWorld("__natstackElectron", {
  // Panel lifecycle (Electron-owned UI mutations)
  closeSelf: () => ipcRenderer.invoke("natstack:closeSelf"),
  closeChild: (childId: string) => ipcRenderer.invoke("natstack:closeChild", childId),
  focusPanel: (panelId: string) => ipcRenderer.invoke("natstack:focusPanel", panelId),
  createBrowserPanel: (url: string, opts?: unknown) =>
    ipcRenderer.invoke("natstack:createBrowserPanel", url, opts),
  getBootstrapConfig: () => ipcRenderer.invoke("natstack:getBootstrapConfig"),

  // Electron-native
  openDevtools: () => ipcRenderer.invoke("natstack:openDevtools"),
  openFolderDialog: (opts?: unknown) => ipcRenderer.invoke("natstack:openFolderDialog", opts),
  openExternal: (url: string) => ipcRenderer.invoke("natstack:openExternal", url),

  // Browser automation (CdpServer)
  getCdpEndpoint: (id: string) => ipcRenderer.invoke("natstack:getCdpEndpoint", id),
  navigate: (id: string, url: string) => ipcRenderer.invoke("natstack:navigate", id, url),
  goBack: (id: string) => ipcRenderer.invoke("natstack:goBack", id),
  goForward: (id: string) => ipcRenderer.invoke("natstack:goForward", id),
  reload: (id: string) => ipcRenderer.invoke("natstack:reload", id),
  stop: (id: string) => ipcRenderer.invoke("natstack:stop", id),

  // Event subscription (Electron→panel push: theme, focus, child-created)
  // Returns a numeric subscription ID; call removeEventListener(id) to unsubscribe.
  addEventListener: (handler: (event: string, payload: unknown) => void): number => {
    const id = nextListenerId++;
    const listener = (_e: unknown, event: string, payload: unknown) => handler(event, payload);
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
});
