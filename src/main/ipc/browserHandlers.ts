/**
 * Browser service handlers for panel RPC calls.
 * Handles browser panel operations like navigation, CDP endpoint access, etc.
 */

import type { CdpServer } from "../cdpServer.js";
import type { ViewManager } from "../viewManager.js";

export function getCdpEndpointForCaller(cdpServer: CdpServer, browserId: string, callerId: string): string {
  const endpoint = cdpServer.getCdpEndpoint(browserId, callerId);
  if (!endpoint) {
    throw new Error("Access denied: you do not own this browser panel");
  }
  return endpoint;
}

/**
 * Handle browser service calls from panels.
 *
 * @param cdpServer - CdpServer instance for CDP endpoint management
 * @param viewManager - ViewManager instance for webContents access
 * @param panelId - The calling panel's ID (must own the browser)
 * @param method - The method name (e.g., "navigate", "goBack")
 * @param args - The method arguments (first arg is always browserId)
 * @returns The result of the method call
 */
export async function handleBrowserCall(
  cdpServer: CdpServer,
  viewManager: ViewManager,
  panelId: string,
  method: string,
  args: unknown[]
): Promise<unknown> {
  const [browserId] = args as [string];

  const assertOwner = () => {
    if (!cdpServer.panelOwnsBrowser(panelId, browserId)) {
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
      return getCdpEndpointForCaller(cdpServer, browserId, panelId);
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
      const wc = getContents();
      if (wc.canGoBack()) wc.goBack();
      return;
    }
    case "goForward": {
      assertOwner();
      const wc = getContents();
      if (wc.canGoForward()) wc.goForward();
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
