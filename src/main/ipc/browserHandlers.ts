/**
 * Browser service handlers for panel RPC calls.
 * Handles browser panel operations like navigation, CDP endpoint access, etc.
 */

import type { CdpServer } from "../cdpServer.js";
import type { ViewManager } from "../viewManager.js";
import type { PanelManager } from "../panelManager.js";
import type { CallerKind } from "../serviceDispatcher.js";

export function getCdpEndpointForCaller(cdpServer: CdpServer, browserId: string, callerId: string): string {
  const endpoint = cdpServer.getCdpEndpoint(browserId, callerId);
  if (!endpoint) {
    throw new Error("Access denied: you do not own this browser panel");
  }
  return endpoint;
}

/**
 * Handle browser service calls from panels and workers.
 *
 * @param cdpServer - CdpServer instance for CDP endpoint management
 * @param viewManager - ViewManager instance for webContents access
 * @param callerId - The calling panel/worker ID
 * @param callerKind - Whether the caller is a panel or worker
 * @param method - The method name (e.g., "navigate", "goBack")
 * @param args - The method arguments (first arg is always browserId)
 * @returns The result of the method call
 */
export async function handleBrowserCall(
  cdpServer: CdpServer,
  viewManager: ViewManager,
  panelManager: PanelManager,
  callerId: string,
  callerKind: CallerKind,
  method: string,
  args: unknown[]
): Promise<unknown> {
  // Workers can only access getCdpEndpoint
  if (callerKind === "worker" && method !== "getCdpEndpoint") {
    throw new Error("Workers may only call browser.getCdpEndpoint");
  }

  const [browserId] = args as [string];

  const assertOwner = () => {
    if (!cdpServer.panelOwnsBrowser(callerId, browserId)) {
      throw new Error("Access denied: you do not own this browser panel");
    }
  };

  const getContents = () => {
    const wc = viewManager.getWebContents(browserId);
    if (!wc) throw new Error(`Browser webContents not found for ${browserId}`);
    return wc;
  };

  switch (method) {
    case "getCdpEndpoint": {
      return getCdpEndpointForCaller(cdpServer, browserId, callerId);
    }
    case "navigate": {
      const [, url] = args as [string, string];
      assertOwner();
      const wc = getContents();
      try {
        await wc.loadURL(url);
      } catch (err) {
        const error = err as { code?: string; errno?: number };
        // Ignore navigation aborted errors (user navigated away before load completed)
        if (error.errno === -3 || error.code === "ERR_ABORTED") {
          return;
        }
        throw err;
      }
      return;
    }
    case "goBack": {
      assertOwner();
      await panelManager.goBack(browserId);
      return;
    }
    case "goForward": {
      assertOwner();
      await panelManager.goForward(browserId);
      return;
    }
    case "reload": {
      assertOwner();
      getContents().reload();
      return;
    }
    case "stop": {
      assertOwner();
      getContents().stop();
      return;
    }
    default:
      throw new Error(`Unknown browser method: ${method}`);
  }
}
