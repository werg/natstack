/**
 * Browser-compatible Playwright Core
 * Exports the main classes needed for CDP-based browser automation
 */
// Main entry point
export { Playwright } from './client/playwright';
// Browser & Context classes
export { Browser } from './client/browser';
export { BrowserContext } from './client/browserContext';
export { BrowserType } from './client/browserType';
// Page & Frame
export { Page } from './client/page';
export { Frame } from './client/frame';
// Locators
export { Locator } from './client/locator';
// Network
export { Request } from './client/network';
export { Response } from './client/network';
export { Route } from './client/network';
export { WebSocket } from './client/network';
// Handle types
export { JSHandle } from './client/jsHandle';
export { ElementHandle } from './client/elementHandle';
// Events & errors
export { TimeoutError, TargetClosedError } from './client/errors';
// API Request
export { APIRequest, APIRequestContext, APIResponse } from './client/fetch';
// Platform abstraction
export { emptyPlatform } from './client/platform';
// Re-export webPlatform if available (provided by @natstack/playwright-client)
// This is just a type-safe placeholder - the actual implementation is in playwright-client
// Re-export connection infrastructure
export { Connection } from './client/connection';
export { ChannelOwner } from './client/channelOwner';
// Utilities
export { Selectors } from './client/selectors';
//# sourceMappingURL=index.js.map