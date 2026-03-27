/**
 * Browser panel preload — autofill only (no __natstackElectron).
 *
 * Browser panels load arbitrary external websites and must NOT have access
 * to host IPC. Only password autofill is injected.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__natstack_autofill", {
  ping: () => ipcRenderer.send("natstack:autofill:ping"),
});
