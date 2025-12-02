/**
 * Browser-compatible Playwright Core
 * Exports the main classes needed for CDP-based browser automation in a sandboxed context
 *
 * NOTE: This bundle is optimized for browser-only use with a proxied CDP connection.
 * Server-side functionality (file I/O, process management, video encoding, tracing)
 * is intentionally omitted. If you need these features, use the full Playwright package.
 */

// Main entry point
export { Playwright } from './client/playwright';

// Browser & Context classes - core automation targets
export { Browser } from './client/browser';
export { BrowserContext } from './client/browserContext';

// Page & Frame - primary interaction surface
export { Page } from './client/page';
export { Frame } from './client/frame';

// Locators - selector and element querying
export { Locator } from './client/locator';

// Network - request/response handling
export { Request } from './client/network';
export { Response } from './client/network';
export { Route } from './client/network';
export { WebSocket } from './client/network';

// JS Interop - handle execution and manipulation
export { JSHandle } from './client/jsHandle';
export { ElementHandle } from './client/elementHandle';

// Error types
export { TimeoutError, TargetClosedError } from './client/errors';

// Platform abstraction - runtime environment bridge
export { emptyPlatform, webPlatform } from './client/platform';
export type { Platform } from './client/platform';

// Connection infrastructure - CDP protocol handling
export { Connection } from './client/connection';
export { ChannelOwner } from './client/channelOwner';

// Selector utilities
export { Selectors } from './client/selectors';

// NOTE: The following are NOT exported to minimize bundle size:
// - BrowserType (browser launching is not supported in browser contexts)
// - APIRequest/APIRequestContext/APIResponse (HTTP client - use fetch instead)
// - Artifact, Download, Video, Tracing (file-based operations require server)
// - LocalUtils (filesystem utilities are server-side only)
// - Coverage (code coverage requires server instrumentation)
// - Dialog, FileChooser (handled via CDP events, direct access not needed)
// - Worker (not typically needed in browser automation)
// - ConsoleMessage (subscribed via events instead)
// - HARRouter (HAR recording is server-side)
