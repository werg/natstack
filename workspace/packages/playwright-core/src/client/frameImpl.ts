/**
 * FrameImpl - CDP-direct Frame implementation
 * Provides Playwright Frame API using FrameAdapter
 */

import { CDPAdapter } from './cdpAdapter';
import { FrameAdapter, WaitForSelectorOptions } from './frameAdapter';

import type { PageImpl } from './pageImpl';

/**
 * CDP-direct Frame implementation
 * Wraps FrameAdapter and provides Playwright-compatible API
 */
export class FrameImpl {
  private _page: PageImpl;
  private _adapter: FrameAdapter;
  private _cdpAdapter: CDPAdapter;

  constructor(page: PageImpl, cdpAdapter: CDPAdapter) {
    this._page = page;
    this._cdpAdapter = cdpAdapter;
    this._adapter = new FrameAdapter(cdpAdapter.getSession());
  }

  /**
   * Wait for selector with auto-waiting
   */
  async waitForSelector(selector: string, options?: WaitForSelectorOptions): Promise<boolean> {
    return this._adapter.waitForSelector(selector, options);
  }

  /**
   * Query selector (no waiting)
   */
  async querySelector(selector: string): Promise<boolean> {
    return this._adapter.querySelector(selector);
  }

  /**
   * Click an element
   */
  async click(selector: string, options?: any): Promise<void> {
    // Wait for element to be visible
    await this._adapter.waitForSelector(selector, { state: 'visible' });

    // Evaluate click via CDP
    await this._cdpAdapter.evaluate({
      expression: `
        (() => {
          const element = document.querySelector('${selector}');
          if (element) element.click();
        })()
      `,
      returnByValue: true,
    });
  }

  /**
   * Fill an input element
   */
  async fill(selector: string, value: string, options?: any): Promise<void> {
    // Wait for element to be visible
    await this._adapter.waitForSelector(selector, { state: 'visible' });

    // Evaluate fill via CDP
    await this._cdpAdapter.evaluate({
      expression: `
        (() => {
          const element = document.querySelector('${selector}');
          if (element) {
            element.value = '${value.replace(/'/g, "\\'")}';
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()
      `,
      returnByValue: true,
    });
  }

  /**
   * Type text into an element
   */
  async type(selector: string, text: string, options?: any): Promise<void> {
    // Wait for element to be visible
    await this._adapter.waitForSelector(selector, { state: 'visible' });

    // For now, use fill (proper typing would require Input.dispatchKeyEvent)
    await this.fill(selector, text, options);
  }

  /**
   * Evaluate JavaScript in frame context
   */
  async evaluate<T>(pageFunction: string | ((...args: any[]) => T), ...args: any[]): Promise<T> {
    let expression: string;

    if (typeof pageFunction === 'function') {
      const argsJson = JSON.stringify(args);
      expression = `(${pageFunction.toString()}).apply(null, ${argsJson})`;
    } else {
      expression = pageFunction;
    }

    return this._cdpAdapter.evaluate<T>({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
  }

  /**
   * Get frame URL
   */
  url(): string {
    return this._page.url();
  }

  /**
   * Get the page that owns this frame
   */
  page(): PageImpl {
    return this._page;
  }

  /**
   * Set default timeout
   */
  setDefaultTimeout(timeout: number): void {
    this._adapter.setDefaultTimeout(timeout);
  }
}
