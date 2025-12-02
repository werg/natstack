/**
 * Browser-compatible CRBrowser facade.
 * Provides a simplified API for controlling Chrome via CDP directly in browser environments.
 * This is a lightweight alternative to the full server-side CRBrowser.
 */

import { BrowserWebSocketTransport } from '../server/browserTransport';
import { CRConnection, CRSession, ConnectionEvents, kBrowserCloseMessageId } from '../server/chromium/crConnection';
import { createRootSdkObject } from '../server/instrumentation';
import { RecentLogsCollector } from '../server/utils/debugLogger';

import type { BrowserWebSocketTransportOptions } from '../server/browserTransport';
import type { Protocol } from '../server/chromium/protocol';

export interface CRBrowserConnectOptions {
  transportOptions?: BrowserWebSocketTransportOptions;
}

export interface CRPageInfo {
  targetId: string;
  url: string;
  title: string;
  type: string;
}

/**
 * A lightweight browser page wrapper for CDP.
 */
export class CRPage {
  private _session: CRSession;
  private _targetId: string;
  private _browser: CRBrowser;
  private _url: string = '';
  private _title: string = '';

  constructor(browser: CRBrowser, session: CRSession, targetId: string) {
    this._browser = browser;
    this._session = session;
    this._targetId = targetId;

    // Listen for page events
    this._session.on('Page.frameNavigated', (event: Protocol.Page.frameNavigatedPayload) => {
      if (!event.frame.parentId) {
        this._url = event.frame.url;
      }
    });

    this._session.on('Page.domContentEventFired', () => {
      // Page loaded
    });
  }

  get targetId(): string {
    return this._targetId;
  }

  url(): string {
    return this._url;
  }

  async title(): Promise<string> {
    const result = await this._session.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    return result.result.value || '';
  }

  async goto(url: string, options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'; timeout?: number }): Promise<void> {
    const waitUntil = options?.waitUntil || 'load';
    const timeout = options?.timeout ?? 30000;

    // Enable page events if not already enabled
    await this._session.send('Page.enable');

    // Create a promise that waits for the appropriate event
    const eventName = waitUntil === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired';

    const waitPromise = new Promise<void>((resolve, reject) => {
      let resolved = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        this._session.removeListener(eventName, successHandler);
        this._session.removeListener('Page.frameNavigated', frameHandler);
      };

      const successHandler = () => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve();
      };

      // Also listen for frame navigation to update URL
      const frameHandler = (event: Protocol.Page.frameNavigatedPayload) => {
        if (!event.frame.parentId) {
          this._url = event.frame.url;
        }
      };

      this._session.on(eventName, successHandler);
      this._session.on('Page.frameNavigated', frameHandler);

      // Timeout
      timeoutId = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(new Error(`Navigation timeout of ${timeout}ms exceeded`));
      }, timeout);
    });

    // Navigate
    const result = await this._session.send('Page.navigate', { url });

    // Check for immediate navigation errors
    if (result.errorText) {
      throw new Error(`Navigation failed: ${result.errorText}`);
    }

    this._url = url;

    // Wait for the event
    await waitPromise;
  }

  async evaluate<T>(pageFunction: string | ((...args: any[]) => T), ...args: any[]): Promise<T> {
    let expression: string;

    if (typeof pageFunction === 'function') {
      // Convert function to string and call it with serialized args
      const argsJson = JSON.stringify(args);
      expression = `(${pageFunction.toString()}).apply(null, ${argsJson})`;
    } else {
      expression = pageFunction;
    }

    const result = await this._session.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Evaluation failed');
    }

    return result.result.value;
  }

  async screenshot(options?: { format?: 'png' | 'jpeg'; quality?: number; timeout?: number }): Promise<Uint8Array> {
    const format = options?.format || 'png';
    const result = await this._session.send('Page.captureScreenshot', {
      format,
      quality: options?.quality,
    });

    if (!result.data) {
      throw new Error('Screenshot failed: no data returned');
    }

    // Decode base64 to Uint8Array
    try {
      const binaryString = atob(result.data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes;
    } catch (e) {
      throw new Error(`Screenshot failed: invalid base64 data - ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async close(): Promise<void> {
    await this._browser._connection.rootSession.send('Target.closeTarget', { targetId: this._targetId });
  }

  session(): CRSession {
    return this._session;
  }
}

/**
 * A lightweight browser context wrapper for CDP.
 */
export class CRBrowserContext {
  private _browser: CRBrowser;
  private _contextId?: string;
  private _pages: CRPage[] = [];

  constructor(browser: CRBrowser, contextId?: string) {
    this._browser = browser;
    this._contextId = contextId;
  }

  pages(): CRPage[] {
    return [...this._pages];
  }

  _addPage(page: CRPage): void {
    this._pages.push(page);
  }

  _removePage(page: CRPage): void {
    const index = this._pages.indexOf(page);
    if (index !== -1) {
      this._pages.splice(index, 1);
    }
  }

  async newPage(): Promise<CRPage> {
    const result = await this._browser._connection.rootSession.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId: this._contextId,
    });

    const page = await this._browser._attachToTarget(result.targetId);
    this._addPage(page);
    return page;
  }

  async close(): Promise<void> {
    if (this._contextId) {
      await this._browser._connection.rootSession.send('Target.disposeBrowserContext', {
        browserContextId: this._contextId,
      });
    }
  }
}

/**
 * Browser-compatible CRBrowser for direct CDP control.
 * Use CRBrowser.connect(wsEndpoint) to connect to a Chrome instance.
 */
export class CRBrowser {
  _connection: CRConnection;
  private _version: string = '';
  private _defaultContext: CRBrowserContext;
  private _contexts: Map<string, CRBrowserContext> = new Map();
  private _pages: Map<string, CRPage> = new Map();
  private _closed = false;

  private constructor(connection: CRConnection) {
    this._connection = connection;
    this._defaultContext = new CRBrowserContext(this);
  }

  /**
   * Connect to a Chrome instance via CDP WebSocket.
   */
  static async connect(wsEndpoint: string, options?: CRBrowserConnectOptions): Promise<CRBrowser> {
    const transport = await BrowserWebSocketTransport.connect(wsEndpoint, options?.transportOptions);
    const rootSdk = createRootSdkObject();
    const browserLogsCollector = new RecentLogsCollector();
    const protocolLogger = () => {};

    const connection = new CRConnection(rootSdk, transport, protocolLogger, browserLogsCollector);
    const browser = new CRBrowser(connection);

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

    return browser;
  }

  async _attachToTarget(targetId: string): Promise<CRPage> {
    const { sessionId } = await this._connection.rootSession.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });

    const session = this._connection.rootSession.createChildSession(sessionId);

    // Enable necessary domains
    await session.send('Page.enable');
    await session.send('Runtime.enable');

    const page = new CRPage(this, session, targetId);
    this._pages.set(targetId, page);

    return page;
  }

  version(): string {
    return this._version;
  }

  defaultContext(): CRBrowserContext {
    return this._defaultContext;
  }

  contexts(): CRBrowserContext[] {
    return [this._defaultContext, ...this._contexts.values()];
  }

  async newContext(): Promise<CRBrowserContext> {
    const { browserContextId } = await this._connection.rootSession.send('Target.createBrowserContext');
    const context = new CRBrowserContext(this, browserContextId);
    this._contexts.set(browserContextId, context);
    return context;
  }

  isConnected(): boolean {
    return !this._closed && !this._connection._closed;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._connection.close();
  }
}
