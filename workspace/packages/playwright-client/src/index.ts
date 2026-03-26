/**
 * Playwright client — connects to NatStack's CdpServer via CDP WebSocket.
 *
 * Uses BrowserImpl.connect() which speaks the Chrome DevTools Protocol
 * directly to the CdpServer (Electron's webContents.debugger proxy).
 */

import { BrowserImpl } from '@workspace/playwright-core';

import type { Browser } from '@workspace/playwright-core';

export { BrowserImpl };
export type { Browser };

export type Options = {
  headless?: boolean;
};

export async function connect(wsEndpoint: string, _browserName: string, _options: Options): Promise<Browser> {
  return BrowserImpl.connect(wsEndpoint, { isElectronWebview: true });
}
