import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__natstack_autofill_overlay", {
  select: (id: number) => ipcRenderer.send("natstack:autofill-overlay:select", id),
  dismiss: () => ipcRenderer.send("natstack:autofill-overlay:dismiss"),
});
