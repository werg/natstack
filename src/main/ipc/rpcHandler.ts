import { ipcMain, MessageChannelMain, webContents } from "electron";
import { handle } from "./handlers.js";
import type { PanelManager } from "../panelManager.js";
import { getWorkerManager } from "../workerManager.js";
import type { RpcMessage } from "../../shared/rpc/types.js";

export class PanelRpcHandler {
  constructor(private panelManager: PanelManager) {
    this.registerHandlers();
  }

  private registerHandlers(): void {
    handle("panel-rpc:connect", async (event, fromPanelId: string, toPanelId: string) => {
      this.assertAuthorized(event, fromPanelId);
      this.assertCanCommunicate(fromPanelId, toPanelId);

      // Check if target is a worker
      const targetPanel = this.panelManager.getPanel(toPanelId);
      if (targetPanel?.type === "worker") {
        // For workers, we use a proxy approach via IPC
        // The panel will send messages via "panel-rpc:to-worker" and receive via "worker-rpc:message"
        return { isWorker: true, workerId: toPanelId };
      }

      // Create a MessageChannelMain for direct communication
      const { port1, port2 } = new MessageChannelMain();

      // Get the target panel's webContents (wait briefly for it to be ready)
      const targetContents = await this.waitForPanelWebContents(toPanelId);

      // Send port1 to the requester (fromPanel)
      event.sender.postMessage("panel-rpc:port", { targetPanelId: toPanelId }, [port1]);

      // Send port2 to the target (toPanel)
      targetContents.postMessage("panel-rpc:port", { targetPanelId: fromPanelId }, [port2]);

      return { isWorker: false };
    });

    // Handle messages from panel to worker
    ipcMain.on(
      "panel-rpc:to-worker",
      (event, fromPanelId: string, toWorkerId: string, message: RpcMessage) => {
        // Verify the sender
        const senderPanelId = this.panelManager.getPanelIdForWebContents(event.sender);
        if (senderPanelId !== fromPanelId) {
          return;
        }

        // Verify communication is allowed
        try {
          this.assertCanCommunicate(fromPanelId, toWorkerId);
        } catch {
          return;
        }

        // Route to worker via WorkerManager
        const workerManager = getWorkerManager();
        workerManager.routeRpcToWorker(fromPanelId, toWorkerId, message);
      }
    );
  }

  private assertAuthorized(event: Electron.IpcMainInvokeEvent, panelId: string): void {
    const senderPanelId = this.panelManager.getPanelIdForWebContents(event.sender);
    if (senderPanelId !== panelId) {
      throw new Error(`Unauthorized: Sender ${senderPanelId} cannot act as ${panelId}`);
    }
  }

  private assertCanCommunicate(fromPanelId: string, toPanelId: string): void {
    const fromPanel = this.panelManager.getPanel(fromPanelId);
    const toPanel = this.panelManager.getPanel(toPanelId);

    if (!fromPanel || !toPanel) {
      throw new Error("One or both panels not found");
    }

    // Check if fromPanel is parent of toPanel
    const isParent = fromPanel.children.some((child) => child.id === toPanelId);
    // Check if toPanel is parent of fromPanel
    const isChild = toPanel.children.some((child) => child.id === fromPanelId);

    if (!isParent && !isChild) {
      throw new Error("Panels can only communicate with their direct parent or children");
    }
  }

  private getPanelWebContents(panelId: string): Electron.WebContents | undefined {
    const views = this.panelManager.getPanelViews(panelId);
    if (!views || views.size === 0) {
      return undefined;
    }
    // Get the first view (panels typically have one view)
    const contentsId = views.values().next().value;
    if (contentsId === undefined) {
      return undefined;
    }
    const contents = webContents.fromId(contentsId);
    return contents && !contents.isDestroyed() ? contents : undefined;
  }

  private async waitForPanelWebContents(
    panelId: string,
    timeoutMs = 60000,
    pollMs = 100
  ): Promise<Electron.WebContents> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const contents = this.getPanelWebContents(panelId);
      if (contents) {
        return contents;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(`Target panel ${panelId} is not available`);
  }
}
