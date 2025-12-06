/**
 * BrowserImpl - CDP-direct Browser implementation
 * Provides Playwright Browser API using direct CDP calls instead of RPC
 */

import { CDPAdapter } from './cdpAdapter';
import { PageImpl } from './pageImpl';
import { BrowserContextImpl } from './browserContextImpl';
import { EventEmitter } from './eventEmitter';
import { Events } from './events';
import { BrowserWebSocketTransport } from '../server/browserTransport';
import { CRConnection, CRSession } from '../server/chromium/crConnection';
import { createRootSdkObject } from '../server/instrumentation';
import { RecentLogsCollector } from '../server/utils/debugLogger';

import type { BrowserWebSocketTransportOptions } from '../server/browserTransport';
import type { Protocol } from '../server/chromium/protocol';
import type { Page } from './page';
import type { BrowserContext } from './browserContext';

export interface BrowserConnectOptions {
  transportOptions?: BrowserWebSocketTransportOptions;
  /**
   * When true, treats the CDP endpoint as an Electron webview where the root
   * session IS the page (no Target.getTargets/attachToTarget needed).
   * Default: true (optimized for natstack browser panels)
   */
  isElectronWebview?: boolean;
}

/**
 * CDP-direct Browser implementation
 * Maintains Playwright Browser API while using direct CDP protocol
 */
export class BrowserImpl {
  private _connection: CRConnection;
  private _adapter: CDPAdapter;
  private _version: string = '';
  private _defaultContext: BrowserContextImpl;
  private _contexts: Map<string, BrowserContextImpl> = new Map();
  private _pages: Map<string, PageImpl> = new Map();
  private _closed = false;
  private _eventEmitter: EventEmitter;

  private constructor(connection: CRConnection, adapter: CDPAdapter, eventEmitter: EventEmitter) {
    this._connection = connection;
    this._adapter = adapter;
    this._eventEmitter = eventEmitter;
    this._defaultContext = new BrowserContextImpl(this, undefined);
  }

  /**
   * Connect to a Chrome instance via CDP WebSocket
   * Main entry point for CDP-direct usage
   */
  static async connect(wsEndpoint: string, options?: BrowserConnectOptions): Promise<BrowserImpl> {
    const isElectronWebview = options?.isElectronWebview ?? true; // Default true for natstack

    const transport = await BrowserWebSocketTransport.connect(wsEndpoint, options?.transportOptions);
    const rootSdk = createRootSdkObject();
    const browserLogsCollector = new RecentLogsCollector();
    const protocolLogger = () => {};

    const connection = new CRConnection(rootSdk, transport, protocolLogger, browserLogsCollector);
    const adapter = new CDPAdapter(connection.rootSession);

    // Create event emitter (platform-independent for browser)
    const platform = {
      defaultMaxListeners: () => 10,
      isUnderTest: () => false
    } as any;
    const eventEmitter = new EventEmitter(platform);

    const browser = new BrowserImpl(connection, adapter, eventEmitter);

    if (isElectronWebview) {
      // Electron webview mode: The root session IS the page.
      // Don't use Target.getTargets/attachToTarget as it may return other Electron
      // targets (like the main window) and attaching to them would hijack the app.
      await adapter.enableDomains();

      // Create a page using the root session directly
      // Use 'webview' as a synthetic targetId
      const page = new PageImpl(browser, adapter, 'webview', connection.rootSession);
      browser._pages.set('webview', page);
      browser._defaultContext._addPage(page);

      // Get browser/Chrome version (may fail on webview, that's ok)
      try {
        const versionInfo = await connection.rootSession.send('Browser.getVersion');
        browser._version = versionInfo.product || '';
      } catch {
        browser._version = 'Electron Webview';
      }
    } else {
      // Standard Chrome browser mode: enumerate and attach to targets
      // Get browser version
      const versionInfo = await connection.rootSession.send('Browser.getVersion');
      browser._version = versionInfo.product || '';

      // Get existing targets (pages)
      const { targetInfos } = await connection.rootSession.send('Target.getTargets');

      // Enable target discovery
      await connection.rootSession.send('Target.setDiscoverTargets', { discover: true });

      // Attach to existing page targets
      for (const targetInfo of targetInfos) {
        if (targetInfo.type === 'page' && targetInfo.attached !== true) {
          try {
            const page = await browser._attachToTarget(targetInfo.targetId);
            browser._defaultContext._addPage(page);
          } catch (e) {
            // Ignore errors for targets that can't be attached
          }
        }
      }

      // Listen for new targets
      connection.rootSession.on('Target.targetCreated', async (event: Protocol.Target.targetCreatedPayload) => {
        if (event.targetInfo.type === 'page') {
          try {
            const page = await browser._attachToTarget(event.targetInfo.targetId);
            browser._defaultContext._addPage(page);
          } catch (e) {
            // Ignore
          }
        }
      });

      connection.rootSession.on('Target.targetDestroyed', (event: Protocol.Target.targetDestroyedPayload) => {
        const page = browser._pages.get(event.targetId);
        if (page) {
          browser._defaultContext._removePage(page);
          browser._pages.delete(event.targetId);
        }
      });
    }

    return browser;
  }

  /**
   * Attach to a target and create a PageImpl
   */
  async _attachToTarget(targetId: string): Promise<PageImpl> {
    const { sessionId } = await this._connection.rootSession.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });

    const session = this._connection.rootSession.createChildSession(sessionId);
    const adapter = new CDPAdapter(session);

    // Enable necessary domains
    await adapter.enableDomains();

    const page = new PageImpl(this, adapter, targetId, session);
    this._pages.set(targetId, page);

    return page;
  }

  /**
   * Get browser version string
   */
  version(): string {
    return this._version;
  }

  /**
   * Get the default browser context
   */
  defaultContext(): BrowserContextImpl {
    return this._defaultContext;
  }

  /**
   * Get all browser contexts
   */
  contexts(): BrowserContextImpl[] {
    return [this._defaultContext, ...this._contexts.values()];
  }

  /**
   * Create a new browser context
   */
  async newContext(): Promise<BrowserContextImpl> {
    const { browserContextId } = await this._connection.rootSession.send('Target.createBrowserContext');
    const context = new BrowserContextImpl(this, browserContextId);
    this._contexts.set(browserContextId, context);
    return context;
  }

  /**
   * Create a new page in the default context
   */
  async newPage(): Promise<PageImpl> {
    return await this._defaultContext.newPage();
  }

  /**
   * Check if browser is connected
   */
  isConnected(): boolean {
    return !this._closed && !this._connection._closed;
  }

  /**
   * Close the browser connection
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._connection.close();
    this._eventEmitter.emit(Events.Browser.Disconnected);
  }

  /**
   * Get the CDP connection
   */
  _getConnection(): CRConnection {
    return this._connection;
  }

  /**
   * Get the CDP adapter
   */
  _getAdapter(): CDPAdapter {
    return this._adapter;
  }

  /**
   * Get the event emitter
   */
  _getEventEmitter(): EventEmitter {
    return this._eventEmitter;
  }
}
