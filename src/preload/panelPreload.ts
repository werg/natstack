/**
 * Panel preload — exposes the host-local shell bridge.
 *
 * App panels only get this preload. Browser panels (external URLs) do NOT —
 * they get browserPreload.ts with autofill only.
 */

import { contextBridge, ipcRenderer } from "electron";

// ID-based event listener pattern (contextBridge cannot serialize closures)
let nextListenerId = 1;
const activeListeners = new Map<number, (...args: any[]) => void>();

const natstackShell = {
  // Panel lifecycle (Electron-owned UI mutations)
  getPanelInit: () => ipcRenderer.invoke("natstack:getPanelInit"),
  getBootstrapConfig: () => ipcRenderer.invoke("natstack:getPanelInit"),
  getInfo: () => ipcRenderer.invoke("natstack:bridge.getInfo"),
  setStateArgs: (updates: Record<string, unknown>) => ipcRenderer.invoke("natstack:bridge.setStateArgs", updates),
  closeSelf: () => ipcRenderer.invoke("natstack:bridge.closeSelf"),
  closeChild: (childId: string) => ipcRenderer.invoke("natstack:bridge.closeChild", childId),
  focusPanel: (panelId: string) => ipcRenderer.invoke("natstack:bridge.focusPanel", panelId),
  createBrowserPanel: (url: string, opts?: unknown) =>
    ipcRenderer.invoke("natstack:bridge.createBrowserPanel", url, opts),

  // Electron-native
  openDevtools: () => ipcRenderer.invoke("natstack:bridge.openDevtools"),
  openFolderDialog: (opts?: unknown) => ipcRenderer.invoke("natstack:bridge.openFolderDialog", opts),
  openExternal: (url: string) => ipcRenderer.invoke("natstack:bridge.openExternal", url),
  openOAuthExternal: (url: string, expectedRedirectUri: string) =>
    ipcRenderer.invoke("natstack:bridge.openOAuthExternal", url, expectedRedirectUri),

  // Browser automation (CdpServer)
  getCdpEndpoint: (id: string) => ipcRenderer.invoke("natstack:getCdpEndpoint", id),
  navigate: (id: string, url: string) => ipcRenderer.invoke("natstack:navigate", id, url),
  goBack: (id: string) => ipcRenderer.invoke("natstack:goBack", id),
  goForward: (id: string) => ipcRenderer.invoke("natstack:goForward", id),
  reload: (id: string) => ipcRenderer.invoke("natstack:reload", id),
  stop: (id: string) => ipcRenderer.invoke("natstack:stop", id),

  // Generic Electron service dispatch — lets panels call Electron-local services
  // (e.g., browser-data, autofill) via IPC instead of going through the server.
  serviceCall: (method: string, ...args: unknown[]) =>
    ipcRenderer.invoke("natstack:serviceCall", method, args),

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
};

contextBridge.exposeInMainWorld("__natstackShell", natstackShell);
contextBridge.exposeInMainWorld("__natstackElectron", natstackShell);
