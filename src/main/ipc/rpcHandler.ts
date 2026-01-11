import { MessageChannelMain } from "electron";
import { handle } from "./handlers.js";
import type { PanelManager } from "../panelManager.js";
import { isViewManagerInitialized, getViewManager } from "../viewManager.js";

export class PanelRpcHandler {
  constructor(private panelManager: PanelManager) {
    this.registerHandlers();
  }

  private registerHandlers(): void {
    handle("panel-rpc:connect", async (event, fromPanelId: string, toPanelId: string) => {
      this.assertAuthorized(event, fromPanelId);
      this.assertCanCommunicate(fromPanelId, toPanelId);

      // Create a MessageChannelMain for direct communication
      const { port1, port2 } = new MessageChannelMain();

      // Get the target panel's webContents (wait briefly for it to be ready)
      const targetContents = await this.waitForPanelWebContents(toPanelId);

      // Send port1 to the requester (fromPanel)
      event.sender.postMessage("panel-rpc:port", { targetPanelId: toPanelId }, [port1]);

      // Send port2 to the target (toPanel)
      targetContents.postMessage("panel-rpc:port", { targetPanelId: fromPanelId }, [port2]);
    });
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
    if (!isViewManagerInitialized()) {
      return undefined;
    }
    const contents = getViewManager().getWebContents(panelId);
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
