/**
 * Panel preload — exposes the host-local shell bridge.
 *
 * App panels only get this preload. Browser panels (external URLs) do NOT —
 * they get browserPreload.ts with autofill only.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

// ID-based event listener pattern (contextBridge cannot serialize closures)
let nextListenerId = 1;
const activeListeners = new Map<
  number,
  (event: IpcRendererEvent, eventName: string, payload: unknown) => void
>();
const agentHandlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();

ipcRenderer.on("natstack:panel.callAgent.request", async (_event, payload: unknown) => {
  const request = payload as
    | { type: "cancel"; requestId: number }
    | { requestId: number; method: string; args?: unknown[] };
  if ("type" in request && request.type === "cancel") return;
  if (!("method" in request)) return;
  const handler = agentHandlers.get(request.method);
  if (!handler) {
    ipcRenderer.send("natstack:panel.callAgent.response", request.requestId, {
      ok: false,
      error: { code: "method-not-found", message: `Agent method not found: ${request.method}` },
    });
    return;
  }
  try {
    const value = await handler(...(request.args ?? []));
    ipcRenderer.send("natstack:panel.callAgent.response", request.requestId, { ok: true, value });
  } catch (error) {
    ipcRenderer.send("natstack:panel.callAgent.response", request.requestId, {
      ok: false,
      error: {
        code: "panel-error",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

const natstackShell = {
  // Panel lifecycle (Electron-owned UI mutations)
  getPanelInit: () => ipcRenderer.invoke("natstack:getPanelInit"),
  getBootstrapConfig: () => ipcRenderer.invoke("natstack:getPanelInit"),
  getInfo: () => ipcRenderer.invoke("natstack:bridge.getInfo"),
  setStateArgs: (updates: Record<string, unknown>) =>
    ipcRenderer.invoke("natstack:bridge.setStateArgs", updates),
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
    callAgent: (id: string, method: string, args?: unknown[], opts?: unknown) =>
      ipcRenderer.invoke("natstack:panel.callAgent", id, method, args, opts),
    registerAgentHandler: (method: string, handler: (...args: unknown[]) => unknown) => {
      agentHandlers.set(method, handler);
    },
  },
  focusPanel: (panelId: string) => ipcRenderer.invoke("natstack:focusPanel", panelId),

  // Electron-native
  openDevtools: () => ipcRenderer.invoke("natstack:openDevtools"),
  openFolderDialog: (opts?: unknown) => ipcRenderer.invoke("natstack:openFolderDialog", opts),
  openExternal: (url: string, options?: unknown) =>
    ipcRenderer.invoke("natstack:openExternal", url, options),

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

contextBridge.exposeInMainWorld("__natstackShell", natstackShell);
contextBridge.exposeInMainWorld("__natstackElectron", natstackShell);
