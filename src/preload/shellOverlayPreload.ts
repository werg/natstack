import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__natstack_shell_overlay", {
  emit: (type: string, payload?: unknown) => ipcRenderer.send("natstack:shell-overlay:event", { type, payload }),
  hide: () => ipcRenderer.send("natstack:shell-overlay:hide"),
});
