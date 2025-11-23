import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { AllIpcApi, IpcChannel, IpcHandler } from "../../shared/ipc/index.js";

// Type-safe handler registration for main process
export function handle<C extends IpcChannel>(
  channel: C,
  handler: (
    event: IpcMainInvokeEvent,
    ...args: Parameters<IpcHandler<C>>
  ) => ReturnType<IpcHandler<C>> | Promise<ReturnType<IpcHandler<C>>>
): void {
  ipcMain.handle(channel, handler as Parameters<typeof ipcMain.handle>[1]);
}

// Register multiple handlers at once
export function registerHandlers(handlers: {
  [C in IpcChannel]?: (
    event: IpcMainInvokeEvent,
    ...args: Parameters<AllIpcApi[C]>
  ) => ReturnType<AllIpcApi[C]> | Promise<ReturnType<AllIpcApi[C]>>;
}): void {
  for (const [channel, handler] of Object.entries(handlers)) {
    if (handler) {
      ipcMain.handle(channel, handler as Parameters<typeof ipcMain.handle>[1]);
    }
  }
}
