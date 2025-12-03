/**
 * Browser-friendly Playwright Core surface.
 * Exposes client-side primitives and a minimal CDP transport that work in sandboxed panels.
 */

// Main client entry point
export { Playwright } from './client/playwright';

// Browser & Context classes - client channel side
export { Browser } from './client/browser';
export { BrowserContext } from './client/browserContext';

// Page & Frame
export { Page } from './client/page';
export { Frame } from './client/frame';

// Locators and selectors
export { Locator } from './client/locator';
export { Selectors } from './client/selectors';

// Network
export { Request, Response, Route, WebSocket } from './client/network';

// JS handles
export { JSHandle } from './client/jsHandle';
export { ElementHandle } from './client/elementHandle';

// Errors
export { TimeoutError, TargetClosedError } from './client/errors';

// Platform abstractions
export { emptyPlatform, webPlatform } from './client/platform';
export type { Platform } from './client/platform';

// Client-side connection layer
export { Connection } from './client/connection';
export { ChannelOwner } from './client/channelOwner';

// Minimal server-side CDP wiring that is browser-safe
export { CRConnection, CRSession, ConnectionEvents, kBrowserCloseMessageId } from './server/chromium/crConnection';
export { BrowserWebSocketTransport } from './server/browserTransport';
export type { BrowserWebSocketTransportOptions } from './server/browserTransport';
export type { ConnectionTransport, ProtocolRequest, ProtocolResponse } from './server/transport';
export { helper } from './server/helper';
export { RecentLogsCollector } from './server/utils/debugLogger';

// Browser environment validation
export { validateBrowserEnvironment } from './client/validateBrowserEnvironment';

// CDP Adapter and related utilities
export { CDPAdapter } from './client/cdpAdapter';
export { FrameAdapter } from './client/frameAdapter';
export { InjectedScriptLoader } from './client/injectedScriptLoader';
