/**
 * PageImpl - CDP-direct Page implementation
 * Provides Playwright Page API using direct CDP calls
 */

import { CDPAdapter } from './cdpAdapter';
import { FrameAdapter } from './frameAdapter';
import { FrameImpl } from './frameImpl';
import { EventEmitter } from './eventEmitter';
import { TimeoutError } from './errors';

import type { BrowserImpl } from './browserImpl';
import type { CRSession } from '../server/chromium/crConnection';
import type { Protocol } from '../server/chromium/protocol';

export interface GotoOptions {
  timeout?: number;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
}

export interface ScreenshotOptions {
  format?: 'png' | 'jpeg';
  quality?: number;
  fullPage?: boolean;
  timeout?: number;
}

/**
 * CDP-direct Page implementation
 */
export class PageImpl {
  private _browser: BrowserImpl;
  private _adapter: CDPAdapter;
  private _session: CRSession;
  private _targetId: string;
  private _url: string = '';
  private _mainFrame: FrameImpl;
  private _eventEmitter: EventEmitter;
  private _defaultTimeout: number = 30000;

  constructor(browser: BrowserImpl, adapter: CDPAdapter, targetId: string, session: CRSession) {
    this._browser = browser;
    this._adapter = adapter;
    this._session = session;
    this._targetId = targetId;

    // Create platform-independent event emitter
    const platform = {
      defaultMaxListeners: () => 10,
      isUnderTest: () => false
    } as any;
    this._eventEmitter = new EventEmitter(platform);

    // Create main frame
    this._mainFrame = new FrameImpl(this, adapter);

    // Listen for navigation events
    this._session.on('Page.frameNavigated', (event: Protocol.Page.frameNavigatedPayload) => {
      if (!event.frame.parentId) {
        this._url = event.frame.url;
      }
    });
  }

  /**
   * Get the current page URL
   */
  url(): string {
    return this._url;
  }

  /**
   * Get the main frame
   */
  mainFrame(): FrameImpl {
    return this._mainFrame;
  }

  /**
   * Navigate to a URL
   */
  async goto(url: string, options?: GotoOptions): Promise<void> {
    const { waitUntil = 'load', timeout = this._defaultTimeout } = options ?? {};

    // Create navigation promise
    const navigationPromise = this._waitForNavigation(waitUntil, timeout);

    // Trigger navigation
    const result = await this._session.send('Page.navigate', { url });

    // Check for immediate navigation errors
    if (result.errorText) {
      throw new Error(`Navigation failed: ${result.errorText}`);
    }

    this._url = url;

    // Wait for navigation to complete
    await navigationPromise;
  }

  /**
   * Wait for navigation to complete
   */
  private _waitForNavigation(
    waitUntil: 'load' | 'domcontentloaded' | 'networkidle',
    timeout: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      let eventName: string;

      switch (waitUntil) {
        case 'domcontentloaded':
          eventName = 'Page.domContentEventFired';
          break;
        case 'load':
          eventName = 'Page.loadEventFired';
          break;
        case 'networkidle':
          // Simplified: treat as 'load' for now
          eventName = 'Page.loadEventFired';
          break;
        default:
          eventName = 'Page.loadEventFired';
      }

      const listener = () => {
        this._session.removeListener(eventName, listener);
        clearTimeout(timeoutId);
        resolve();
      };

      this._session.on(eventName, listener);

      const timeoutId = setTimeout(() => {
        this._session.removeListener(eventName, listener);
        reject(new TimeoutError(`Navigation timeout of ${timeout}ms exceeded`));
      }, timeout);
    });
  }

  /**
   * Evaluate JavaScript in the page context
   */
  async evaluate<T>(pageFunction: string | ((...args: any[]) => T), ...args: any[]): Promise<T> {
    let expression: string;

    if (typeof pageFunction === 'function') {
      // Convert function to string and call it with serialized args
      const argsJson = JSON.stringify(args);
      expression = `(${pageFunction.toString()}).apply(null, ${argsJson})`;
    } else {
      expression = pageFunction;
    }

    return this._adapter.evaluate<T>({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
  }

  /**
   * Take a screenshot of the page
   */
  async screenshot(options?: ScreenshotOptions): Promise<Uint8Array> {
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

  /**
   * Get the page title
   */
  async title(): Promise<string> {
    const result = await this._adapter.evaluate<string>({
      expression: 'document.title',
      returnByValue: true,
    });
    return result || '';
  }

  /**
   * Get the page content (HTML)
   */
  async content(): Promise<string> {
    const result = await this._adapter.evaluate<string>({
      expression: `
        (() => {
          let retVal = '';
          if (document.doctype)
            retVal = new XMLSerializer().serializeToString(document.doctype);
          if (document.documentElement)
            retVal += document.documentElement.outerHTML;
          return retVal;
        })()
      `,
      returnByValue: true,
    });
    return result || '';
  }

  /**
   * Close the page
   */
  async close(): Promise<void> {
    await this._browser._getConnection().rootSession.send('Target.closeTarget', {
      targetId: this._targetId,
    });
  }

  /**
   * Get the CDP session
   */
  _getSession(): CRSession {
    return this._session;
  }

  /**
   * Get the CDP adapter
   */
  _getAdapter(): CDPAdapter {
    return this._adapter;
  }

  /**
   * Get the target ID
   */
  _getTargetId(): string {
    return this._targetId;
  }

  /**
   * Set default timeout for operations
   */
  setDefaultTimeout(timeout: number): void {
    this._defaultTimeout = timeout;
  }

  /**
   * Set default navigation timeout
   */
  setDefaultNavigationTimeout(timeout: number): void {
    this._defaultTimeout = timeout;
  }

  // Delegate selector methods to main frame
  async waitForSelector(selector: string, options?: any): Promise<any> {
    return this._mainFrame.waitForSelector(selector, options);
  }

  async querySelector(selector: string): Promise<any> {
    return this._mainFrame.querySelector(selector);
  }

  async click(selector: string, options?: any): Promise<void> {
    return this._mainFrame.click(selector, options);
  }

  async fill(selector: string, value: string, options?: any): Promise<void> {
    return this._mainFrame.fill(selector, value, options);
  }

  async type(selector: string, text: string, options?: any): Promise<void> {
    return this._mainFrame.type(selector, text, options);
  }
}
