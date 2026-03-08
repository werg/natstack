import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__natstack_autofill", {
  ping: () => ipcRenderer.send("natstack:autofill:ping"),
});
