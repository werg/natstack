/**
 * Browser-compatible Playwright Core
 * Exports the main classes needed for CDP-based browser automation
 */
export { Playwright } from './client/playwright';
export { Browser } from './client/browser';
export { BrowserContext } from './client/browserContext';
export { BrowserType } from './client/browserType';
export { Page } from './client/page';
export { Frame } from './client/frame';
export { Locator } from './client/locator';
export { Request } from './client/network';
export { Response } from './client/network';
export { Route } from './client/network';
export { WebSocket } from './client/network';
export { JSHandle } from './client/jsHandle';
export { ElementHandle } from './client/elementHandle';
export { TimeoutError, TargetClosedError } from './client/errors';
export { APIRequest, APIRequestContext, APIResponse } from './client/fetch';
export { emptyPlatform } from './client/platform';
export type { Platform } from './client/platform';
export { Connection } from './client/connection';
export { ChannelOwner } from './client/channelOwner';
export { Selectors } from './client/selectors';
//# sourceMappingURL=index.d.ts.map